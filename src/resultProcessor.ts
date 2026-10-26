import {
  EntityWithLocation,
  MakeResultProcessorOpts,
  ObjMap,
  ResultProcessor,
} from "./typings.js";
import { ExecutionResult, GraphQLError } from "graphql";
import { createMergeContext, mergeExecutionData } from "./merge.js";
import { cleanupData, cloneData, collectEntityRecords } from "./utils.js";
import {
  defaultCollectEntityWithLocation,
  defaultShouldCacheResult,
} from "./defaults.js";

export function makeResultProcessor({
  entityTtls = {},
  collectEntityWithLocation = defaultCollectEntityWithLocation,
  storeExecutionResult,
  shouldCacheResult = defaultShouldCacheResult,
  ttl,
  logger = console,
  awaitWriteBeforeResponse = false,
}: MakeResultProcessorOpts): ResultProcessor {
  return async (parameter) => {
    const {
      cachedResult,
      cacheKey,
      originalDocument,
      nextResults,
      cacheState,
    } = parameter;

    const mergeContext =
      parameter.mergeContext ?? createMergeContext(cachedResult?.data);

    let mergedData: ObjMap<unknown> = cloneData(
      (cachedResult?.data as ObjMap<unknown> | null | undefined) ?? {},
    );
    // Errors stored with the cached result (if results with errors are
    // cached at all) still apply to the parts of it that weren't refetched.
    let mergedErrors: readonly GraphQLError[] = cachedResult?.errors ?? [];
    let extensions: ObjMap<unknown> | undefined;

    for (const [index, nextResult] of nextResults.entries()) {
      const nextData = nextResult.data as ObjMap<unknown> | null | undefined;

      if (nextData) {
        mergedData = mergeExecutionData(
          mergedData,
          nextData,
          mergeContext,
          parameter.resolutions?.[index],
        );
      }

      if (nextResult.errors) {
        mergedErrors = [...mergedErrors, ...nextResult.errors];
      }

      if (extensions === undefined) {
        extensions = nextResult.extensions;
      }
    }

    const storedResult: ExecutionResult = {
      data: mergedData,
      errors: mergedErrors.length > 0 ? mergedErrors : undefined,
    };

    const collectedEntities: readonly EntityWithLocation[] =
      collectEntityRecords(mergedData, collectEntityWithLocation);

    // A pure cache hit has nothing new to store.
    const isPureHit = cachedResult !== undefined && nextResults.length === 0;

    if (!isPureHit && shouldCacheResult({ cacheKey, result: storedResult })) {
      const deferredStoreExecution = storeExecutionResult({
        cacheKey,
        cacheState,
        collectedEntities,
        entityTtls,
        executionResult: storedResult,
        mergedIntoCachedResult: cachedResult !== undefined,
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

    const result: ExecutionResult = {
      data: cleanupData(mergedData),
      errors: storedResult.errors,
      extensions,
    };

    return { collectedEntities, result };
  };
}
