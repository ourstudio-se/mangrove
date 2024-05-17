import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  CoordinateRoot,
} from "./constants";
import {
  CacheResolvedEntity,
  CacheResolverMap,
  KnownEntitiesMap,
  ObjMap,
  TypeLinkWithCoordinates,
  isCacheResolvedEntity,
  isCacheResolvedEntityList,
} from "./typings";
import {
  DocumentNode,
  FieldNode,
  GraphQLError,
  Kind,
  OperationTypeNode,
  SelectionNode,
  SelectionSetNode,
} from "graphql";
import { getCacheResolutionMapper } from "./getCacheResolutionMapper";
import {
  indexWiseDeepMerge,
  isArray,
  isCacheAliasName,
  isId,
  isObject,
} from "./utils";
import { parseCacheResolverAlias } from "./alias";

const allowedLinkKeys = [ALIAS_ENTITYCACHE_TYPENAME, ALIAS_ENTITYCACHE_ID];
function dataObjectIsLink(data: object) {
  const keys = Object.keys(data);
  for (const key of keys) {
    if (!allowedLinkKeys.includes(key)) {
      return false;
    }
  }
  return true;
}

export function makeLinkCollector(
  linkSelections: Record<string, SelectionSetNode>,
  knownEntities: KnownEntitiesMap,
) {
  function _collectLinks(
    data: unknown,
    coordinates: string = CoordinateRoot.query,
    link?: TypeLinkWithCoordinates,
  ): TypeLinkWithCoordinates | TypeLinkWithCoordinates[] {
    if (isObject(data)) {
      if (dataObjectIsLink(data)) {
        const selectionSet = linkSelections[coordinates];

        if (!selectionSet) {
          throw new Error(
            "Selection set not found for link with coordinates " + coordinates,
          );
        }

        const typename = data[ALIAS_ENTITYCACHE_TYPENAME];
        const id = data[ALIAS_ENTITYCACHE_ID];

        if (!isId(id) || typeof typename !== "string") {
          return [];
        }

        let knownIds = knownEntities[typename];

        if (knownIds?.has(id)) {
          return [];
        }

        if (knownIds === undefined) {
          knownIds = new Set();
          knownEntities[typename] = knownIds;
        }

        knownIds.add(id);

        link ??= {
          coordinates,
          ids: [],
          selectionSet: linkSelections[coordinates],
          typename,
        };
        link!.ids.push(id);
        return link;
      }
      return Object.keys(data).flatMap((key) =>
        _collectLinks(
          data[key],
          `${coordinates}.${
            isCacheAliasName(key) ? parseCacheResolverAlias(key) : key
          }`,
        ),
      );
    }

    if (isArray(data)) {
      const nextLinks: TypeLinkWithCoordinates[] = [];
      let thisLink: TypeLinkWithCoordinates | undefined;

      for (const index of data.keys()) {
        const nextData = data[index];
        const next = _collectLinks(nextData, coordinates, thisLink);
        if (Array.isArray(next)) {
          for (const item of next) {
            nextLinks.push(item);
          }
        } else {
          thisLink = next;
        }
      }

      if (thisLink !== undefined) {
        nextLinks.push(thisLink);
      }

      return nextLinks;
    }

    return [];
  }

  return function collectLinks(data: unknown) {
    const linkOrLinks = _collectLinks(data);
    return isArray(linkOrLinks) ? linkOrLinks : [linkOrLinks];
  };
}

function injectDataByCoordinates(
  data: unknown,
  path: readonly string[],
  injector: (data: unknown) => unknown,
): unknown {
  if (isArray(data)) {
    return data.map((next: unknown) => {
      return injectDataByCoordinates(next, path, injector);
    });
  }

  const [next, ...rest] = path;

  if (next === undefined) {
    return injector(data);
  }

  if (isObject(data)) {
    data[next] = injectDataByCoordinates(data[next], rest, injector);
  }

  return data;
}

function getEntityLinkMerger(entityData: unknown) {
  if (isCacheResolvedEntityList(entityData)) {
    return (data: CacheResolvedEntity) => {
      const sourceEntity = entityData.find((e) => {
        return (
          data.__entityCacheTypeName === e.__entityCacheTypeName &&
          data.__entityCacheId === e.__entityCacheId
        );
      });

      if (!sourceEntity) {
        return data;
      }

      return indexWiseDeepMerge(data, sourceEntity);
    };
  }
  if (isCacheResolvedEntity(entityData)) {
    return (data: CacheResolvedEntity) => {
      if (
        data.__entityCacheTypeName === entityData.__entityCacheTypeName &&
        data.__entityCacheId === entityData.__entityCacheId
      ) {
        return indexWiseDeepMerge(data, entityData);
      }
      return data;
    };
  }
  return undefined;
}

export function mergeLink(
  data: ObjMap<unknown>,
  coordinates: string,
  resolverValue: unknown,
): void {
  const merge = getEntityLinkMerger(resolverValue);

  if (!merge) {
    return;
  }

  injectDataByCoordinates(data, coordinates.split("."), (data) => {
    if (isCacheResolvedEntity(data)) {
      return merge(data);
    }

    return data;
  });
}

function scavengeShallowSelections(
  selectionSet: SelectionSetNode,
): SelectionNode[] {
  return selectionSet.selections.flatMap((selection) => {
    if (selection.kind === Kind.FIELD) {
      return [selection];
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      return scavengeShallowSelections(selection.selectionSet);
    }
    return [];
  });
}

export function convertFieldNodeToLink(field: FieldNode) {
  if (!field.selectionSet) {
    return null;
  }

  const selections = scavengeShallowSelections(field.selectionSet);

  const idSelection = selections.find((node): node is FieldNode => {
    return (
      node.kind === Kind.FIELD && node.alias?.value === ALIAS_ENTITYCACHE_ID
    );
  });

  if (!idSelection) {
    throw new GraphQLError("No id selection found for cache resolver entity", {
      nodes: [field],
    });
  }

  return <FieldNode>{
    ...field,
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections: [
        {
          alias: {
            kind: Kind.NAME,
            value: ALIAS_ENTITYCACHE_TYPENAME,
          },
          kind: Kind.FIELD,
          name: {
            kind: Kind.NAME,
            value: "__typename",
          },
        },

        {
          alias: {
            kind: Kind.NAME,
            value: ALIAS_ENTITYCACHE_ID,
          },
          kind: Kind.FIELD,
          name: {
            kind: Kind.NAME,
            value: idSelection.name.value,
          },
        },
      ],
    },
  };
}

export function buildLinkQuery(
  links: TypeLinkWithCoordinates[],
  resolvers: CacheResolverMap,
  originalOperationName?: string,
): { document: DocumentNode; operationName: string } | null {
  const cacheResolutions: FieldNode[] = [];

  for (const link of links) {
    const resolver = resolvers[link.typename];

    if (!resolver) {
      continue;
    }

    const mapResolutions = getCacheResolutionMapper(resolver);

    const resolutions = mapResolutions(
      link.ids,
      link.coordinates,
      link.selectionSet,
    );

    for (const resolution of resolutions) {
      cacheResolutions.push(resolution);
    }
  }

  if (cacheResolutions.length === 0) {
    return null;
  }

  const operationName = `${
    originalOperationName ? `${originalOperationName}_` : ""
  }_linkQuery`;

  const document = {
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        name: {
          kind: Kind.NAME,
          value: operationName,
        },
        operation: OperationTypeNode.QUERY,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: cacheResolutions,
        },
      },
    ],
    kind: Kind.DOCUMENT,
  } as const;

  return { document, operationName };
}
