import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  CoordinateRoot,
} from "./constants.js";
import { ASTVisitor } from "graphql";
import {
  CacheResolverMap,
  EntityCacheResult,
  EntityTreeNode,
} from "./typings.js";
import {
  DocumentCoordinates,
  visitWithDocumentCoordinates,
} from "./DocumentCoordinates.js";

function createNode(coordinates: string): EntityTreeNode {
  return {
    children: new Map(),
    coordinates,
    isDirty: false,
    isEntity: false,
    isInvalidated: false,
    isList: false,
    isRequired: false,
    linkable: false,
    requiredEntities: new Map(),
    resolvers: {},
    typenames: new Set(),
  };
}

export interface EntityTree {
  /** Every node, by coordinates. */
  nodes: Map<string, EntityTreeNode>;
  /** Every type that has a cache resolver. */
  resolverTypenames: ReadonlySet<string>;
  root: EntityTreeNode;
}

/**
 * Builds the entity tree for a cached operation.
 *
 * The tree is built in two passes so that the outcome doesn't depend on the
 * order of the entities: first every entity is placed, then invalidation
 * state is propagated (`finalizeEntityTree`).
 */
export function buildEntityTree(
  entities: Iterable<EntityCacheResult>,
  resolvers: CacheResolverMap,
): EntityTree {
  const root = createNode(CoordinateRoot.query);
  const nodes = new Map<string, EntityTreeNode>([[root.coordinates, root]]);
  const invalidatedPaths: EntityTreeNode[][] = [];
  const invalidatedEntities: EntityCacheResult[] = [];

  for (const ecr of entities) {
    const [first, ...rest] = ecr.path;

    if (!first || first.field !== CoordinateRoot.query) {
      throw new Error(
        `Entity paths must start at ${CoordinateRoot.query}, got ${first?.field}`,
      );
    }

    let node = root;
    const nodePath = [root];

    for (const part of rest) {
      let child = node.children.get(part.field);
      if (!child) {
        child = createNode(`${node.coordinates}.${part.field}`);
        node.children.set(part.field, child);
        nodes.set(child.coordinates, child);
      }
      if (part.index !== undefined) {
        child.isList = true;
      }
      node = child;
      nodePath.push(node);
    }

    node.isEntity = true;
    node.typenames.add(ecr.entity.typename);

    if (ecr.invalidated) {
      node.isInvalidated = true;
      invalidatedPaths.push(nodePath);
      invalidatedEntities.push(ecr);
    }
  }

  finalizeEntityTree(root, resolvers, invalidatedPaths, invalidatedEntities);

  return { nodes, resolverTypenames: new Set(Object.keys(resolvers)), root };
}

function resetComputedState(node: EntityTreeNode) {
  node.isDirty = false;
  node.isRequired = false;
  node.requiredEntities = new Map();
  for (const child of node.children.values()) {
    resetComputedState(child);
  }
}

function computeLinkability(node: EntityTreeNode, resolvers: CacheResolverMap) {
  node.resolvers = {};
  node.linkable = false;

  if (node.isEntity && node.typenames.size > 0) {
    let all = true;
    for (const typename of node.typenames) {
      const resolver = resolvers[typename];
      if (resolver === undefined) {
        all = false;
        break;
      }
      node.resolvers[typename] = resolver;
    }
    node.linkable = all;
    if (!all) {
      node.resolvers = {};
    }
  }

  for (const child of node.children.values()) {
    computeLinkability(child, resolvers);
  }
}

function addRequiredEntity(node: EntityTreeNode, typename: string, id: string) {
  let ids = node.requiredEntities.get(typename);
  if (!ids) {
    ids = new Set();
    node.requiredEntities.set(typename, ids);
  }
  ids.add(id);
}

/**
 * Marks the nodes leading to each invalidated entity as required, and decides
 * at which node the invalidated data is re-resolved:
 *
 * - at the invalidated entity itself, if it can be reached through a cache
 *   resolver,
 * - otherwise at the closest ancestor entity that can, re-resolving that
 *   ancestor (by its own id) with a selection narrowed down to the path,
 * - otherwise from the root of the operation.
 *
 * Returns false if a linkable node turned out to be unusable, in which case
 * it has been made unlinkable and the pass must be repeated.
 */
