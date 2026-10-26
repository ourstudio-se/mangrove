import {
  Cache,
  CachedExecutionResult,
  EntityCacheResult,
  EntityRecord,
  InvalidationStrategy,
  Logger,
  PathPart,
} from "../typings.js";
import {
  defaultBuildEntityKey,
  defaultBuildLazyOperationKey,
  defaultBuildTypeIndexKey,
} from "../defaults.js";
import { buildEntityTree } from "../tree.js";
import { getPartialRecacheQuery } from "../getPartialRecacheQuery.js";

export interface LazyInvalidationStrategyOpts {
  buildEntityKey?: (entity: EntityRecord) => string;
  buildOperationKey?: (cacheKey: string) => string;
  buildTypeIndexKey?: (typename: string) => string;
  cache: Cache;
  logger?: Logger;
}

/** State carried from reading the cache to storing the result. */
interface LazyCacheState {
  /** Invalidation epoch observed before anything was read. */
  epoch: number;
  /** Expiry of the cached result this request started from. */
  expiresAt?: number;
}

interface StoredEnvelope {
  expiresAt: number;
  result: CachedExecutionResult;
  v: 2;
}

interface StoredReference {
  /** Entity id, or null for entities identified by typename alone. */
  i: string | null;
  p: PathPart[];
  t: string;
}

function isLazyCacheState(value: unknown): value is LazyCacheState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LazyCacheState).epoch === "number"
  );
}

function parseEnvelope(serialized: string): StoredEnvelope | null {
  const parsed = JSON.parse(serialized);
  if (
    parsed?.v !== 2 ||
    typeof parsed.expiresAt !== "number" ||
    typeof parsed.result !== "object"
  ) {
    return null;
  }
  return parsed;
}

function serializeReference(entity: EntityRecord, path: readonly PathPart[]) {
  const reference: StoredReference = {
    i: entity.id === undefined ? null : String(entity.id),
    p: path.map((part) => {
      const out: PathPart = { field: part.field };
      if (part.index !== undefined) out.index = part.index;
      if (part.typename !== undefined) out.typename = part.typename;
      if (part.id !== undefined) out.id = part.id;
      return out;
    }),
    t: entity.typename,
  };
  return JSON.stringify(reference);
}

function parseReference(serialized: string): EntityCacheResult {
  const { i, p, t } = JSON.parse(serialized) as StoredReference;
  if (typeof t !== "string" || !Array.isArray(p) || p.length === 0) {
    throw new Error(`Invalid entity reference ${serialized}`);
  }
  return {
    entity: i === null ? { typename: t } : { id: i, typename: t },
    invalidated: false,
    path: p,
  };
}

/**
 * Keeps the adaptive logic in the execution path: invalidating an entity
 * simply deletes its key, and each request works out what to refetch by
 * checking which of the entities in its cached result are still valid.
 *
 * Every entity has a set of the cached operations that hold valid data for
 * it. A cached result stays valid for an entity as long as the operation is a
 * member of that entity's set.
 */
