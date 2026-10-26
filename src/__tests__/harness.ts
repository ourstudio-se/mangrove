/* eslint-disable @typescript-eslint/no-explicit-any */
import { Cache, CachedExecutionResult, Logger } from "../typings.js";
import {
  DocumentNode,
  ExecutionArgs,
  execute,
  parse,
  print,
  validate,
} from "graphql";
import { ChildProcess, spawn } from "node:child_process";
import { Redis } from "ioredis";
import { createMemoryCache } from "../caches/memory.js";
import { createRedisCache } from "../caches/redis.js";
import { lazyInvalidationStrategy } from "../invalidationStrategies/lazyInvalidationStrategy.js";
import { makeBySchemaConfigGenerator } from "../schemaConfig.js";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { makeExecuteWrapper } from "../runner.js";
import { makeResultFormatter } from "../resultFormatter.js";
import { makeResultProcessor } from "../resultProcessor.js";

export const DIRECTIVES = /* GraphQL */ `
  directive @cacheResolver(keyArg: String) on FIELD_DEFINITION
  directive @cacheEntity(ttl: Int) on OBJECT
`;

export class RecordingLogger implements Logger {
  errors: unknown[][] = [];

  warnings: unknown[][] = [];

  error(...payload: unknown[]) {
    this.errors.push(payload);
  }

  warn(...payload: unknown[]) {
    this.warnings.push(payload);
  }
}

export interface HarnessOptions {
  cache: Cache;
  enabled?: (context: unknown) => boolean;
  entityTtls?: Record<string, number>;
  resolvers: any;
  ttl?: number;
  typeDefs: string;
}

export interface RunOptions {
  operationName?: string;
  variables?: Record<string, unknown>;
}

export interface RunResult {
  /** Every document executed against the schema, printed. */
  executed: string[];
  result: CachedExecutionResult;
}

/**
 * A schema wrapped by Mangrove. Every document Mangrove executes is
 * validated against the schema first, so generated documents must be valid.
 */
export function createHarness({
  cache,
  enabled,
  entityTtls = {},
  resolvers,
  ttl = 60_000,
  typeDefs,
}: HarnessOptions) {
  const schema = makeExecutableSchema({
    resolvers,
    typeDefs: [DIRECTIVES, typeDefs],
  });
  const logger = new RecordingLogger();
  const config = makeBySchemaConfigGenerator({
    idFields: new Set(["id"]),
    logger,
  })(schema);
  const strategy = lazyInvalidationStrategy({ cache, logger });

  const executed: string[] = [];

  const validatingExecute = ((args: ExecutionArgs) => {
    const errors = validate(schema, args.document);
    if (errors.length > 0) {
      throw new Error(
        `Mangrove executed an invalid document:\n${print(args.document)}\n${errors
          .map((e) => e.message)
          .join("\n")}`,
      );
    }
    executed.push(print(args.document));
    return execute(args);
  }) as typeof execute;

  const wrapped = makeExecuteWrapper({
    ...config,
    enabled,
    formatResult: makeResultFormatter({ includeExtensionMetadata: true, ttl }),
    getPartialExecutionOpts: strategy.getPartialExecutionOpts,
    logger,
    processResult: makeResultProcessor({
      awaitWriteBeforeResponse: true,
      entityTtls: { ...config.entityTtls, ...entityTtls },
      logger,
      storeExecutionResult: strategy.storeExecutionResult,
      ttl,
    }),
    session: () => "session",
  })(validatingExecute);

  async function run(
    query: string | DocumentNode,
    { operationName, variables }: RunOptions = {},
  ): Promise<RunResult> {
    executed.length = 0;
    const document = config.parser(
      typeof query === "string" ? parse(query) : query,
    );
    const result = (await wrapped({
      document,
      operationName,
      schema,
      variableValues: variables,
    })) as CachedExecutionResult;
    return { executed: [...executed], result };
  }

  return { config, logger, run, schema, strategy };
}

export type CacheFactory = () => Promise<Cache>;

let redisProcess: ChildProcess | undefined;
let redisClients: Redis[] = [];

/** Finds a Redis to test against: REDIS_URL, or a local redis-server binary. */
export async function startRedis(): Promise<string | undefined> {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }

  const port = 20000 + Math.floor(Math.random() * 20000);

  try {
    redisProcess = spawn(
      "redis-server",
      ["--port", String(port), "--save", "", "--appendonly", "no"],
      { stdio: "ignore" },
    );
  } catch {
    return undefined;
  }

  const failed = await new Promise<boolean>((resolve) => {
    redisProcess!.once("error", () => resolve(true));
    setTimeout(() => resolve(false), 300);
  });

  if (failed) {
    redisProcess = undefined;
    return undefined;
  }

  return `redis://127.0.0.1:${port}`;
}

export function createRedisClient(url: string) {
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
  });
  redisClients.push(client);
  return client;
}

export async function stopRedis() {
  await Promise.all(
    redisClients.map((client) => client.quit().catch(() => {})),
  );
  redisClients = [];
  redisProcess?.kill();
  redisProcess = undefined;
}

export const memoryCacheFactory: CacheFactory = async () => createMemoryCache();

export function redisCacheFactory(url: string): CacheFactory {
  return async () => {
    const client = createRedisClient(url);
    await client.flushall();
    return createRedisCache({ client });
  };
}
