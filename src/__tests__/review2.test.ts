/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CacheFactory,
  createHarness,
  memoryCacheFactory,
  redisCacheFactory,
  startRedis,
  stopRedis,
} from "./harness.js";
import { spawnSync } from "node:child_process";
import { execute, parse } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { lazyInvalidationStrategy } from "../invalidationStrategies/lazyInvalidationStrategy.js";
import { makeBySchemaConfigGenerator } from "../schemaConfig.js";
import { makeExecuteWrapper } from "../runner.js";
import { makeResultFormatter } from "../resultFormatter.js";
import { makeResultProcessor } from "../resultProcessor.js";
import { RecordingLogger, DIRECTIVES } from "./harness.js";

const redisAvailable =
  !!process.env.REDIS_URL ||
  spawnSync("redis-server", ["--version"]).status === 0;

let redisUrl: string | undefined;
beforeAll(async () => {
  if (redisAvailable) {
    redisUrl = await startRedis();
  }
});
afterAll(async () => {
  await stopRedis();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeClock() {
  const start = Date.now();
  jest.useFakeTimers({
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "queueMicrotask",
    ],
    now: start,
  });
  return (o: number) => jest.setSystemTime(start + o);
}

const backends: [string, () => CacheFactory, boolean][] = [
  ["memory", () => memoryCacheFactory, true],
  ["redis", () => redisCacheFactory(redisUrl!), redisAvailable],
];

for (const [backend, getFactory, available] of backends) {
  (available ? describe : describe.skip)(backend, () => {
    test("F1: older request at the same epoch overwrites a newer result after an entity TTL ran out", async () => {
      const setTime = fakeClock();
      try {
        const state = { price: 1, title: 1 };
        const gate = deferred();
        const started = deferred();
        let gated = false;
        const h = createHarness({
          cache: await getFactory()(),
          entityTtls: { Price: 100 },
          resolvers: {
            Product: {
              title: async (p: any) => {
                if (gated) {
                  gated = false;
                  started.resolve();
                  await gate.promise;
                }
                return p.title;
              },
            },
            Query: {
              price: () => ({ id: "p", v: state.price }),
              product: () => ({ id: "x", title: state.title }),
            },
          },
          ttl: 10_000,
          typeDefs: `
            type Query { product: Product! price: Price! }
            type Product { id: ID! title: Int! }
            type Price { id: ID! v: Int! }`,
        });
        const query = `{ product { id title } price { id v } }`;
        await h.run(query); // t=0: price v1, valid until t=100
        setTime(50);
        state.title = 2;
        await h.strategy.invalidateEntities([{ id: "x", typename: "Product" }]);
        gated = true;
        // A: price still valid at read time, refetches only the product.
        const a = h.run(query);
        await started.promise;
        setTime(150); // price's TTL runs out; price changes (TTL-driven data)
        state.price = 2;
        // B: same epoch as A, started later; refetches price (v2) and product.
        const b = await h.run(query);
        expect((b.result.data as any).price.v).toBe(2);
        gate.resolve();
        await a; // A stores price v1 from the cache over B's result
        setTime(160);
        const c = await h.run(query);
        expect((c.result.data as any).price.v).toBe(2);
      } finally {
        jest.useRealTimers();
      }
    });

    test("F2: nested inline fragment without type condition keeps fragments on other union members", async () => {
      const state = { name: "a" };
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: {
            a: (_: unknown, { id }: any) => ({
              __typename: "A",
              id,
              name: state.name + id,
            }),
            things: () => [
              { __typename: "A", id: "1", name: state.name + "1" },
            ],
          },
          Thing: { __resolveType: (o: any) => o.__typename },
        },
        typeDefs: `
          type Query { things: [Thing!]! a(id: ID!): A @cacheResolver }
          union Thing = A | B
          type A { id: ID! name: String! }
          type B { id: ID! other: String! }`,
      });
      const query = `query Q($yes: Boolean = true) { things { ... @include(if: $yes) { ... on A { id name } ... on B { id other } } } }`;
      await h.run(query);
      state.name = "z";
      await h.strategy.invalidateEntities([{ id: "1", typename: "A" }]);
      const r = await h.run(query);
      expect(r.result.data).toEqual({ things: [{ id: "1", name: "z1" }] });
      expect(h.logger.errors).toEqual([]);
      expect(h.logger.warnings).toEqual([]);
    });

    test("F3: interface cache resolver for an entity at a concrete-typed position", async () => {
      const state = { name: "a" };
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Node: { __resolveType: () => "A" },
          Query: {
            item: () => ({ id: "1", name: state.name }),
            node: (_: unknown, { id }: any) => ({ id, name: state.name }),
          },
        },
        typeDefs: `
          type Query { item: A! node(id: ID!): Node @cacheResolver }
          interface Node { id: ID! }
          type A implements Node { id: ID! name: String! }`,
      });
      const query = `{ item { id name } }`;
      await h.run(query);
      state.name = "b";
      await h.strategy.invalidateEntities([{ id: "1", typename: "A" }]);
      const r = await h.run(query);
      expect(r.result.data).toEqual({ item: { id: "1", name: "b" } });
      expect(h.logger.warnings).toEqual([]);
    });

    test("F4: errors cached with a result survive after the erroring field was refetched successfully", async () => {
      const state = { fail: true };
      const schema = makeExecutableSchema({
        resolvers: {
          Item: {
            bad: () => {
              if (state.fail) throw new Error("boom");
              return "ok";
            },
          },
          Query: {
            item: (_: unknown, { id }: any) => ({ id }),
            items: () => [{ id: "1" }],
          },
        },
        typeDefs: [
          DIRECTIVES,
          `type Query { items: [Item!]! item(id: ID!): Item @cacheResolver } type Item { id: ID! bad: String }`,
        ],
      });
      const logger = new RecordingLogger();
      const config = makeBySchemaConfigGenerator({
        idFields: new Set(["id"]),
        logger,
      })(schema);
      const strategy = lazyInvalidationStrategy({
        cache: await getFactory()(),
        logger,
      });
      const wrapped = makeExecuteWrapper({
        ...config,
        formatResult: makeResultFormatter({
          includeExtensionMetadata: false,
          ttl: 60_000,
        }),
        getPartialExecutionOpts: strategy.getPartialExecutionOpts,
        logger,
        processResult: makeResultProcessor({
          awaitWriteBeforeResponse: true,
          entityTtls: config.entityTtls,
          logger,
          shouldCacheResult: () => true,
          storeExecutionResult: strategy.storeExecutionResult,
          ttl: 60_000,
        }),
        session: () => "s",
      })(execute);
      const run = async () =>
        (await wrapped({
          document: config.parser(parse(`{ items { id bad } }`)),
          schema,
        })) as any;
      const first = await run();
      expect(first.errors?.length).toBe(1);
      state.fail = false;
      await strategy.invalidateEntities([{ id: "1", typename: "Item" }]);
      const second = await run();
      expect(second.data).toEqual({ items: [{ bad: "ok", id: "1" }] });
      expect(second.errors).toBeUndefined();
    });

    test("F5: links with typed id markers (nullable ID, Int!) in a union list", async () => {
      const state = {
        list: [
          ["A", "1"],
          ["B", 2],
        ] as [string, any][],
        rev: "r1",
      };
      const make = (t: string, id: any) => ({
        __typename: t,
        id,
        name: `${t}${id}${state.rev}`,
      });
      let resolverCalls = 0;
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: {
            a: (_: unknown, { id }: any) => (resolverCalls++, make("A", id)),
            b: (_: unknown, { id }: any) => (resolverCalls++, make("B", id)),
            things: () => state.list.map(([t, id]) => ({ __typename: t, id })),
          },
          A: { name: (o: any) => `A${o.id}${state.rev}` },
          B: { name: (o: any) => `B${o.id}${state.rev}` },
          Thing: { __resolveType: (o: any) => o.__typename },
        },
        typeDefs: `
          type Query { things: [Thing!]! a(id: ID!): A @cacheResolver b(id: Int!): B @cacheResolver }
          union Thing = A | B
          type A { id: ID name: String! }
          type B { id: Int! name: String! }`,
      });
      const query = `{ things { ... on A { aid: id name } ... on B { bid: id name } } }`;
      await h.run(query);
      state.rev = "r2"; // not invalidated: cached names must stay r1
      state.list = [
        ["B", 2],
        ["A", "3"],
        ["A", "1"],
        ["B", 4],
      ];
      await h.strategy.invalidateEntities([{ typename: "Query" }]);
      const r = await h.run(query);
      expect(r.result.data).toEqual({
        things: [
          { bid: 2, name: "B2r1" },
          { aid: "3", name: "A3r2" },
          { aid: "1", name: "A1r1" },
          { bid: 4, name: "B4r2" },
        ],
      });
      expect(h.logger.warnings).toEqual([]);
      expect(r.executed.length).toBe(2);
    });

    test("F1b: same race with an entity key deleted directly (README: 'DEL Item:1')", async () => {
      const state = { price: 1, title: 1 };
      const gate = deferred();
      const started = deferred();
      let gated = false;
      const cache = await getFactory()();
      const h = createHarness({
        cache,
        resolvers: {
          Product: {
            title: async (p: any) => {
              if (gated) {
                gated = false;
                started.resolve();
                await gate.promise;
              }
              return p.title;
            },
          },
          Query: {
            price: () => ({ id: "p", v: state.price }),
            product: () => ({ id: "x", title: state.title }),
          },
        },
        typeDefs: `
          type Query { product: Product! price: Price! }
          type Product { id: ID! title: Int! }
          type Price { id: ID! v: Int! }`,
      });
      const query = `{ product { id title } price { id v } }`;
      await h.run(query);
      state.title = 2;
      await h.strategy.invalidateEntities([{ id: "x", typename: "Product" }]);
      gated = true;
      const a = h.run(query); // price valid at read
      await started.promise;
      state.price = 2;
      await cache.clear(["Price:p"]); // "In a pinch, deleting the entity's key directly"
      const b = await h.run(query);
      expect((b.result.data as any).price.v).toBe(2);
      gate.resolve();
      await a;
      const c = await h.run(query);
      expect((c.result.data as any).price.v).toBe(2);
    });
  });
}
