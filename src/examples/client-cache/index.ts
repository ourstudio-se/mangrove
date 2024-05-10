import * as readline from "node:readline/promises";
import { CacheResolverMap } from "../../typings";
import { Redis } from "ioredis";
import { ZlibOptions, deflate, inflate } from "node:zlib";
import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { createRedisCache } from "../../caches/redis";
import { eagerInvalidationStrategy } from "../../invalidationStrategies/eagerInvalidationStrategy";
import { gql } from "../../utils";
import { isPromise } from "../../borrowedTools/isPromise";
import { lazyInvalidationStrategy } from "../../invalidationStrategies/lazyInvalidationStrategy";
import { makeExecutorWrapper } from "../../runner";
import { makeResultFormatter } from "../../resultFormatter";
import { makeResultProcessor } from "../../resultProcessor";
import { parse } from "graphql";
import { parseClientQuery } from "../../parser";
import { pipe } from "fp-ts/lib/function";
import { promisify } from "node:util";
import type { Executor } from "@graphql-tools/utils";

const ttl =
  process.env.TTL !== undefined ? parseInt(process.env.TTL) : 60 * 60 * 1000;
const strategy = process.env.STRATEGY ?? "eager";
const useCompression = process.env.USE_COMPRESSION === "true";
const debugMode = process.env.VSCODE_DEBUG_MODE === "true";

const cacheResolvers: CacheResolverMap = {
  Launch: {
    batch: false,
    idArg: "id",
    rootField: "launch",
    type: "string",
  },
  Rocket: {
    batch: false,
    idArg: "id",
    rootField: "rocket",
    type: "string",
  },
};

const document = parseClientQuery(
  parse(gql`
    fragment Launch on Launch {
      id @idField
      details
      is_tentative
      launch_date_local
      launch_date_unix
      launch_date_utc
      launch_success
      rocket {
        rocket {
          id @idField
          active
          boosters
          company
          cost_per_launch
          country
          description
          first_flight
          name
          stages
          success_rate_pct
          type
          wikipedia
        }
      }
      mission_id
      mission_name
      static_fire_date_unix
      static_fire_date_utc
      tentative_max_precision
      upcoming
    }

    query {
      launches {
        ...Launch
      }
    }
  `),
);

const sessionId = (Math.random() * 1000).toString();
function session() {
  return sessionId;
}

function rollCompression(props: ZlibOptions & { useCompression: boolean }) {
  if (!props.useCompression) {
    return {};
  }
  const pdeflate = promisify(deflate);
  const pinflate = promisify(inflate);

  return {
    compression: (data: string) => pdeflate(data, props),
    decompression: async (data: Buffer) => {
      const data_1 = await pinflate(data, props);
      return data_1.toString();
    },
  };
}

function getInvalidationStrategy() {
  const cache = createRedisCache({
    client: new Redis(),
    ...rollCompression({ chunkSize: 1000, useCompression }),
  });
  if (strategy === "eager") {
    return eagerInvalidationStrategy({
      cache,
      resolvers: cacheResolvers,
      ttl,
    });
  }
  return lazyInvalidationStrategy({ cache });
}

const { getPartialExecutionOpts, invalidateEntities, storeExecutionResult } =
  getInvalidationStrategy();

const processResult = makeResultProcessor({
  awaitWriteBeforeResponse: debugMode,
  storeExecutionResult,
  ttl,
});

const wrapExecutor = makeExecutorWrapper({
  cacheResolvers,
  formatResult: makeResultFormatter({ includeExtensionMetadata: true, ttl }),
  getPartialExecutionOpts,
  processResult,
  session,
});

function printLatency(latencyDiff: number | null) {
  if (latencyDiff === null) {
    return "N/A";
  }
  if (latencyDiff > 0) {
    return `+${latencyDiff.toString()}ms`;
  }
  if (latencyDiff === 0) {
    return "+/- 0ms";
  }
  return `${latencyDiff.toString()}ms`;
}

let latencyHist: number | null = null;
function logLatency(label: string, latency: number, nomem = false) {
  if (nomem) {
    latencyHist = null;
  }
  const latencyDiff = latencyHist !== null ? latency - latencyHist : null;
  // eslint-disable-next-line no-console
  console.log(
    `[${label}] ${latency.toString()}ms [${printLatency(latencyDiff)}]`,
  );
  latencyHist = latency;
}

function debugLatency(label: string, nomem = false) {
  return (executor: Executor): Executor => {
    return async (request) => {
      const startTime = Date.now();
      const resultOrPromise = executor(request);

      if (!isPromise(resultOrPromise)) {
        throw new Error("Non-promise execution case not supported");
      }

      const result_2 = await resultOrPromise;
      const endTime = Date.now();
      logLatency(label, endTime - startTime, nomem);
      return result_2;
    };
  };
}

const executor = pipe(
  buildHTTPExecutor({
    endpoint: "https://spacex-production.up.railway.app/",
  }),
  debugLatency("Inner execution time", true),
  wrapExecutor,
  debugLatency("Outer execution time"),
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function awaitQuestion(question: string) {
  if (debugMode) {
    return;
  }

  await rl.question(question);
}

(async () => {
  await awaitQuestion("Trigger request #1 [Enter]");

  let result = await executor({
    document,
  });

  // eslint-disable-next-line no-console
  console.log(result);
  await awaitQuestion("Trigger invalidation #1 [Enter]");

  const then = Date.now();
  await invalidateEntities([
    {
      id: "5eb87cd9ffd86e000604b32a",
      typename: "Launch",
    },
  ]);
  const now = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[Invalidation time] ${now - then}ms`);

  await awaitQuestion("Trigger request #2 [Enter]");

  result = await executor({
    document,
  });

  // eslint-disable-next-line no-console
  console.log(result);
  await awaitQuestion("Trigger invalidation #2 [Enter]");

  const then2 = Date.now();
  await invalidateEntities([
    {
      id: "5e9d0d95eda69973a809d1ec",
      typename: "Rocket",
    },
  ]);
  const now2 = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[Invalidation time] ${now2 - then2}ms`);

  await awaitQuestion("Trigger request #3 [Enter]");

  result = await executor({
    document,
  });
  result;

  // eslint-disable-next-line no-console
  console.log(result);

  process.exit(0);
})();
