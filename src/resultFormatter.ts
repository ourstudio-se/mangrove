import {
  CacheExtension,
  CachedExecutionResult,
  FormatResult,
  FormatResultParameter,
  MakeResultFormatterParameter,
} from "./typings.js";
import { ExecutionResult, print } from "graphql";
import { getKnownEntities, serializeKnownEntities } from "./utils.js";

function resultWithCacheExtension(
  result: ExecutionResult,
  metadata: CacheExtension,
): CachedExecutionResult {
  return {
    ...result,
    extensions: {
      ...result.extensions,
      ...metadata,
    },
  } as CachedExecutionResult;
}

/**
 * Optionally exposes cache metadata (cache key, known entity ids, generated
 * queries) in the result's extensions. Meant for debugging only.
 */
export function makeResultFormatter({
  includeExtensionMetadata,
  ttl,
}: MakeResultFormatterParameter): FormatResult {
  return ({
    cacheKey,
    cachedResult,
    collectedEntities,
    result,
    query,
    linkQueries,
  }: FormatResultParameter) => {
    if (!includeExtensionMetadata) {
      return result;
    }

    const hit = cachedResult !== undefined;

    return resultWithCacheExtension(result, {
      cache: {
        cacheKey,
        expires: hit ? undefined : new Date(Date.now() + ttl),
        hit,
        knownEntities: serializeKnownEntities(
          getKnownEntities(collectedEntities ?? []),
        ),
        linkQueries: linkQueries?.map((linkQuery) => print(linkQuery)),
        partial: hit && query !== undefined,
        partialQuery: hit && query ? print(query) : undefined,
      },
    });
  };
}
