import { ASTVisitor } from "graphql";
import {
  CacheResolverMap,
  EntityCacheResult,
  EntityTreeNode,
  EntityTreeNodeSelection,
  EntityTreeNodeSelections,
  PathPart,
  isListPathPart,
} from "./typings";
import { CoordinateRoot } from "./constants";
import {
  DocumentCoordinates,
  visitWithDocumentCoordinates,
} from "./DocumentCoordinates";
import { memoize1 } from "./borrowedTools/memoize";

function flagBranchDirty(node: EntityTreeNode): void {
  node.isDirty = true;

  if (!node.selections) {
    return;
  }

  for (const key of Object.keys(node.selections)) {
    const selection = node.selections[key];
    flagBranchDirty(selection.node);
  }
}

/**
 * TODO(max): Have to rewrite the entire buildEntityTreeNode function to start from nothing,
 * ie presuppose no Coordinate root. The path will always include this root now.
 */
export function buildEntityTreeNode(
  parentNode: EntityTreeNode,
  ecr: EntityCacheResult,
  resolvers: CacheResolverMap,
  path: readonly PathPart[] = ecr.path,
  flagDirty = false,
): EntityTreeNode {
  const [key, ...rest] = path;

  const selections = parentNode.selections ?? {};

  const parentCoords =
    parentNode.coordinates !== "__root" ? `${parentNode.coordinates}.` : "";

  const coordinates = `${parentCoords}${key.field}`;

  const list = isListPathPart(key);

  const selection = selections[key.field] ?? {
    node: {
      coordinates,
      entities: [],
      isDirty: false,
      isInvalidated: false,
      isList: isListPathPart(key),
      isRequired: false,
    },
  };

  let nextNode = selection.node;

  if (nextNode.resolver !== undefined) {
    flagDirty = false;
  }

  // Mark this branch path as dirty. When the node hasn't been invalidated yet,
  // that is covered by flagBranchDirty() below.
  if (nextNode.isInvalidated) {
    flagDirty = true;
  }

  if (flagDirty) {
    nextNode.isDirty = true;
  }

  if (rest.length > 0) {
    nextNode = buildEntityTreeNode(nextNode, ecr, resolvers, rest, flagDirty);
  } else {
    nextNode.requiredTypename = ecr.entity.typename;

    nextNode.resolver = resolvers[ecr.entity.typename];

    if (ecr.invalidated) {
      nextNode.isInvalidated = true;
      nextNode.isRequired = true;

      // Make sure that any branch paths that passed through
      // this node are retroactively made dirty.
      flagBranchDirty(nextNode);
    }
  }

  if (nextNode.isRequired) {
    if (nextNode.resolver === undefined) {
      parentNode.isRequired = true;
    }

    const requiredIds = selection.requiredIds ?? new Set();

    /**
     * Ugly AF
     * How do we clean this up?
     */
    if (rest.length === 0) {
      if (
        ecr.invalidated &&
        ecr.entity.id !== undefined &&
        !requiredIds.has(ecr.entity.id)
      ) {
        requiredIds.add(ecr.entity.id);
      }
    } else if (list && key.id !== undefined && !requiredIds.has(key.id)) {
      requiredIds.add(key.id);
    }

    selection.requiredIds = requiredIds;
  }

  selection.node = nextNode;

  selections[key.field] = selection;

  parentNode.selections = selections;

  return parentNode;
}

export function spawnTreeRoot(): EntityTreeNode {
  return {
    coordinates: "__root",
    isDirty: false,
    isInvalidated: false,
    isList: false,
    isRequired: false,
    selections: {
      [CoordinateRoot.query]: {
        node: {
          coordinates: CoordinateRoot.query,
          isDirty: false,
          isInvalidated: false,
          isList: false,
          isRequired: false,
        },
      },
    },
  };
}

function getSelectionIndices(
  selections: EntityTreeNodeSelections,
): Record<string, EntityTreeNodeSelection> {
  return Object.keys(selections).reduce((indices, key) => {
    const selection = selections[key];
    const nextNode = selection.node;
    let res = {
      ...indices,
      [nextNode.coordinates]: selection,
    };

    if (nextNode.selections) {
      res = {
        ...res,
        ...getSelectionIndices(nextNode.selections),
      };
    }

    return res;
  }, {});
}

class Invalidator {
  coordinates: DocumentCoordinates;

  tree: EntityTreeNode;

  selections: Record<string, EntityTreeNodeSelection>;

  constructor(tree: EntityTreeNode, documentCoordinates: DocumentCoordinates) {
    this.tree = tree;
    this.selections = getSelectionIndices({
      [CoordinateRoot.query]: {
        node: this.tree,
      },
    });
    this.coordinates = documentCoordinates;
  }

  getCoordinates() {
    return this.coordinates.getCoordinates();
  }

  getCurrentNode(coords = this.getCoordinates()) {
    // eslint-disable-next-line no-useless-catch
    return this.getCurrentSelection(coords)?.node;
  }

  getCurrentSelection(
    coords = this.getCoordinates(),
  ): EntityTreeNodeSelection | undefined {
    // eslint-disable-next-line no-useless-catch
    return this.selections[coords];
  }

  getRequiredIds(coords = this.getCoordinates()) {
    return this.getCurrentSelection(coords)?.requiredIds;
  }

  getSelectionsToKeep(coords = this.getCoordinates()) {
    const node = this.getCurrentNode(coords);
    if (!node) {
      return null;
    }
    return getSelectionsToKeep(node);
  }
}

export function visitWithEntityTree(
  entityTree: EntityTreeNode,
  visitor: (invalidator: Invalidator) => ASTVisitor,
): ASTVisitor {
  const coordinates = new DocumentCoordinates();
  const invalidator = new Invalidator(entityTree, coordinates);

  return visitWithDocumentCoordinates(coordinates, visitor(invalidator));
}

const getSelectionsToKeep = memoize1(function getSelectionsToKeep(
  node: EntityTreeNode,
): readonly string[] | null {
  /*
   * Any node that is dirty - ie, either invalidated or downstream from an invalidated
   * node within the same resolver - should always have their selections included in full.
   */
  if (node.isDirty) {
    return null;
  }

  if (node.isRequired) {
    /*
     * Traversed list nodes need to always be included in full, as they are
     * considered state-volatile.
     */
    if (node.isList) {
      return null;
    }

    if (node.requiredTypename === undefined) {
      /*
       * Traversed object nodes that are not known entities need to be included in full,
       * because they could have been changed/invalidated without us knowing
       */
      return null;
    }

    /*
     * Traversed entity object nodes should include all paths leading toward an
     * invalidated entity. If they had been changed, they would have been invalidated,
     * so partially merging in the path is safe.
     */
    return Object.keys(node.selections ?? {});
  }

  /*
   * Non-required resolver nodes need to maintain their selection set in order to
   * inject it into a link if needed
   */
  if (node.resolver) {
    return null;
  }

  return [];
});
