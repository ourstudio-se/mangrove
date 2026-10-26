import {
  AddMembersOptions,
  Cache,
  CacheMutations,
  CachePipe,
  InvalidateParameter,
  MaybePromise,
} from "../typings.js";
import DataLoader from "dataloader";
import type * as Redis from "ioredis";
import { CacheValidationError } from "./errors.js";

export type TextStream = string | Buffer;

export interface CreateRedisCacheOpts {
  /**
   * Store set members in sorted sets, which lets every member expire on its
   * own (needed for per-entity TTLs). With plain sets, a set and all of its
   * members live as long as the longest-lived member. Don't switch between
   * modes on a populated database.
   */
  allowDistinctMemberTTLs?: boolean;
  client: Redis.Redis;
  compression?: (data: string) => MaybePromise<TextStream>;
  decompression?: (data: Buffer) => MaybePromise<string>;
  /**
   * How long (ms) invalidations are remembered for, to reject results of
   * requests that started before them. Must exceed the longest request.
   */
  invalidationWindow?: number;
  /** Prefix for every key written by Mangrove. */
  keyPrefix?: string;
}

/*
 * KEYS[1]     set key
 * KEYS[2..]   invalidation marker keys
 * ARGV[1]     guard epoch, or "" for no guard
 * ARGV[2]     now (ms)
 * ARGV[3]     "z" (sorted set) or "s" (set)
 * ARGV[4]     "1" to only add new members, "0" to also extend existing ones
 * ARGV[5..]   expiresAt, member pairs
 */
const ADD_MEMBERS_SCRIPT = `
local guard = ARGV[1]
if guard ~= "" then
  local epoch = tonumber(guard)
  for i = 2, #KEYS do
    local invalidatedAt = redis.call("GET", KEYS[i])
    if invalidatedAt and tonumber(invalidatedAt) > epoch then
      return 0
    end
  end
end
local key = KEYS[1]
local now = tonumber(ARGV[2])
local sorted = ARGV[3] == "z"
local onlyNew = ARGV[4] == "1"
local maxExpiresAt = 0
if sorted then
  redis.call("ZREMRANGEBYSCORE", key, "-inf", now)
end
for i = 5, #ARGV, 2 do
  local expiresAt = tonumber(ARGV[i])
  local member = ARGV[i + 1]
  if sorted then
    local current = redis.call("ZSCORE", key, member)
    if not current then
      redis.call("ZADD", key, expiresAt, member)
    elseif not onlyNew and tonumber(current) < expiresAt then
      redis.call("ZADD", key, expiresAt, member)
    end
  else
    redis.call("SADD", key, member)
  end
  if expiresAt > maxExpiresAt then
    maxExpiresAt = expiresAt
  end
end
local pttl = redis.call("PTTL", key)
if pttl == -2 then
  return 1
end
if pttl < 0 or now + pttl < maxExpiresAt then
  redis.call("PEXPIREAT", key, maxExpiresAt)
end
return 1
`;

/*
 * KEYS[1]                epoch key
 * KEYS[2..ARGV[1]+1]     invalidation marker keys
 * KEYS[ARGV[1]+2..]      keys to delete
 * ARGV[1]                number of marker keys
 * ARGV[2]                marker TTL (ms)
 * ARGV[3]                key prefix
 * ARGV[4]                number of index keys (the last keys to delete)
 */
const INVALIDATE_SCRIPT = `
local epoch = redis.call("INCR", KEYS[1])
local markerCount = tonumber(ARGV[1])
for i = 2, markerCount + 1 do
  redis.call("SET", KEYS[i], epoch, "PX", ARGV[2])
end
local indexCount = tonumber(ARGV[4])
local firstIndex = #KEYS - indexCount + 1
for i = firstIndex, #KEYS do
  local kind = redis.call("TYPE", KEYS[i])["ok"]
  local members
  if kind == "zset" then
    members = redis.call("ZRANGE", KEYS[i], 0, -1)
  elseif kind == "set" then
    members = redis.call("SMEMBERS", KEYS[i])
  else
    members = {}
  end
  for _, member in ipairs(members) do
    redis.call("DEL", ARGV[3] .. member)
  end
end
for i = markerCount + 2, #KEYS do
  redis.call("DEL", KEYS[i])
end
return epoch
`;

