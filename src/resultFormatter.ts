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
  };
}

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
    const expires = Date.now() + ttl;

    if (includeExtensionMetadata) {
      return resultWithCacheExtension(result, {
        cache: {
          cacheKey,
          expires: new Date(expires),
          hit: cachedResult !== undefined,
          knownEntities: serializeKnownEntities(
            getKnownEntities(collectedEntities ?? []),
          ),
          linkQueries: linkQueries?.map(print),
          partialQuery: query ? print(query) : undefined,
        },
      });
    }

    return result;
  };
}