export const lazyInvalidationStrategy = ({
  buildEntityKey = defaultBuildEntityKey,
  buildOperationKey = defaultBuildLazyOperationKey,
  buildTypeIndexKey = defaultBuildTypeIndexKey,
  cache,
  logger = console,
}: LazyInvalidationStrategyOpts): InvalidationStrategy => {
  return {
    async getPartialExecutionOpts({
      cacheKey,
      operationName,
      query: originalDocument,
      resolvers,
    }) {
      // The epoch must be read before anything else, so that invalidations
      // that happen while this request runs are detected when storing.
      const epochPromise = cache.getEpoch();
      const serializedPromise = cache.get(cacheKey);
      const epoch = await epochPromise;
      const serialized = await serializedPromise;

      const uncached = {
        cacheState: { epoch } satisfies LazyCacheState,
        linkSelections: {},
        query: originalDocument,
      };

      if (!serialized) {
        return uncached;
      }

      let envelope: StoredEnvelope | null;
      let references: EntityCacheResult[];

      try {
        envelope = parseEnvelope(serialized);

        if (!envelope || envelope.expiresAt <= Date.now()) {
          return uncached;
        }

        const serializedReferences = await cache.getSetMembers(
          buildOperationKey(cacheKey),
        );

        references = serializedReferences.map(parseReference);
      } catch (err) {
        logger.error(
          "Error reading cached result, falling back to uncached execution",
        );
        logger.error(err);
        return uncached;
      }

      if (references.length === 0) {
        return uncached;
      }

      const entityKeys = Array.from(
        new Set(references.map(({ entity }) => buildEntityKey(entity))),
      );

      const validity = new Map(
        await Promise.all(
          entityKeys.map(
            async (entityKey) =>
              [
                entityKey,
                await cache.isSetMember(entityKey, cacheKey),
              ] as const,
          ),
        ),
      );

      for (const reference of references) {
        reference.invalidated = !validity.get(buildEntityKey(reference.entity));
      }

      const cacheState: LazyCacheState = {
        epoch,
        expiresAt: envelope.expiresAt,
      };

      let partial: ReturnType<typeof getPartialRecacheQuery>;

      try {
        partial = getPartialRecacheQuery({
          entityTree: buildEntityTree(references, resolvers),
          operationName,
          originalDocument,
        });
      } catch (err) {
        logger.error(
          "Unexpected error when building partial query, falling back to uncached execution",
        );
        logger.error(err);
        return uncached;
      }

      return {
        cacheState,
        linkSelections: partial?.linkSelections ?? {},
        prunedCoordinates: partial?.prunedCoordinates,
        query: partial?.query,
        result: envelope.result,
      };
    },
    async invalidateEntities(entitiesToInvalidate) {
      const keys = new Set<string>();
      const indexes = new Set<string>();

      for (const entity of entitiesToInvalidate) {
        if (!entity.typename) {
          throw new Error("Can't invalidate an entity without a typename");
        }

        if (entity.id !== undefined && entity.id !== null) {
          keys.add(buildEntityKey(entity));
        } else {
          // Every entity of the type, and the type itself.
          keys.add(buildEntityKey({ typename: entity.typename }));
          indexes.add(buildTypeIndexKey(entity.typename));
        }
      }

      if (keys.size === 0) {
        return;
      }

      await cache.invalidate({ indexes, keys, markers: keys });
    },
    async storeExecutionResult({
      cacheKey,
      cacheState,
      executionResult,
      collectedEntities,
      mergedIntoCachedResult = false,
      ttl,
      entityTtls,
    }) {
      if (!isLazyCacheState(cacheState)) {
        logger.warn(
          "Not storing result: it was not produced from a cache read by this strategy",
        );
        return;
      }

      const now = Date.now();

      // A merged result is only as fresh as the cached result it was merged
      // into, so it keeps that result's expiry.
      const expiresAt =
        mergedIntoCachedResult && cacheState.expiresAt !== undefined
          ? cacheState.expiresAt
          : now + ttl;

      const remaining = expiresAt - now;

      if (remaining <= 0) {
        return;
      }

      const envelope: StoredEnvelope = {
        expiresAt,
        result: executionResult,
        v: 2,
      };

      const entities = new Map<
        string,
        { entity: EntityRecord; memberTtl: number }
      >();
      const references = new Set<string>();

      for (const { entity, path } of collectedEntities) {
        const entityKey = buildEntityKey(entity);
        const entityTtl = Math.min(
          entityTtls[entity.typename] ?? ttl,
          remaining,
        );
        const existing = entities.get(entityKey);

        if (!existing || existing.memberTtl > entityTtl) {
          entities.set(entityKey, { entity, memberTtl: entityTtl });
        }

        references.add(serializeReference(entity, path));
      }

      const pipe = cache.getPipe();
      const operationKey = buildOperationKey(cacheKey);

      for (const [entityKey, { entity, memberTtl }] of entities) {
        if (!(memberTtl > 0)) {
          continue;
        }

        const typeKey = buildEntityKey({ typename: entity.typename });

        await pipe.addMembersToSet(entityKey, [[cacheKey, memberTtl]], {
          guard: {
            epoch: cacheState.epoch,
            markers: entityKey === typeKey ? [entityKey] : [entityKey, typeKey],
          },
          // Never extend how long an entity is considered valid for this
          // operation; only refetched (and thus absent) entities get added.
          onlyNew: true,
        });

        if (entity.id !== undefined) {
          await pipe.addMembersToSet(buildTypeIndexKey(entity.typename), [
            [entityKey, memberTtl],
          ]);
        }
      }

      await pipe.clear([operationKey]);
      await pipe.addMembersToSet(
        operationKey,
        Array.from(references, (reference) => [reference, remaining]),
      );
      await pipe.set(cacheKey, JSON.stringify(envelope), remaining);

      await pipe.execute();
    },
  };
};
