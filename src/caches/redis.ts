import {
  AddMembersOptions,
  Cache,
  CacheMutations,
  CachePipe,
  InvalidateParameter,
  MaybePromise,
  StoreCondition,
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
 * Writes in a conditional pipe only apply if the pipe's claim succeeded,
 * i.e. if the condition key still holds the pipe's epoch.
 *
 * KEYS[1]     condition key
 * ARGV[1]     epoch, or "" for unconditional writes
 */
const CONDITION_CHECK = `
if ARGV[1] ~= "" and redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
`;

/*
 * KEYS[1]     condition key
 * ARGV[1]     epoch
 * ARGV[2]     TTL (ms)
 */
const CLAIM_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current and tonumber(current) > tonumber(ARGV[1]) then
  return 0
end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
return 1
`;

/*
 * KEYS[1]     condition key
 * KEYS[2]     key
 * ARGV[1]     condition epoch, or ""
 * ARGV[2]     "set", "del" or "rem"
 * ARGV[3]     value (set), or "z"/"s" (rem)
 * ARGV[4..]   TTL in ms (set), or members (rem)
 */
const WRITE_SCRIPT = `${CONDITION_CHECK}
if ARGV[2] == "set" then
  redis.call("SET", KEYS[2], ARGV[3], "PX", ARGV[4])
elseif ARGV[2] == "rem" then
  for i = 4, #ARGV do
    if ARGV[3] == "z" then
      redis.call("ZREM", KEYS[2], ARGV[i])
    else
      redis.call("SREM", KEYS[2], ARGV[i])
    end
  end
else
  redis.call("DEL", KEYS[2])
end
return 1
`;

/*
 * KEYS[1]     condition key
 * KEYS[2]     set key
 * KEYS[3..]   invalidation marker keys
 * ARGV[1]     condition epoch, or ""
 * ARGV[2]     guard epoch, or "" for no guard
 * ARGV[3]     now (ms)
 * ARGV[4]     "z" (sorted set) or "s" (set)
 * ARGV[5]     "1" to only add new members, "0" to also extend existing ones
 * ARGV[6..]   expiresAt, member pairs
 */
const ADD_MEMBERS_SCRIPT = `${CONDITION_CHECK}
local guard = ARGV[2]
if guard ~= "" then
  local epoch = tonumber(guard)
  for i = 3, #KEYS do
    local invalidatedAt = redis.call("GET", KEYS[i])
    if invalidatedAt and tonumber(invalidatedAt) > epoch then
      return 0
    end
  end
end
local key = KEYS[2]
local now = tonumber(ARGV[3])
local sorted = ARGV[4] == "z"
local onlyNew = ARGV[5] == "1"
local maxExpiresAt = 0
if sorted then
  redis.call("ZREMRANGEBYSCORE", key, "-inf", now)
end
for i = 6, #ARGV, 2 do
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

const SCRIPTS = {
  mangroveAddMembers: ADD_MEMBERS_SCRIPT,
  mangroveClaim: CLAIM_SCRIPT,
  mangroveInvalidate: INVALIDATE_SCRIPT,
  mangroveWrite: WRITE_SCRIPT,
};

const ADD_MEMBERS_COMMAND = "mangroveAddMembers";
const CLAIM_COMMAND = "mangroveClaim";
const INVALIDATE_COMMAND = "mangroveInvalidate";
const WRITE_COMMAND = "mangroveWrite";

type CommandClient = Redis.Redis | Redis.ChainableCommander;

type ScriptArgument = string | number | Buffer;

type ScriptCommand = (
  this: CommandClient,
  numKeys: number,
  ...args: ScriptArgument[]
) => unknown;

function defineScripts(client: Redis.Redis) {
  const commands = client as unknown as Record<string, unknown>;
  for (const [name, lua] of Object.entries(SCRIPTS)) {
    if (typeof commands[name] !== "function") {
      client.defineCommand(name, { lua });
    }
  }
}

function callScript(
  operator: CommandClient,
  command: string,
  keys: string[],
  args: ScriptArgument[],
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
  // GraphQL type names can't start with ":", so entity keys can't collide
  // with internal keys.
  const epochKey = k(":mangrove:epoch");
  const markerKey = (marker: string) => k(`:mangrove:invalidated:${marker}`);

  type Operation = (operator: Redis.ChainableCommander) => void;

  /**
   * Turns mutations into operations on a transaction. Every write is a
   * script, so that it can be made conditional, and so that a transaction
   * failing on a missing script applies nothing.
   */
  function recordMutations(
    record: (operation: Operation) => void,
    condition?: StoreCondition,
  ): CacheMutations {
    // Unconditional writes still need a key in the first slot.
    const conditionKey = condition ? k(condition.key) : epochKey;
    const conditionEpoch = condition ? condition.epoch : "";

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

        const keys = [
          conditionKey,
          k(key),
          ...(guard?.markers ?? []).map(markerKey),
        ];
        const args = [
          conditionEpoch,
          guard ? guard.epoch : "",
          now,
          allowDistinctMemberTTLs ? "z" : "s",
          onlyNew ? "1" : "0",
          ...pairs,
        ];

        record((operator) =>
          callScript(operator, ADD_MEMBERS_COMMAND, keys, args),
        );
      },
      async clear(keys) {
        for (const key of keys) {
          const prefixed = k(key);
          record((operator) =>
            callScript(
              operator,
              WRITE_COMMAND,
              [conditionKey, prefixed],
              [conditionEpoch, "del"],
            ),
          );
        }
      },
      async removeMembersFromSet(key, members) {
        const list = Array.from(members);
        if (list.length === 0) {
          return;
        }
        const prefixed = k(key);
        record((operator) =>
          callScript(
            operator,
            WRITE_COMMAND,
            [conditionKey, prefixed],
            [
              conditionEpoch,
              "rem",
              allowDistinctMemberTTLs ? "z" : "s",
              ...list,
            ],
          ),
        );
      },
      async set(key, data, ttl) {
        if (!(ttl > 0)) {
          throw new CacheValidationError(`TTL must be positive, got ${ttl}`);
        }
        const compressed = await compression(data);
        const prefixed = k(key);
        record((operator) =>
          callScript(
            operator,
            WRITE_COMMAND,
            [conditionKey, prefixed],
            [conditionEpoch, "set", compressed, Math.ceil(ttl)],
          ),
        );
      },
    };
  }

  async function loadScripts() {
    await Promise.all(
      Object.values(SCRIPTS).map((lua) => client.script("LOAD", lua)),
    );
  }

  function createPipe(condition?: StoreCondition): CachePipe {
    if (condition && !(condition.ttl > 0)) {
      throw new CacheValidationError(
        `Condition TTL must be positive, got ${condition.ttl}`,
      );
    }

    const operations: Operation[] = [];
    const recorded = recordMutations(
      (operation) => operations.push(operation),
      condition,
    );
    // Compression may be asynchronous; make sure every operation has been
    // recorded before the transaction is sent.
    const pending: Promise<void>[] = [];

    const track =
      <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
      (...args: A) => {
        const promise = fn(...args);
        pending.push(promise);
        return promise;
      };

    function exec() {
      const transaction = client.multi();
      if (condition) {
        callScript(
          transaction,
          CLAIM_COMMAND,
          [k(condition.key)],
          [condition.epoch, Math.ceil(condition.ttl)],
        );
      }
      for (const operation of operations) {
        operation(transaction);
      }
      return assertPipelineSucceeded(transaction.exec());
    }

    return {
      addMembersToSet: track(recorded.addMembersToSet),
      clear: track(recorded.clear),
      async execute() {
        await Promise.all(pending);
        try {
          await exec();
        } catch (err) {
          // Scripts can disappear (SCRIPT FLUSH, failover). Nothing was
          // applied, as every write is a script: load them and retry.
          if (!(err instanceof Error) || !err.message.includes("NOSCRIPT")) {
            throw err;
          }
          await loadScripts();
          await exec();
        }
      },
      removeMembersFromSet: track(recorded.removeMembersFromSet),
      set: track(recorded.set),
    };
  }

  const singleMutation =
    <A extends unknown[]>(
      pick: (pipe: CachePipe) => (...args: A) => Promise<void>,
    ) =>
    async (...args: A) => {
      const pipe = createPipe(undefined);
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
