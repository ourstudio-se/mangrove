import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  CoordinateRoot,
} from "./constants.js";
import { ObjMap } from "./typings.js";
import { cloneData, isArray, isObject } from "./utils.js";
import { isCacheAliasName, parseCacheResolverAlias } from "./alias.js";

/**
 * Raised when a partial result can't be merged into the cached result in a
 * way that is guaranteed to be correct. The runner reacts by executing the
 * original document in full.
 */
export class CacheMergeError extends Error {}

export function getEntityIdentity(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const typename = value[ALIAS_ENTITYCACHE_TYPENAME];
  const id = value[ALIAS_ENTITYCACHE_ID];
  if (typeof typename !== "string") {
    return undefined;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }
  return JSON.stringify([typename, String(id)]);
}

/** An object that only identifies an entity, left behind by a link. */
export function isLinkStub(value: unknown): value is ObjMap<unknown> {
  if (!isObject(value) || getEntityIdentity(value) === undefined) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (key !== ALIAS_ENTITYCACHE_ID && key !== ALIAS_ENTITYCACHE_TYPENAME) {
      return false;
    }
  }
  return true;
}

/**
 * Entities found in a (cached) result, by the coordinates they were found at.
 * The selection set at a coordinate is the same for every object found there,
 * which makes a snapshot from one position a valid stand-in for another.
 */
export class EntitySnapshots {
  private readonly byCoordinates = new Map<
    string,
    Map<string, ObjMap<unknown>>
  >();

  constructor(data?: unknown) {
    if (data !== undefined) {
      this.index(data, CoordinateRoot.query);
    }
  }

  get(coordinates: string, identity: string): ObjMap<unknown> | undefined {
    return this.byCoordinates.get(coordinates)?.get(identity);
  }

  has(coordinates: string, identity: string): boolean {
    return this.byCoordinates.get(coordinates)?.has(identity) ?? false;
  }

  /**
   * Records fresher data for an entity, so that later stubs for it (e.g. in
   * subsequent link query rounds) are completed with up-to-date data.
   */
  set(coordinates: string, identity: string, entity: ObjMap<unknown>) {
    let entities = this.byCoordinates.get(coordinates);
    if (!entities) {
      entities = new Map();
      this.byCoordinates.set(coordinates, entities);
    }
    entities.set(identity, entity);
  }

  private index(data: unknown, coordinates: string) {
    if (isArray(data)) {
      for (const item of data) {
        this.index(item, coordinates);
      }
      return;
    }

    if (!isObject(data)) {
      return;
    }

    const identity = getEntityIdentity(data);

    // Stubs carry no data, so they can't stand in for anything.
    if (
      identity !== undefined &&
      !isLinkStub(data) &&
      !this.has(coordinates, identity)
    ) {
      this.set(coordinates, identity, data as ObjMap<unknown>);
    }

    for (const key of Object.keys(data)) {
      this.index(data[key], `${coordinates}.${key}`);
    }
  }
}

/**
 * Fresh data received for entities during the current request, in the order
 * it was received. Copies of cached snapshots are patched with it, so that
 * data from the cache never resurrects something that was just refetched.
 */
export class FreshEntities {
  private readonly byCoordinates = new Map<
    string,
    Map<string, ObjMap<unknown>[]>
  >();

  add(coordinates: string, identity: string, entity: ObjMap<unknown>) {
    let entities = this.byCoordinates.get(coordinates);
    if (!entities) {
      entities = new Map();
      this.byCoordinates.set(coordinates, entities);
    }
    const list = entities.get(identity);
    if (list) {
      list.push(entity);
    } else {
      entities.set(identity, [entity]);
    }
  }

  get(coordinates: string, identity: string): readonly ObjMap<unknown>[] {
    return this.byCoordinates.get(coordinates)?.get(identity) ?? [];
  }
}

export interface MergeContext {
  fresh: FreshEntities;
  /** Coordinates whose selection sets were narrowed in the partial query. */
  prunedCoordinates: ReadonlySet<string>;
  snapshots: EntitySnapshots;
}

export function createMergeContext(
  cachedData: unknown,
  prunedCoordinates: Iterable<string> = [],
): MergeContext {
  return {
    fresh: new FreshEntities(),
    prunedCoordinates: new Set(prunedCoordinates),
    snapshots: new EntitySnapshots(cachedData),
  };
}

