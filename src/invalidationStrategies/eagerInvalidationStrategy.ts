import {
  Cache,
  CacheResolverMap,
  CollectEntityWithLocationFunction,
  EntityCacheResult,
  EntityRecord,
  Id,
  InvalidationStrategy,
  Logger,
} from "../typings.js";
import { DocumentNode, SelectionSetNode, parse, print } from "graphql";
import { ROOT_ENTITY_ID } from "../constants.js";
import {
  attachToCacheExtensions,
  collectEntityRecords,
  deserializeKnownEntities,
  getKnownEntities,
  serializeKnownEntities,
} from "../utils.js";
import { buildEntityTreeNode, spawnTreeRoot } from "../tree.js";
import {
  createCacheSetMemberGetter,
  getAndParseCachedResponse,
  getEntityKeysToInvalidate,
} from "./utils.js";
import {
  defaultBuildEntityKey,
  defaultCollectEntityWithLocation,
  defaultParseEntityKey,
} from "../defaults.js";
import { getPartialRecacheQuery } from "../getPartialRecacheQuery.js";
import { parseSelectionSet } from "../borrowedTools/parseSelectionSet.js";

export interface EagerInvalidationStrategyOpts {
  buildEntityKey?: (entity: EntityRecord) => string;
  cache: Cache;
  collectEntityWithLocation?: CollectEntityWithLocationFunction;
  logger?: Logger;
  parseEntityKey?: (key: string) => EntityRecord;
  resolvers: CacheResolverMap;
  ttl: number;
}

export interface GetCacheInvalidatorParameter {
  cache: Cache;
  collectEntityWithLocation: CollectEntityWithLocationFunction;
  logger: Logger;
  parseEntityKey: (key: string) => EntityRecord;
  resolvers: CacheResolverMap;
  ttl: number;
}

// This god damn thing is huge. How do we refactor this shit?
function getCacheInvalidator({
  cache,
  logger,
  parseEntityKey,
  resolvers,
  ttl,
  collectEntityWithLocation,
}: GetCacheInvalidatorParameter) {
  return async (cacheKey: string, entityKeys: Iterable<string>) => {
    const cachedResult = await getAndParseCachedResponse(
      cache,
      cacheKey,
      logger,
    );

    if (!cachedResult) {
      return;
    }

    const invalidationMap: Record<string, Set<Id>> = {};

    const cacheExtension = cachedResult.extensions?.cache;

    if (!cacheExtension) {
      logger.error(
        "Cache extension not available on invalidated query, skipping",
      );
      return;
    }

    for (const key of entityKeys) {
      const { typename, id } = parseEntityKey(key);

      if (invalidationMap[typename] === undefined) {
        invalidationMap[typename] = new Set();
      }

      invalidationMap[typename].add(id ?? ROOT_ENTITY_ID);
    }

    const originalDocumentStr = cacheExtension?.originalDocument;

    if (!originalDocumentStr) {
      logger.error(
        "Can't eagerly invalidate operation where original document is not saved as part of the response extension",
      );
      return;
    }

    let originalDocument: DocumentNode;

    try {
      originalDocument = parse(originalDocumentStr);
    } catch {
      logger.error(
        `Unable to parse original document for operation ${cacheKey}, not invalidating`,
      );
      return;
    }

    const collectedEntities = collectEntityRecords(
      cachedResult.data,
      collectEntityWithLocation,
    );

    const entityTree = spawnTreeRoot();

    for (const { entity, path } of collectedEntities) {
      const typename = entity.typename;
      const id = entity.id ?? ROOT_ENTITY_ID;
      const invalidationById: Set<Id> | undefined = invalidationMap[typename];
      const invalidated = invalidationById?.has(id);

      const ecr: EntityCacheResult = {
        entity: {
          id,
          typename,
        },
        invalidated,
        path,
      };

      buildEntityTreeNode(entityTree, ecr, resolvers);
    }

    try {
      const result = getPartialRecacheQuery({
        entityTree,
        originalDocument,
      });

      if (result) {
        cacheExtension.partialQuery = print(result.query);
        cacheExtension.linkSelections = result.linkSelections
          ? Object.keys(result.linkSelections).reduce<Record<string, string>>(
              (linksels, coordinate) => {
                const selectionSet = result.linkSelections![coordinate];
                linksels[coordinate] = print(selectionSet);
                return linksels;
              },
              {},
            )
          : undefined;
      }
    } catch (err) {
      logger.error(
        `Unexpected error when handling getting partial query, skipping invalidation of operation ${cacheKey}: ${err.message}`,
      );
      return;
    }

    await cache.set(cacheKey, JSON.stringify(cachedResult), ttl);
  };
}

