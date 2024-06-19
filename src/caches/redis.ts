import DataLoader from "dataloader";
import type * as Redis from "ioredis";
import { Cache, CacheMutations, MaybePromise } from "../typings";
import { CacheValidationError } from "./errors.js";
import { isPromise } from "../borrowedTools/isPromise.js";

function makeTTLOffset(ttl: number, now: number) {
  return now + ttl;
}

export type TextStream = string | Buffer;
export interface CreateRedisCacheOpts {
  allowDistinctMemberTTLs?: boolean;
  client: Redis.Redis;
  compression?: (data: string) => MaybePromise<TextStream>;
  decompression?: (data: Buffer) => MaybePromise<string>;
}

function isPipeline(
  client: Redis.Redis | Redis.ChainableCommander,
): client is Redis.ChainableCommander {
  return !("pipeline" in client);
}

enum PipeOp {
  GET,
  KEYS,
  EXISTS,
  ZRANGEBYSCORE,
  SMEMBERS,
}

type PipeInstruction =
  | {
      op: PipeOp.GET;
      operand: Redis.RedisKey;
    }
  | {
      op: PipeOp.KEYS;
      operand: string;
    }
  | {
      op: PipeOp.EXISTS;
      operand: Redis.RedisKey[];
    }
  | {
      op: PipeOp.ZRANGEBYSCORE;
      operand: [Redis.RedisKey, number | string, number | string];
    }
  | {
      op: PipeOp.SMEMBERS;
      operand: Redis.RedisKey;
    };

interface PipeReturnTypes {
  [PipeOp.EXISTS]: number[];
  [PipeOp.GET]: Buffer | null;
  [PipeOp.KEYS]: string[];
  [PipeOp.SMEMBERS]: string[];
  [PipeOp.ZRANGEBYSCORE]: string[];
}

function pipeInstructionKey(i: PipeInstruction) {
  switch (i.op) {
    case PipeOp.SMEMBERS:
    case PipeOp.GET:
    case PipeOp.KEYS:
      return `${i.op}:${i.operand.toString()}`;
    case PipeOp.EXISTS:
    case PipeOp.ZRANGEBYSCORE:
      return `${i.op}:${(i.operand as (Redis.RedisKey | string | number)[]).map((o) => o.toString()).join(",")}`;
  }
}

function interpretPipelineInstruction(
  operator: Redis.Redis | Redis.ChainableCommander,
  instruction: PipeInstruction,
): Promise<unknown> | null {
  let res: Promise<unknown> | Redis.ChainableCommander;
  switch (instruction.op) {
    case PipeOp.SMEMBERS:
      res = operator.smembers(instruction.operand);
      break;
    case PipeOp.ZRANGEBYSCORE:
      res = operator.zrangebyscore(...instruction.operand);
      break;
    case PipeOp.EXISTS:
      res = operator.exists(...instruction.operand);
      break;
    case PipeOp.KEYS:
      res = operator.keys(instruction.operand);
      break;
    case PipeOp.GET:
      res = operator.getBuffer(instruction.operand);
      break;
  }
  if (!isPromise(res)) {
    return null;
  }
  return res;
}

function createPipeLoader(
  client: Redis.Redis,
  decompression: (data: Buffer) => MaybePromise<string>,
) {
  const loader = new DataLoader<PipeInstruction, unknown, string>(
    async (instructions) => {
      const singleInstructionMode = instructions.length === 1;
      const operator: Redis.Redis | Redis.ChainableCommander =
        singleInstructionMode ? client : client.pipeline();

      if (singleInstructionMode) {
        loader.clearAll();
        return [interpretPipelineInstruction(operator, instructions[0])];
      }

      for (const i of instructions) {
        interpretPipelineInstruction(operator, i);
      }

      const result = await operator.exec();

      loader.clearAll();

      if (result === null) {
        throw new Error("Redis execution failed");
      }

      return result.map(([err, data]) => {
        return err ?? data;
      });
    },
    {
      cacheKeyFn: pipeInstructionKey,
    },
  );

  return {
    exists: async (...keys: Redis.RedisKey[]) => {
      return loader.load({
        op: PipeOp.EXISTS,
        operand: keys,
      }) as Promise<PipeReturnTypes[PipeOp.EXISTS]>;
    },
    get: async (key: Redis.RedisKey) => {
      const result = (await loader.load({
        op: PipeOp.GET,
        operand: key,
      })) as PipeReturnTypes[PipeOp.GET];
      return result ? decompression(result) : result;
    },
    keys: (pattern: string) => {
      return loader.load({
        op: PipeOp.KEYS,
        operand: pattern,
      }) as Promise<PipeReturnTypes[PipeOp.KEYS]>;
    },
    smembers: (key: Redis.RedisKey) => {
      return loader.load({
        op: PipeOp.SMEMBERS,
        operand: key,
      }) as Promise<PipeReturnTypes[PipeOp.SMEMBERS]>;
    },
    zrangebyscore: (
      key: Redis.RedisKey,
      min: number | string,
      max: number | string,
    ) => {
      return loader.load({
        op: PipeOp.ZRANGEBYSCORE,
        operand: [key, min, max],
      }) as Promise<PipeReturnTypes[PipeOp.ZRANGEBYSCORE]>;
    },
  };
}