/**
 * Applies the fresh data received so far to (a copy of) cached data.
 */
function patchWithFresh(
  value: unknown,
  coordinates: string,
  context: MergeContext,
): unknown {
  if (isArray(value)) {
    return value.map((item) => patchWithFresh(item, coordinates, context));
  }

  if (!isObject(value)) {
    return value;
  }

  let patched = value as ObjMap<unknown>;
  const identity = getEntityIdentity(patched);

  if (identity !== undefined) {
    for (const fresh of context.fresh.get(coordinates, identity)) {
      patched = mergeData(
        patched,
        fresh,
        coordinates,
        context,
        false,
      ) as ObjMap<unknown>;
    }
  }

  for (const key of Object.keys(patched)) {
    patched[key] = patchWithFresh(
      patched[key],
      `${coordinates}.${key}`,
      context,
    );
  }

  return patched;
}

/**
 * Records every entity in freshly fetched data as fresh, whether or not it
 * ends up being merged anywhere.
 */
function recordFresh(
  value: unknown,
  coordinates: string,
  context: MergeContext,
) {
  if (isArray(value)) {
    for (const item of value) {
      recordFresh(item, coordinates, context);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  const identity = getEntityIdentity(value);

  if (identity !== undefined && !isLinkStub(value)) {
    context.fresh.add(coordinates, identity, value as ObjMap<unknown>);
  }

  for (const key of Object.keys(value)) {
    recordFresh(value[key], `${coordinates}.${key}`, context);
  }
}

/** A private, up-to-date copy of a cached snapshot. */
function copySnapshot(
  snapshot: ObjMap<unknown>,
  coordinates: string,
  context: MergeContext,
): ObjMap<unknown> {
  return patchWithFresh(
    cloneData(snapshot),
    coordinates,
    context,
  ) as ObjMap<unknown>;
}

function sameShape(target: ObjMap<unknown>, source: ObjMap<unknown>) {
  const sourceIdentity = getEntityIdentity(source);
  if (sourceIdentity !== undefined) {
    return getEntityIdentity(target) === sourceIdentity;
  }
  const sourceType = source[ALIAS_ENTITYCACHE_TYPENAME];
  const targetType = target[ALIAS_ENTITYCACHE_TYPENAME];
  if (typeof sourceType === "string" && typeof targetType === "string") {
    return sourceType === targetType;
  }
  return true;
}

/**
 * Merges freshly fetched data (`source`) into previously cached data
 * (`target`) found at `coordinates`, returning the merged value. `target` may
 * be mutated, and must not be shared with anything else.
 *
 * - Objects are merged field by field, but only if they are the same entity
 *   (or the same type, for objects without an id); otherwise the source
 *   replaces the target.
 * - A source object for an entity that isn't at the same position in the
 *   target is merged into a snapshot of that entity from elsewhere in the
 *   cached result at the same coordinates, if there is one.
 * - Lists are matched entity by entity; non-entity items by index.
 */
export function mergeData(
  target: unknown,
  source: unknown,
  coordinates: string,
  context: MergeContext,
  recordFresh = true,
): unknown {
  const { snapshots } = context;

  if (isArray(source)) {
    const targetList = isArray(target) ? target : [];
    return source.map((item, index) => {
      if (isObject(item)) {
        const identity = getEntityIdentity(item);
        if (identity !== undefined) {
          const inList = targetList.find(
            (t) => getEntityIdentity(t) === identity,
          );
          const snapshot = snapshots.get(coordinates, identity);
          const base =
            inList !== undefined
              ? cloneData(inList)
              : snapshot !== undefined
                ? copySnapshot(snapshot, coordinates, context)
                : undefined;
          return mergeData(base, item, coordinates, context, recordFresh);
        }
      }
      return mergeData(
        targetList[index],
        item,
        coordinates,
        context,
        recordFresh,
      );
    });
  }

  if (isObject(source)) {
    let base: ObjMap<unknown> | undefined =
      isObject(target) &&
      sameShape(target as ObjMap<unknown>, source as ObjMap<unknown>)
        ? (target as ObjMap<unknown>)
        : undefined;

    if (base === undefined) {
      if (context.prunedCoordinates.has(coordinates) && !isLinkStub(source)) {
        // Only part of this object was fetched, on the assumption that it was
        // still the same object as in the cached result. It isn't, so the
        // cached data can't be trusted to complete it.
        throw new CacheMergeError(
          `Object at ${coordinates} changed without being invalidated`,
        );
      }
      const identity = getEntityIdentity(source);
      const snapshot =
        identity !== undefined
          ? snapshots.get(coordinates, identity)
          : undefined;
      base =
        snapshot !== undefined
          ? copySnapshot(snapshot, coordinates, context)
          : {};
    }

    for (const key of Object.keys(source)) {
      base[key] = mergeData(
        base[key],
        source[key],
        `${coordinates}.${key}`,
        context,
        recordFresh,
      );
    }

    const identity = getEntityIdentity(source);

    if (identity !== undefined && !isLinkStub(source)) {
      snapshots.set(coordinates, identity, base);
      if (recordFresh) {
        context.fresh.add(coordinates, identity, source as ObjMap<unknown>);
      }
    }

    return base;
  }

  return source;
}

/**
 * Merges entities fetched through a cache resolver into every position at
 * `coordinates` (absolute, `Query.…`) where an entity with the same identity
 * is found.
 */
export function mergeResolvedEntities(
  data: ObjMap<unknown>,
  coordinates: string,
  resolved: unknown,
  context: MergeContext,
) {
  const fetched = new Map<string, ObjMap<unknown>>();

  for (const entity of isArray(resolved) ? resolved : [resolved]) {
    const identity = getEntityIdentity(entity);
    if (identity === undefined) {
      // A resolver returned null (or something without an identity) for an
      // entity that we know exists in the cached result.
      throw new CacheMergeError(
        `Cache resolver at ${coordinates} did not return a resolvable entity`,
      );
    }
    fetched.set(identity, entity as ObjMap<unknown>);
    recordFresh(entity, coordinates, context);
  }

  const [root, ...fields] = coordinates.split(".");

  if (root !== CoordinateRoot.query || fields.length === 0) {
    throw new CacheMergeError(`Invalid resolver coordinates ${coordinates}`);
  }

  function visit(container: unknown, depth: number): unknown {
    if (isArray(container)) {
      return container.map((item) => visit(item, depth));
    }

    if (depth === fields.length) {
      const identity = getEntityIdentity(container);
      const entity = identity !== undefined ? fetched.get(identity) : undefined;
      if (entity === undefined) {
        return container;
      }
      const fieldCoordinates = [root, ...fields].join(".");
      return mergeData(container, entity, fieldCoordinates, context, false);
    }

    if (isObject(container)) {
      const field = fields[depth];
      if (field in container) {
        container[field] = visit(container[field], depth + 1);
      }
    }

    return container;
  }

  // Entities that are no longer at these coordinates (e.g. removed from a
  // refetched list) are simply not merged anywhere.
  visit(data, 0);
}

/**
 * Merges one execution result (partial query or link query) into `data`.
 * Root fields aliased as cache resolutions are merged into their encoded
 * coordinates; everything else is merged in place.
 */
export function mergeExecutionData(
  data: ObjMap<unknown>,
  nextData: ObjMap<unknown>,
  context: MergeContext,
): ObjMap<unknown> {
  const plain: ObjMap<unknown> = {};
  const resolutions: [string, unknown][] = [];

  for (const key of Object.keys(nextData)) {
    if (isCacheAliasName(key)) {
      resolutions.push([parseCacheResolverAlias(key), nextData[key]]);
    } else {
      plain[key] = nextData[key];
    }
  }

  const merged = mergeData(
    data,
    plain,
    CoordinateRoot.query,
    context,
  ) as ObjMap<unknown>;

  for (const [coordinates, value] of resolutions) {
    mergeResolvedEntities(merged, coordinates, value, context);
  }

  return merged;
}

/** Throws if any link stub was left unresolved in `data`. */
export function assertNoLinkStubs(
  data: unknown,
  coordinates = CoordinateRoot.query,
) {
  if (isArray(data)) {
    for (const item of data) {
      assertNoLinkStubs(item, coordinates);
    }
    return;
  }
  if (!isObject(data)) {
    return;
  }
  if (isLinkStub(data)) {
    throw new CacheMergeError(`Unresolved link at ${coordinates}`);
  }
  for (const key of Object.keys(data)) {
    assertNoLinkStubs(data[key], `${coordinates}.${key}`);
  }
}
