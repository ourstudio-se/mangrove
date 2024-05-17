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
  if (node.isDirty) {
    return;
  }

  if (node.resolvers !== undefined && !node.isInvalidated) {
    return;
  }

  node.isDirty = true;

  if (!node.selections) {
    return;
  }

  for (const key of Object.keys(node.selections)) {
    const selection = node.selections[key];
    flagBranchDirty(selection.node);
  }
}

export function buildEntityTreeNode(
  parentNode: EntityTreeNode,
  ecr: EntityCacheResult,
  resolvers: CacheResolverMap,
  path: PathPart[] = [...ecr.path],
  flagDirty = false,
): EntityTreeNode {
  const key = path.shift();

  if (!key) {
    throw new Error("Path is empty");
  }

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

  if (path.length > 0) {
    nextNode = buildEntityTreeNode(nextNode, ecr, resolvers, path, flagDirty);
  } else {
    nextNode.isEntity = true;

    const resolver = resolvers[ecr.entity.typename];

    if (resolver !== undefined) {
      nextNode.resolvers ??= {};
      nextNode.resolvers[ecr.entity.typename] = resolver;
    }

    if (ecr.invalidated) {
      nextNode.isInvalidated = true;
      nextNode.isRequired = true;

      // Make sure that any branch paths that passed through
      // this node are retroactively made dirty.
      flagBranchDirty(nextNode);
    }
  }

  if (nextNode.isRequired) {
    if (nextNode.resolvers === undefined) {
      parentNode.isRequired = true;
    }

    let requiredEntities = selection.requiredEntities;

    if (!requiredEntities) {
      requiredEntities = {};
      selection.requiredEntities = requiredEntities;
    }

    let requiredIds = requiredEntities[ecr.entity.typename];

    if (!requiredIds) {
      requiredIds = new Set();
      requiredEntities[ecr.entity.typename] = requiredIds;
    }

    /**
     * Ugly AF
     * How do we clean this up?
     */
    if (path.length === 0) {
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

function getSelectionIndices(selections: EntityTreeNodeSelections) {
  return Object.keys(selections).reduce<
    Record<string, EntityTreeNodeSelection>
  >((indices, key) => {
    const selection = selections[key];
    const nextNode = selection.node;

    indices[nextNode.coordinates] = selection;

    if (nextNode.selections) {
      const selIndices = getSelectionIndices(nextNode.selections);

      indices = {
        ...indices,
        ...selIndices,
      };
    }

    return indices;
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
    return this.getCurrentSelection(coords)?.node;
  }

  getCurrentSelection(
    coords = this.getCoordinates(),
  ): EntityTreeNodeSelection | undefined {
    return this.selections[coords];
  }

  getRequiredEntities(coords = this.getCoordinates()) {
    return this.getCurrentSelection(coords)?.requiredEntities;
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

    if (!node.isEntity) {
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
  if (node.resolvers !== undefined) {
    return null;
  }

  return [];
});
