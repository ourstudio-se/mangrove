// Benchmarks a build of Mangrove against a real Redis.
//
//   node scripts/bench.mjs <path to lib/cjs> [redis url]
//
// Without a Redis URL, a redis-server is started on a random port. Run with
// `nice` if you care about your fans.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const libPath = path.resolve(process.argv[2] ?? "lib/cjs");
const lib = require(path.join(libPath, "index.js"));
const { Redis } = require("ioredis");
const { execute, parse } = require("graphql");
const { makeExecutableSchema } = require("@graphql-tools/schema");

let redisUrl = process.argv[3];
let redisProcess;
if (!redisUrl) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  redisProcess = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], {
    stdio: "ignore",
  });
  await sleep(300);
  redisUrl = `redis://127.0.0.1:${port}`;
}

const ITEMS = 200;
const OWNERS = 50;

const owners = Object.fromEntries(
  Array.from({ length: OWNERS }, (_, i) => [`o${i}`, { id: `o${i}`, name: `owner ${i}` }]),
);
let items = Array.from({ length: ITEMS }, (_, i) => ({
  id: String(i),
  name: `item ${i}`,
  owner: `o${i % OWNERS}`,
  tags: [`t${i % 7}`, `t${(i + 1) % 7}`, `t${(i + 2) % 7}`],
}));

const schema = makeExecutableSchema({
  resolvers: {
    Item: {
      owner: (item) => owners[item.owner],
      tags: (item) => item.tags.map((id) => ({ id, label: id })),
    },
    Query: {
      item: (_, { id }) => items.find((item) => item.id === id),
      items: () => items,
      owner: (_, { id }) => owners[id],
    },
  },
  typeDefs: `
    directive @cacheResolver(keyArg: String) on FIELD_DEFINITION
    type Query {
      items: [Item!]!
      item(id: ID!): Item @cacheResolver
      owner(id: ID!): Owner @cacheResolver
    }
    type Item { id: ID! name: String! owner: Owner! tags: [Tag!]! }
    type Owner { id: ID! name: String! }
    type Tag { id: ID! label: String! }
  `,
});

const client = new Redis(redisUrl);
await client.flushall();

const config = lib.makeBySchemaConfigGenerator({ idFields: new Set(["id"]) })(schema);
const strategy = lib.lazyInvalidationStrategy({ cache: lib.createRedisCache({ client }) });
const wrapped = lib.makeExecuteWrapper({
  ...config,
  getPartialExecutionOpts: strategy.getPartialExecutionOpts,
  processResult: lib.makeResultProcessor({
    awaitWriteBeforeResponse: true,
    storeExecutionResult: strategy.storeExecutionResult,
    ttl: 60 * 60 * 1000,
  }),
  session: () => "bench",
})(execute);

const source = `query Bench { items { id name owner { id name } tags { id label } } }`;
const document = config.parser(parse(source));
const plainDocument = parse(source);

async function time(label, iterations, setup, run) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    await setup?.(i);
    const start = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p90 = samples[Math.floor(samples.length * 0.9)];
  console.log(`${label.padEnd(44)} median ${median.toFixed(2).padStart(7)} ms   p90 ${p90.toFixed(2).padStart(7)} ms`);
}

const N = Number(process.env.BENCH_ITERATIONS ?? 100);

await time("plain execute (no Mangrove)", N, null, () => execute({ document: plainDocument, schema }));
await time("miss (empty cache)", N, () => client.flushall(), () => wrapped({ document, schema }));
await wrapped({ document, schema });
await time("hit", N, null, () => wrapped({ document, schema }));
await time(
  "partial: one item renamed",
  N,
  async (i) => {
    items[i % ITEMS].name = `renamed ${i}`;
    await strategy.invalidateEntities([{ id: String(i % ITEMS), typename: "Item" }]);
  },
  () => wrapped({ document, schema }),
);
await time(
  "partial: one owner renamed (on 4 items)",
  N,
  async (i) => {
    owners[`o${i % OWNERS}`].name = `renamed ${i}`;
    await strategy.invalidateEntities([{ id: `o${i % OWNERS}`, typename: "Owner" }]);
  },
  () => wrapped({ document, schema }),
);
await time(
  "partial: list reordered (Query invalidated)",
  N,
  async () => {
    items = [...items.slice(1), items[0]];
    await strategy.invalidateEntities([{ typename: "Query" }]);
  },
  () => wrapped({ document, schema }),
);

// Sanity check: the cached result must equal direct execution.
const cached = await wrapped({ document, schema });
const direct = await execute({ document: plainDocument, schema });
const { extensions: _extensions, ...actual } = cached;
console.log(
  JSON.stringify(actual) === JSON.stringify(direct)
    ? "result matches direct execution"
    : "RESULT DIFFERS FROM DIRECT EXECUTION",
);

await client.quit();
redisProcess?.kill();