const ADD_MEMBERS_COMMAND = "mangroveAddMembers";
const INVALIDATE_COMMAND = "mangroveInvalidate";

type CommandClient = Redis.Redis | Redis.ChainableCommander;

type ScriptCommand = (
  this: CommandClient,
  numKeys: number,
  ...args: (string | number)[]
) => unknown;

function defineScripts(client: Redis.Redis) {
  const commands = client as unknown as Record<string, unknown>;
  if (typeof commands[ADD_MEMBERS_COMMAND] !== "function") {
    client.defineCommand(ADD_MEMBERS_COMMAND, { lua: ADD_MEMBERS_SCRIPT });
  }
  if (typeof commands[INVALIDATE_COMMAND] !== "function") {
    client.defineCommand(INVALIDATE_COMMAND, { lua: INVALIDATE_SCRIPT });
  }
}

function callScript(
  operator: CommandClient,
  command: string,
  keys: string[],
  args: (string | number)[],
) {
  const fn = (operator as unknown as Record<string, ScriptCommand>)[command];
  return fn.call(operator, keys.length, ...keys, ...args);
}

type ReadInstruction =
  | { args: [string]; method: "getBuffer" | "get" | "smembers" | "exists" }
  | { args: [string, string]; method: "zscore" | "sismember" }
  | { args: [string, number, string]; method: "zrangebyscore" };

/**
 * Batches the reads issued within the same tick into a single pipeline.
 */
function createReadLoader(client: Redis.Redis) {
  return new DataLoader<ReadInstruction, unknown>(
    async (instructions) => {
      const pipeline = client.pipeline();

      for (const { method, args } of instructions) {
        (pipeline as unknown as Record<string, (...a: unknown[]) => unknown>)[
          method
        ](...args);
      }

      const results = await pipeline.exec();

      if (results === null) {
        throw new Error("Redis pipeline execution failed");
      }

      return results.map(([err, data]) => err ?? data);
    },
    { cache: false },
  );
}

async function assertPipelineSucceeded(
  execution: Promise<[Error | null, unknown][] | null>,
) {
  const results = await execution;

  if (results === null) {
    throw new Error("Redis transaction was aborted");
  }

  const errors = results.flatMap(([err]) => (err ? [err] : []));

  if (errors.length > 0) {
    throw errors[0];
  }
}

