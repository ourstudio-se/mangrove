import {
  AddMembersOptions,
  Cache,
  CacheMutations,
  InvalidateParameter,
  StoreCondition,
} from "../typings.js";
import { CacheValidationError } from "./errors.js";

export interface CreateMemoryCacheOpts {
  /**
   * How long (ms) invalidations are remembered for, to reject results of
   * requests that started before them. Must exceed the longest request.
   */
  invalidationWindow?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Expired entries are swept after this many writes. */
  sweepInterval?: number;
}

export interface MemoryCache extends Cache {
  /** Number of stored entries, including expired ones not yet swept. */
  readonly size: number;
}

interface Expiring<T> {
  expiresAt: number;
  value: T;
}

/**
 * An in-process cache with the same semantics as the Redis cache. Useful for
 * tests and single-process deployments.
 */
export function createMemoryCache({
  invalidationWindow = 10 * 60 * 1000,
  now = Date.now,
  sweepInterval = 1000,
}: CreateMemoryCacheOpts = {}): MemoryCache {
  const values = new Map<string, Expiring<string>>();
  const sets = new Map<string, Expiring<Map<string, number>>>();
  const markers = new Map<string, Expiring<number>>();
  const claims = new Map<string, Expiring<number>>();
  let epoch = 0;

  function live<T>(map: Map<string, Expiring<T>>, key: string): T | undefined {
    const entry = map.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function liveMembers(key: string): Map<string, number> | undefined {
    const members = live(sets, key);
    if (!members) {
      return undefined;
    }
    const t = now();
    for (const [member, expiresAt] of members) {
      if (expiresAt <= t) {
        members.delete(member);
      }
    }
    if (members.size === 0) {
      sets.delete(key);
      return undefined;
    }
    return members;
  }

  // Entries expire lazily when read; sweep regularly so that entries that
  // are never read again don't accumulate.
  let writes = 0;

  function sweep() {
    for (const map of [values, markers, claims] as Map<
      string,
      Expiring<unknown>
    >[]) {
      for (const key of Array.from(map.keys())) {
        live(map, key);
      }
    }
    for (const key of Array.from(sets.keys())) {
      liveMembers(key);
    }
  }

  function countWrite() {
    if (++writes % sweepInterval === 0) {
      sweep();
    }
  }

  function deleteKey(key: string) {
    values.delete(key);
    sets.delete(key);
  }

  const mutations: CacheMutations = {
    async addMembersToSet(
      key,
      membersWithTtls,
      options: AddMembersOptions = {},
    ) {
      countWrite();
      const { guard, onlyNew = false } = options;

      if (guard) {
        for (const marker of guard.markers) {
          const invalidatedAt = live(markers, marker);
          if (invalidatedAt !== undefined && invalidatedAt > guard.epoch) {
            return;
          }
        }
      }

      const t = now();
      const members = liveMembers(key) ?? new Map<string, number>();

      for (const [member, ttl] of membersWithTtls) {
        if (!(ttl > 0)) {
          throw new CacheValidationError(
            `Member TTL must be positive, got ${ttl}`,
          );
        }
        const expiresAt = t + ttl;
        const current = members.get(member);
        if (current === undefined) {
          members.set(member, expiresAt);
        } else if (!onlyNew && expiresAt > current) {
          members.set(member, expiresAt);
        }
      }

      if (members.size === 0) {
        return;
      }

      sets.set(key, {
        expiresAt: Math.max(...members.values()),
        value: members,
      });
    },
    async clear(keys) {
      for (const key of keys) {
        deleteKey(key);
      }
    },
    async removeMembersFromSet(key, members) {
      const set = liveMembers(key);
      if (!set) {
        return;
      }
      for (const member of members) {
        set.delete(member);
      }
      if (set.size === 0) {
        sets.delete(key);
      }
    },
    async set(key, data, ttl) {
      if (!(ttl > 0)) {
        throw new CacheValidationError(`TTL must be positive, got ${ttl}`);
      }
      countWrite();
      values.set(key, { expiresAt: now() + ttl, value: data });
    },
  };

  return {
    ...mutations,
    async exists(key) {
      return live(values, key) !== undefined || liveMembers(key) !== undefined;
    },
    async get(key) {
      return live(values, key) ?? null;
    },
    async getEpoch() {
      return epoch;
    },
    getPipe(condition?: StoreCondition) {
      if (condition && !(condition.ttl > 0)) {
        throw new CacheValidationError(
          `Condition TTL must be positive, got ${condition.ttl}`,
        );
      }
      const queue: (() => Promise<void>)[] = [];
      const queued = Object.fromEntries(
        Object.entries(mutations).map(([name, fn]) => [
          name,
          async (...args: unknown[]) => {
            queue.push(() =>
              (fn as (...a: unknown[]) => Promise<void>)(...args),
            );
          },
        ]),
      ) as unknown as CacheMutations;

      return {
        ...queued,
        async execute() {
          if (condition) {
            const claimed = live(claims, condition.key);
            if (claimed !== undefined && claimed > condition.epoch) {
              queue.length = 0;
              return;
            }
            claims.set(condition.key, {
              expiresAt: now() + condition.ttl,
              value: condition.epoch,
            });
          }
          // The operations have no await points, so starting them all in the
          // same tick applies them atomically.
          await Promise.all(queue.splice(0).map((op) => op()));
        },
      };
    },
    async getSetMembers(key) {
      return Array.from(liveMembers(key)?.keys() ?? []);
    },
    get size() {
      return values.size + sets.size + markers.size + claims.size;
    },
    async invalidate({
      keys,
      markers: markerKeys,
      indexes = [],
    }: InvalidateParameter) {
      epoch += 1;
      const expiresAt = now() + invalidationWindow;
      for (const marker of markerKeys) {
        markers.set(marker, { expiresAt, value: epoch });
      }
      for (const index of indexes) {
        for (const member of liveMembers(index)?.keys() ?? []) {
          deleteKey(member);
        }
        deleteKey(index);
      }
      for (const key of keys) {
        deleteKey(key);
      }
    },
    async isSetMember(key, member) {
      return liveMembers(key)?.has(member) ?? false;
    },
  };
}
