import {
  CacheMergeError,
  EntitySnapshots,
  getEntityIdentity,
  isLinkStub,
} from "./merge.js";
import { CacheResolverMap, LinkGroup, ObjMap } from "./typings.js";
import {
  DocumentNode,
  FieldNode,
  Kind,
  OperationTypeNode,
  SelectionSetNode,
  VariableDefinitionNode,
} from "graphql";
import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  CoordinateRoot,
} from "./constants.js";
import {
  ResolutionAliases,
  mapCacheResolutions,
} from "./getCacheResolutionMapper.js";
import { isArray, isObject, pruneUnusedVariables } from "./utils.js";
import { isCacheAliasName, parseCacheResolverAlias } from "./alias.js";
import { selectionSetForType } from "./getPartialRecacheQuery.js";

export { convertFieldNodeToLink } from "./getPartialRecacheQuery.js";

/**
 * Creates a function that finds the link stubs in an execution result that
 * point to entities we have no data for at that position. Each entity is only
 * ever returned once per collector.
 */
export function makeLinkCollector(snapshots: EntitySnapshots) {
  const requested = new Set<string>();

  return function collectLinks(
    data: ObjMap<unknown> | null | undefined,
  ): LinkGroup[] {
    const groups = new Map<string, LinkGroup>();

    function walk(value: unknown, coordinates: string) {
      if (isArray(value)) {
        for (const item of value) {
          walk(item, coordinates);
        }
        return;
      }

      if (!isObject(value)) {
        return;
      }

      if (isLinkStub(value)) {
        const identity = getEntityIdentity(value)!;
        const key = `${coordinates}\u0000${identity}`;

        if (snapshots.has(coordinates, identity) || requested.has(key)) {
          return;
        }

        requested.add(key);

        const typename = value[ALIAS_ENTITYCACHE_TYPENAME] as string;
        const id = String(value[ALIAS_ENTITYCACHE_ID]);
        const groupKey = `${coordinates}\u0000${typename}`;

        let group = groups.get(groupKey);
        if (!group) {
          group = { coordinates, ids: [], typename };
          groups.set(groupKey, group);
        }
        group.ids.push(id);
        return;
      }

      for (const key of Object.keys(value)) {
        walk(value[key], `${coordinates}.${key}`);
      }
    }

    for (const key of Object.keys(data ?? {})) {
      const coordinates = isCacheAliasName(key)
        ? parseCacheResolverAlias(key)
        : `${CoordinateRoot.query}.${key}`;
      walk(data![key], coordinates);
    }

    return Array.from(groups.values());
  };
}

export interface BuildLinkQueryParameter {
  linkSelections: Record<string, SelectionSetNode>;
  links: readonly LinkGroup[];
  originalOperationName?: string;
  resolvers: CacheResolverMap;
  variableDefinitions?: readonly VariableDefinitionNode[];
}

/**
 * Builds a query fetching every linked entity through its cache resolver,
 * using the selection set found at the link's coordinates in the original
 * document.
 */
export function buildLinkQuery({
  links,
  linkSelections,
  resolvers,
  originalOperationName,
  variableDefinitions = [],
}: BuildLinkQueryParameter): {
  document: DocumentNode;
  operationName: string;
} | null {
  const aliases = new ResolutionAliases();
  const cacheResolutions: FieldNode[] = [];
  const resolverTypenames = Object.keys(resolvers);

  for (const link of links) {
    const resolver = resolvers[link.typename];

    if (!resolver) {
      throw new CacheMergeError(
        `No cache resolver for linked entity type ${link.typename} at ${link.coordinates}`,
      );
    }

    const selectionSet = linkSelections[link.coordinates];

    if (!selectionSet) {
      throw new CacheMergeError(
        `Selection set not found for link with coordinates ${link.coordinates}`,
      );
    }

    cacheResolutions.push(
      ...mapCacheResolutions(
        resolver,
        link.ids,
        link.coordinates,
        selectionSetForType(selectionSet, link.typename, resolverTypenames),
        aliases,
      ),
    );
  }

  if (cacheResolutions.length === 0) {
    return null;
  }

  const operationName = `${
    originalOperationName ? `${originalOperationName}_` : ""
  }_linkQuery`;

  const operation = pruneUnusedVariables({
    kind: Kind.OPERATION_DEFINITION,
    name: { kind: Kind.NAME, value: operationName },
    operation: OperationTypeNode.QUERY,
    selectionSet: { kind: Kind.SELECTION_SET, selections: cacheResolutions },
    variableDefinitions,
  });

  return {
    document: { definitions: [operation], kind: Kind.DOCUMENT },
    operationName,
  };
}