export const createRedisCache = ({
  allowDistinctMemberTTLs = true,
  compression = (data) => data,
  client,
  decompression = (data) => data.toString(),
  invalidationWindow = 10 * 60 * 1000,
  keyPrefix = "",
}: CreateRedisCacheOpts): Cache => {
  defineScripts(client);

  const loader = createReadLoader(client);
  const k = (key: string) => `${keyPrefix}${key}`;
  const epochKey = k("mangrove:epoch");
  const markerKey = (marker: string) => k(`mangrove:invalidated:${marker}`);

  function queueMutations(operator: Redis.ChainableCommander): CacheMutations {
    return {
      async addMembersToSet(
        key,
        membersWithTtls,
        options: AddMembersOptions = {},
      ) {
        const { guard, onlyNew = false } = options;
        const now = Date.now();
        const pairs: (string | number)[] = [];

        for (const [member, ttl] of membersWithTtls) {
          if (!(ttl > 0)) {
            throw new CacheValidationError(
              `Member TTL must be positive, got ${ttl}`,
            );
          }
          pairs.push(Math.ceil(now + ttl), member);
        }

        if (pairs.length === 0) {
          return;
        }

        callScript(
          operator,
          ADD_MEMBERS_COMMAND,
          [k(key), ...(guard?.markers ?? []).map(markerKey)],
          [
            guard ? guard.epoch : "",
            now,
            allowDistinctMemberTTLs ? "z" : "s",
            onlyNew ? "1" : "0",
            ...pairs,
          ],
        );
      },
      async clear(keys) {
        const prefixed = Array.from(keys, k);
        if (prefixed.length > 0) {
          operator.del(...prefixed);
        }
      },
      async removeMembersFromSet(key, members) {
        const list = Array.from(members);
        if (list.length === 0) {
          return;
        }
        if (allowDistinctMemberTTLs) {
          operator.zrem(k(key), ...list);
        } else {
          operator.srem(k(key), ...list);
        }
      },
      async set(key, data, ttl) {
        if (!(ttl > 0)) {
          throw new CacheValidationError(`TTL must be positive, got ${ttl}`);
        }
        const compressed = await compression(data);
        operator.set(k(key), compressed, "PX", Math.ceil(ttl));
      },
    };
  }

  function createPipe(): CachePipe {
    const transaction = client.multi();
    const queued = queueMutations(transaction);
    // Compression may be asynchronous; make sure every operation has been
    // queued before the transaction is sent.
    const pending: Promise<void>[] = [];

    const track =
      <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
      (...args: A) => {
        const promise = fn(...args);
        pending.push(promise);
        return promise;
      };

    return {
      addMembersToSet: track(queued.addMembersToSet),
      clear: track(queued.clear),
      async execute() {
        await Promise.all(pending);
        await assertPipelineSucceeded(transaction.exec());
      },
      removeMembersFromSet: track(queued.removeMembersFromSet),
      set: track(queued.set),
    };
  }

  const singleMutation =
    <A extends unknown[]>(
      pick: (pipe: CachePipe) => (...args: A) => Promise<void>,
    ) =>
    async (...args: A) => {
      const pipe = createPipe();
      await pick(pipe)(...args);
      await pipe.execute();
    };

  const read = <T>(instruction: ReadInstruction) =>
    loader.load(instruction).then((result) => {
      if (result instanceof Error) {
        throw result;
      }
      return result as T;
    });

  return {
    addMembersToSet: singleMutation((pipe) => pipe.addMembersToSet),
    clear: singleMutation((pipe) => pipe.clear),
    async exists(key) {
      const count = await read<number>({ args: [k(key)], method: "exists" });
      return count === 1;
    },
    async get(key) {
      const result = await read<Buffer | null>({
        args: [k(key)],
        method: "getBuffer",
      });
      return result ? decompression(result) : null;
    },
    async getEpoch() {
      const result = await read<string | null>({
        args: [epochKey],
        method: "get",
      });
      return result === null ? 0 : Number(result);
    },
    getPipe: createPipe,
    async getSetMembers(key) {
      if (allowDistinctMemberTTLs) {
        return read<string[]>({
          args: [k(key), Date.now() + 1, "+inf"],
          method: "zrangebyscore",
        });
      }
      return read<string[]>({ args: [k(key)], method: "smembers" });
    },
    async invalidate({ keys, markers, indexes = [] }: InvalidateParameter) {
      const markerKeys = Array.from(markers, markerKey);
      const indexKeys = Array.from(indexes, k);
      const deleteKeys = [...Array.from(keys, k), ...indexKeys];

      await callScript(
        client,
        INVALIDATE_COMMAND,
        [epochKey, ...markerKeys, ...deleteKeys],
        [markerKeys.length, invalidationWindow, keyPrefix, indexKeys.length],
      );
    },
    async isSetMember(key, member) {
      if (allowDistinctMemberTTLs) {
        const score = await read<string | null>({
          args: [k(key), member],
          method: "zscore",
        });
        return score !== null && Number(score) > Date.now();
      }
      const isMember = await read<number>({
        args: [k(key), member],
        method: "sismember",
      });
      return isMember === 1;
    },
    removeMembersFromSet: singleMutation((pipe) => pipe.removeMembersFromSet),
    set: singleMutation((pipe) => pipe.set),
  };
};