function computeRequired(
  invalidatedPaths: EntityTreeNode[][],
  invalidatedEntities: EntityCacheResult[],
): boolean {
  for (let p = 0; p < invalidatedPaths.length; p++) {
    const nodePath = invalidatedPaths[p];
    const ecr = invalidatedEntities[p];

    for (let i = nodePath.length - 1; i >= 0; i--) {
      const node = nodePath[i];
      node.isRequired = true;

      if (!node.linkable) {
        continue;
      }

      const part = ecr.path[i];
      const isLeaf = i === nodePath.length - 1;
      const typename = isLeaf ? ecr.entity.typename : part.typename;
      const id = isLeaf
        ? ecr.entity.id === undefined
          ? undefined
          : String(ecr.entity.id)
        : part.id;

      if (
        typename === undefined ||
        id === undefined ||
        node.resolvers[typename] === undefined
      ) {
        // We know we need to pass through this node but can't tell which
        // entity to resolve; reach it from its parent instead.
        node.linkable = false;
        node.resolvers = {};
        return false;
      }

      addRequiredEntity(node, typename, id);
      break;
    }
  }

  return true;
}

function computeDirty(node: EntityTreeNode, parentDirty: boolean) {
  node.isDirty = node.isInvalidated || (parentDirty && !node.linkable);

  for (const child of node.children.values()) {
    computeDirty(child, node.isDirty);
  }
}

function finalizeEntityTree(
  root: EntityTreeNode,
  resolvers: CacheResolverMap,
  invalidatedPaths: EntityTreeNode[][],
  invalidatedEntities: EntityCacheResult[],
) {
  computeLinkability(root, resolvers);

  // Each failed round removes one linkable node, so this terminates.
  do {
    resetComputedState(root);
  } while (!computeRequired(invalidatedPaths, invalidatedEntities));

  computeDirty(root, false);
}

/**
 * Which response keys of the selection set at `node` to keep, or null to keep
 * the selection set in full.
 */
export function getSelectionsToKeep(
  node: EntityTreeNode | undefined,
): readonly string[] | null {
  /*
   * Positions without entities are kept as far as their parent keeps them.
   */
  if (!node) {
    return null;
  }

  /*
   * Invalidated nodes, and nodes below them in the same segment, are fetched
   * in full.
   */
  if (node.isDirty) {
    return null;
  }

  if (node.isRequired) {
    /*
     * Traversed lists are always fetched in full, as their membership is
     * state-volatile.
     */
    if (node.isList) {
      return null;
    }

    /*
     * Traversed objects that are not entities have no way of being
     * invalidated themselves, so they are fetched in full.
     */
    if (!node.isEntity) {
      return null;
    }

    /*
     * Traversed entities only include the paths leading towards an
     * invalidated entity; if anything else had changed, they would have been
     * invalidated themselves. Their identity is kept so the merge can verify
     * it is still the same entity.
     */
    const keep = [ALIAS_ENTITYCACHE_ID, ALIAS_ENTITYCACHE_TYPENAME];
    for (const [field, child] of node.children) {
      if (child.isRequired || child.isDirty) {
        keep.push(field);
      }
    }
    return keep;
  }

  /*
   * Linkable nodes keep their selections so they can be turned into links
   * (whose selection sets are used for follow-up link queries).
   */
  if (node.linkable) {
    return null;
  }

  return [];
}

export class Invalidator {
  constructor(
    private readonly tree: EntityTree,
    private readonly coordinates: DocumentCoordinates,
  ) {}

  getCoordinates() {
    return this.coordinates.getCoordinates();
  }

  getCurrentNode(coords = this.getCoordinates()) {
    return this.tree.nodes.get(coords);
  }

  getSelectionsToKeep(coords = this.getCoordinates()) {
    return getSelectionsToKeep(this.getCurrentNode(coords));
  }
}

export function visitWithEntityTree(
  entityTree: EntityTree,
  visitor: (invalidator: Invalidator) => ASTVisitor,
): ASTVisitor {
  const coordinates = new DocumentCoordinates();
  const invalidator = new Invalidator(entityTree, coordinates);

  return visitWithDocumentCoordinates(coordinates, visitor(invalidator));
}