async function addMembersToZset(
  client: Redis.Redis,
  operator: Redis.Redis | Redis.ChainableCommander,
  key: Redis.RedisKey,
  members: Iterable<[string, number]>,
) {
  const now = Date.now();
  const membersWithOffsets: (string | number)[] = [];

  let setExpiresAt: number = await client.pexpiretime(key);

  for (const [member, ttl] of members) {
    if (ttl < 0) {
      throw new CacheValidationError(
        "Can't handle sub-zero value for member expiration in redis cache",
      );
    }
    const expiresAt = makeTTLOffset(ttl, now);
    if (expiresAt > setExpiresAt) {
      setExpiresAt = expiresAt;
    }
    membersWithOffsets.push(expiresAt, member);
  }

  if (setExpiresAt < 0) {
    throw new CacheValidationError(
      "Can't handle sub-zero value for zset TTL in redis cache",
    );
  }

  await operator.zadd(key, ...membersWithOffsets);
  await operator.zremrangebyscore(key, "-inf", now);

  await operator.pexpireat(key, setExpiresAt);
}

async function addMembersToRegularSet(
  client: Redis.Redis,
  operator: Redis.Redis | Redis.ChainableCommander,
  key: Redis.RedisKey,
  members: Iterable<[string, number]>,
) {
  const memberKeys: string[] = [];
  const now = Date.now();

  let setExpiresAt = await client.pexpiretime(key);
  let setTtl = setExpiresAt - now;

  for (const [member, ttl] of members) {
    if (setTtl < 0 || ttl < setTtl) {
      setTtl = ttl;
    }
    memberKeys.push(member);
  }

  setExpiresAt = setTtl + now;

  if (setExpiresAt < 0) {
    throw new CacheValidationError(
      "Can't handle sub-zero value for set TTL in redis cache",
    );
  }

  await operator.sadd(key, ...memberKeys);
  await operator.pexpireat(key, setExpiresAt);
}

export const createRedisCache = ({
  allowDistinctMemberTTLs = true,
  compression = (data) => data,
  client,
  decompression = (data) => data.toString(),
}: CreateRedisCacheOpts): Cache => {
  function wrapActions(
    operator: Redis.Redis | Redis.ChainableCommander,
  ): CacheMutations {
    return {
      async addMembersToSet(key, members) {
        if (allowDistinctMemberTTLs) {
          return addMembersToZset(client, operator, key, members);
        } else {
          return addMembersToRegularSet(client, operator, key, members);
        }
      },
      async clear(keys) {
        await operator.del(...keys);
      },
      async removeMembersFromSet(key, members) {
        if (allowDistinctMemberTTLs) {
          await operator.zrem(key, ...members);
        } else {
          await operator.srem(key, ...members);
        }
      },
      async set(key, data, ttl) {
        const deferredCompression = compression(data);

        let compressedData: TextStream;

        if (isPromise(deferredCompression)) {
          compressedData = await deferredCompression;
        } else {
          compressedData = deferredCompression;
        }

        if (isPipeline(operator)) {
          operator.set(key, compressedData, "PX", ttl);
        } else {
          await operator.set(key, compressedData, "PX", ttl);
        }
      },
    };
  }

  const loader = createPipeLoader(client, decompression);

  return {
    ...wrapActions(client),
    async exists(key) {
      const [res] = await loader.exists(key);
      return res === 1;
    },
    get(key) {
      return loader.get(key);
    },
    getKeysStartingWith(startsWith) {
      return loader.keys(`${startsWith}*`);
    },
    getPipe() {
      const pipeline = client.pipeline();

      const mutations = wrapActions(pipeline);
      return {
        ...mutations,
        async execute() {
          await pipeline.exec();
        },
      };
    },
    async getSetMembers(key) {
      if (allowDistinctMemberTTLs) {
        const now = Date.now();
        return loader.zrangebyscore(key, now, "inf");
      }
      return loader.smembers(key);
    },
  };
};