export const eagerInvalidationStrategy = ({
  buildEntityKey = defaultBuildEntityKey,
  parseEntityKey = defaultParseEntityKey,
  resolvers,
  ttl,
  cache,
  collectEntityWithLocation = defaultCollectEntityWithLocation,
  logger = console,
}: EagerInvalidationStrategyOpts): InvalidationStrategy => {
  const invalidateCacheResult = getCacheInvalidator({
    cache,
    collectEntityWithLocation,
    logger,
    parseEntityKey,
    resolvers,
    ttl,
  });

  return {
    async getPartialExecutionOpts({ cacheKey, query: originalDocument }) {
      const result = await getAndParseCachedResponse(cache, cacheKey, logger);

      if (!result) {
        return {
          knownEntities: {},
          linkSelections: {},
          query: originalDocument,
        };
      }

      const cacheExtension = result.extensions?.cache;

      if (!cacheExtension) {
        logger.warn(
          "No cache extension found on cached document, falling back to standard execution",
        );
        return {
          knownEntities: {},
          linkSelections: {},
          query: originalDocument,
        };
      }

      const partialQueryStr = cacheExtension.partialQuery;

      if (partialQueryStr === undefined) {
        return {
          knownEntities: {},
          linkSelections: {},
          query: originalDocument,
        };
      }

      const partialQuery = parse(partialQueryStr);

      const knownEntities = deserializeKnownEntities(
        cacheExtension.knownEntities ?? {},
      );

      const linkSelections = cacheExtension.linkSelections
        ? Object.keys(cacheExtension.linkSelections).reduce<
            Record<string, SelectionSetNode>
          >((linkSelections, coordinates) => {
            const selectionSet = parseSelectionSet(
              cacheExtension.linkSelections![coordinates],
            );
            linkSelections[coordinates] = selectionSet;
            return linkSelections;
          }, {})
        : {};

      return {
        knownEntities,
        linkSelections,
        query: partialQuery,
      };
    },
    async invalidateEntities(entitiesToInvalidate) {
      const keys = Array.from(
        await getEntityKeysToInvalidate({
          buildEntityKey,
          cache,
          entitiesToInvalidate,
        }),
      );
      const getCacheSetMembers = createCacheSetMemberGetter(cache);

      const operationsToInvalidateByKey = await Promise.all(
        keys.map((entityKey) => getCacheSetMembers(entityKey)),
      );

      const entityKeysByOperation = operationsToInvalidateByKey.reduce<
        Record<string, Set<string>>
      >((map, perKeyOperations, index) => {
        const key = keys[index];

        for (const operation of perKeyOperations) {
          if (map[operation] === undefined) {
            map[operation] = new Set();
          }

          map[operation].add(key);
        }

        return map;
      }, {});

      const cacheKeys = Object.keys(entityKeysByOperation);

      cacheKeys.forEach(async (cacheKey) => {
        const entityKeys = entityKeysByOperation[cacheKey];
        await invalidateCacheResult(cacheKey, entityKeys);
      });
    },
    async storeExecutionResult({
      cacheKey,
      executionResult,
      collectedEntities,
      originalDocument,
      ttl,
      entityTtls,
    }) {
      // TODO - this does likely not belong here,
      // find a better overall way of handling
      // the extension stuff
      attachToCacheExtensions(
        executionResult,
        "originalDocument",
        print(originalDocument),
      );

      attachToCacheExtensions(
        executionResult,
        "knownEntities",
        serializeKnownEntities(getKnownEntities(collectedEntities)),
      );

      const stringifiedResult = JSON.stringify(executionResult);
      const pipe = cache.getPipe();

      const entityKeys: string[] = [];

      for (const { entity } of collectedEntities) {
        const entityKey = buildEntityKey(entity);
        const entityTtl = entityTtls[entity.typename] ?? ttl;

        // Side effects
        ttl = Math.min(ttl, entityTtl);
        entityKeys.push(entityKey);
      }

      for (const entityKey of entityKeys) {
        await pipe.addMembersToSet(entityKey, [[cacheKey, ttl]]);
      }

      await pipe.set(cacheKey, stringifiedResult, ttl);

      await pipe.execute();
    },
  };
};
