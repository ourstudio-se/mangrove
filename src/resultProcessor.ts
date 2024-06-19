import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
} from "./constants.js";
import {
  EntityWithLocation,
  MakeResultProcessorOpts,
  ObjMap,
  ResultProcessor,
} from "./typings.js";
import { ExecutionResult, GraphQLError } from "graphql";
import {
  collectEntityRecords,
  indexWiseDeepMerge,
  isArray,
  isCacheAliasName,
  isObject,
  not,
} from "./utils.js";
import { mergeLink } from "./links.js";
import { parseCacheResolverAlias } from "./alias.js";

function resolveNextData(prevData: ObjMap<unknown>, nextData: ObjMap<unknown>) {
  const keys = Object.keys(nextData);
  const cacheResolverKeys = keys.filter(isCacheAliasName);
  const nonCacheResolverKeys = keys.filter(not(isCacheAliasName));

  const nextNonResolverData = nonCacheResolverKeys.reduce<ObjMap<unknown>>(
    (newData, key) => ({
      ...newData,
      [key]: nextData[key],
    }),
    {},
  );

  const mergedData = indexWiseDeepMerge(prevData, nextNonResolverData);

  for (const key of cacheResolverKeys) {
    const coordinates = parseCacheResolverAlias(key);
    mergeLink(mergedData, coordinates, nextData[key]);
  }

  return mergedData;
}

function cleanupData(data: unknown): void {
  if (isObject(data)) {
    if (ALIAS_ENTITYCACHE_TYPENAME in data) {
      delete data[ALIAS_ENTITYCACHE_TYPENAME];
    }

    if (ALIAS_ENTITYCACHE_ID in data) {
      delete data[ALIAS_ENTITYCACHE_ID];
    }

    for (const key of Object.keys(data)) {
      cleanupData(data[key]);
    }

    return;
  }

  if (isArray(data)) {
    data.forEach(cleanupData);
    return;
  }

  return;
}

export function makeResultProcessor({
  entityTtls = {},
  collectEntityWithLocation,
  storeExecutionResult,
  shouldCacheResult = () => true,
  ttl,
  logger = console,
  awaitWriteBeforeResponse = false,
}: MakeResultProcessorOpts): ResultProcessor {
  return async ({ cachedResult, cacheKey, originalDocument, nextResults }) => {
    let collectedEntities: readonly EntityWithLocation[] | undefined;

    let mergedData = cachedResult?.data ?? {};
    let mergedErrors: readonly GraphQLError[] = [];
    let extensions: ObjMap<unknown> | undefined;

    for (const nextResult of nextResults) {
      const nextData: ObjMap<unknown> | null | undefined = nextResult.data;

      if (nextData) {
        mergedData = resolveNextData(mergedData, nextData);
      }

      if (nextResult.errors) {
        mergedErrors = [...mergedErrors, ...nextResult.errors];
      }

      if (extensions === undefined) {
        extensions = nextResult.extensions;
      }
    }

    const result: ExecutionResult = {
      data: mergedData,
      errors: mergedErrors.length > 0 ? mergedErrors : undefined,
      extensions,
    };

    if (shouldCacheResult({ cacheKey, result })) {
      collectedEntities = collectEntityRecords(
        mergedData,
        collectEntityWithLocation,
      );

      const deferredStoreExecution = storeExecutionResult({
        cacheKey,
        collectedEntities,
        entityTtls,
        executionResult: result,
        originalDocument,
        ttl,
      }).catch((err) => {
        logger.error(
          "Unexpected error occured when storing execution result to cache. Result might not have been stored",
        );
        logger.error(err);
      });

      if (awaitWriteBeforeResponse) {
        await deferredStoreExecution;
      }
    }

    cleanupData(result.data);

    return { collectedEntities, result };
  };
}
