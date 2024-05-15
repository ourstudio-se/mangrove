import { Cache, CachedExecutionResult, EntityRecord, Logger } from "../typings";

export function createCacheSetMemberGetter(cache: Cache) {
  const memoizedEntities = new Map<string, string[]>();

  return async function getCacheSetMembers(entity: string) {
    let members = memoizedEntities.get(entity);
    if (members === undefined) {
      members = await cache.getSetMembers(entity);
      memoizedEntities.set(entity, members);
    }
    return members;
  };
}

export interface ExpandEntitiesToInvalidateParameter {
  buildEntityKey: (entity: EntityRecord) => string;
  cache: Cache;
  entitiesToInvalidate: Iterable<EntityRecord>;
}

export async function getEntityKeysToInvalidate({
  buildEntityKey,
  cache,
  entitiesToInvalidate,
}: ExpandEntitiesToInvalidateParameter) {
  const keysToInvalidate: string[] = [];

  /* We're using the Promise.all() pattern here to
      let the cache know it can resolve the key searches
      in parallell/as part of the same pipeline if it
      wants to */

  const deferredKeys: Promise<string[]>[] = [];

  for (const entity of entitiesToInvalidate) {
    const entityKey = buildEntityKey(entity);

    keysToInvalidate.push(entityKey);

    if (!entity.id) {
      deferredKeys.push(cache.getKeysStartingWith(entity.typename));
    }
  }

  const keys = (await Promise.all(deferredKeys)).flat();

  for (const key of keys) {
    keysToInvalidate.push(key);
  }

  return new Set(keysToInvalidate.flat());
}

export async function getAndParseCachedResponse(
  cache: Cache,
  cacheKey: string,
  logger: Logger,
) {
  const serializedResult = await cache.get(cacheKey);

  if (!serializedResult) {
    return null;
  }

  let result: CachedExecutionResult;

  try {
    result = JSON.parse(serializedResult);
  } catch (err) {
    logger.error(
      "Error deserializing cached result, falling back to uncached execution",
    );
    return null;
  }

  return result;
}
