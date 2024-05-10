import {
  Cache,
  CacheResolverMap,
  EntityCacheResult,
  EntityRecord,
  EntityTypeReference,
  InvalidationStrategy,
  KnownEntitiesMap,
  Logger,
} from "../typings";
import { DocumentNode, SelectionSetNode } from "graphql";
import { buildEntityTreeNode, spawnTreeRoot } from "../tree";
import {
  createCacheSetMemberGetter,
  getAndParseCachedResponse,
  getEntityKeysToInvalidate,
} from "./utils";
import {
  defaultBuildEntityKey,
  defaultBuildEntityReferenceKey,
  defaultBuildLazyOperationKey,
  defaultParseEntityKey,
  defaultParseEntityReferenceKey,
} from "../defaults";
import { getPartialRecacheQuery } from "../getPartialRecacheQuery";

export interface LazyInvalidationStrategyOpts {
  buildEntityKey?: (entity: EntityRecord) => string;
  buildEntityReferenceKey?: (entityReference: EntityTypeReference) => string;
  buildOperationKey?: (cacheKey: string) => string;
  cache: Cache;
  logger?: Logger;
  parseEntityKey?: (key: string) => EntityRecord;
  parseEntityReferenceKey?: (key: string) => EntityTypeReference | null;
}

interface ParseEntityReferencesParameter {
  buildOperationKey: (cacheKey: string) => string;
  cacheKey: string;
  entityReferences: EntityTypeReference[];
  operationsByEntity: string[][];
  parseEntityKey: (str: string) => EntityRecord;
  resolvers: CacheResolverMap;
}

async function parseEntityReferences({
  cacheKey,
  resolvers,
  parseEntityKey = defaultParseEntityKey,
  entityReferences,
  operationsByEntity,
}: ParseEntityReferencesParameter) {
  const entityTree = spawnTreeRoot();
  const knownEntities: KnownEntitiesMap = {};

  entityReferences.forEach((entityReference, index) => {
    const operations = operationsByEntity[index];
    const hasCrossReference = operations.some(
      (operation) => operation === cacheKey,
    );

    const ecr: EntityCacheResult = {
      entity: parseEntityKey(entityReference.entityKey),
      invalidated: !hasCrossReference,
      path: entityReference.path,
    };

    if (ecr.entity.id) {
      let typeIds = knownEntities[ecr.entity.typename];

      if (typeIds === undefined) {
        typeIds = new Set();
        knownEntities[ecr.entity.typename] = typeIds;
      }

      typeIds.add(ecr.entity.id);
    }

    buildEntityTreeNode(entityTree, ecr, resolvers);
  });

  return { entityTree, knownEntities };
}

export const lazyInvalidationStrategy = ({
  buildEntityKey = defaultBuildEntityKey,
  buildEntityReferenceKey = defaultBuildEntityReferenceKey,
  buildOperationKey = defaultBuildLazyOperationKey,
  parseEntityKey = defaultParseEntityKey,
  parseEntityReferenceKey = defaultParseEntityReferenceKey,
  cache,
  logger = console,
}: LazyInvalidationStrategyOpts): InvalidationStrategy => {
  return {
    async getPartialExecutionOpts({
      cacheKey,
      query: originalDocument,
      resolvers,
    }) {
      const result = await getAndParseCachedResponse(cache, cacheKey, logger);

      if (!result) {
        return {
          knownEntities: {},
          linkSelections: {},
          query: originalDocument,
        };
      }

      const getCacheSetMembers = createCacheSetMemberGetter(cache);

      const entities = await getCacheSetMembers(buildOperationKey(cacheKey));

      const entityReferences = entities.flatMap((entityReferenceKey) => {
        return parseEntityReferenceKey(entityReferenceKey) ?? [];
      });

      if (entityReferences.length === 0) {
        return {
          knownEntities: {},
          linkSelections: {},
          query: originalDocument,
        };
      }

      /* We're using the Promise.all() pattern here to
        let the cache know it can resolve the key searches
        in parallell/as part of the same pipeline if it
        wants to */
      const operationsByEntity = await Promise.all(
        entityReferences.map((entityReference) => {
          return getCacheSetMembers(entityReference.entityKey);
        }),
      );

      const { knownEntities, entityTree } = await parseEntityReferences({
        buildOperationKey,
        cacheKey,
        entityReferences,
        operationsByEntity,
        parseEntityKey,
        resolvers,
      });

      let query: DocumentNode | undefined;
      let linkSelections: Record<string, SelectionSetNode> | undefined;

      try {
        const result = getPartialRecacheQuery({
          entityTree,
          originalDocument,
        });

        if (result) {
          query = result.query;
          linkSelections = result.linkSelections;
        }
      } catch (err) {
        logger.error(
          `Unexpected error when handling getting partial query, falling back to uncached execution: ${err.message}`,
        );
        return {
          knownEntities: {},
          linkSelections: {},
          query: originalDocument,
        };
      }

      linkSelections = linkSelections ?? {};

      return {
        knownEntities,
        linkSelections,
        query,
        result,
      };
    },
    async invalidateEntities(entitiesToInvalidate) {
      const keys = await getEntityKeysToInvalidate({
        buildEntityKey,
        cache,
        entitiesToInvalidate,
      });
      if (keys.size > 0) {
        await cache.clear(keys);
      }
    },
    async storeExecutionResult({
      cacheKey,
      executionResult,
      collectedEntities,
      ttl,
      entityTtls,
    }) {
      const stringifiedResult = JSON.stringify(executionResult);
      const pipe = cache.getPipe();

      const operationKey = buildOperationKey(cacheKey);

      let entityReferences: readonly [string, number][] = [];

      for (const { entity, path } of collectedEntities) {
        const entityKey = buildEntityKey(entity);
        const entityReferenceKey = buildEntityReferenceKey({
          entityKey,
          path,
        });
        const entityTtl = entityTtls[entity.typename] ?? ttl;
        await pipe.addMembersToSet(entityKey, [[cacheKey, entityTtl]]);

        entityReferences = [...entityReferences, [entityReferenceKey, ttl]];
      }

      await pipe.clear([operationKey]);
      await pipe.addMembersToSet(operationKey, entityReferences);
      await pipe.set(cacheKey, stringifiedResult, ttl);

      await pipe.execute();
    },
  };
};
