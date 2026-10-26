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

const backends: [string, () => CacheFactory, boolean][] = [
  ["memory", () => memoryCacheFactory, true],
  ["redis", () => redisCacheFactory(redisUrl!), redisAvailable],
];

// Findings of an independent review of the rework, as regression tests.
for (const [backend, getFactory, available] of backends) {
  (available ? describe : describe.skip)(backend, () => {
    test("R1: older concurrent store of same cacheKey overwrites newer result while entity stays valid", async () => {
      const item = { data: "v1", id: "1" };
      const gate = deferred();
      const started = deferred();
      let calls = 0;
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Item: {
            data: async (parent: any) => {
              const value = parent.data;
              if (++calls === 1) {
                started.resolve();
                await gate.promise;
              }
              return value;
            },
          },
          Query: { item: () => ({ ...item }) },
        },
        typeDefs: `type Query { item: Item! } type Item { id: ID! data: String! }`,
      });
      const query = `{ item { id data } }`;

      const a = h.run(query); // reads v1, then stalls
      await started.promise;
      item.data = "v2";
      await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

      const b = await h.run(query); // started after the invalidation
      expect((b.result.data as any).item.data).toBe("v2");

      gate.resolve();
      await a; // stores its (older) v1 result

      const c = await h.run(query); // started after the invalidation completed
      expect((c.result.data as any).item.data).toBe("v2");
    });

    test("R2: non-entity union member next to linkable entities keeps stale data", async () => {
      const state = { bName: "old" };
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: {
            a: (_: unknown, { id }: any) => ({
              __typename: "A",
              id,
              name: "a" + id,
            }),
            things: () => [
              { __typename: "A", id: "1", name: "a1" },
              { __typename: "B", name: state.bName },
            ],
          },
          Thing: { __resolveType: (o: any) => o.__typename },
        },
        typeDefs: `
          type Query { things: [Thing!]! a(id: ID!): A @cacheResolver }
          union Thing = A | B
          type A { id: ID! name: String! }
          type B { name: String! }`,
      });
      const query = `{ things { ... on A { id name } ... on B { name } } }`;
      await h.run(query);
      state.bName = "new";
      // B has no identity; its parent (Query) owns it.
      await h.strategy.invalidateEntities([{ typename: "Query" }]);
      const r = await h.run(query);
      expect((r.result.data as any).things[1].name).toBe("new");
    });

    test("R3: union members whose id fields differ in nullability produce an invalid document", async () => {
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: {
            things: () => [
              { __typename: "A", id: "1", name: "a" },
              { __typename: "B", id: "2", name: "b" },
            ],
          },
          Thing: { __resolveType: (o: any) => o.__typename },
        },
        typeDefs: `
          type Query { things: [Thing!]! }
          union Thing = A | B
          type A { id: ID! name: String! }
          type B { id: ID name: String! }`,
      });
      let error: unknown;
      try {
        const r = await h.run(
          `{ things { ... on A { name } ... on B { name } } }`,
        );
        expect(r.result.data).toEqual({
          things: [{ name: "a" }, { name: "b" }],
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });

    test("R4: interface id nullable, implementation id non-null produces an invalid document", async () => {
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: { nodes: () => [{ __typename: "A", id: "1", name: "a" }] },
          Node: { __resolveType: (o: any) => o.__typename },
        },
        typeDefs: `
          type Query { nodes: [Node!]! }
          interface Node { id: ID }
          type A implements Node { id: ID! name: String! }`,
      });
      let error: unknown;
      try {
        const r = await h.run(`{ nodes { ... on A { name } } }`);
        expect(r.result.data).toEqual({ nodes: [{ name: "a" }] });
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });

    test("R5: object whose only selections don't apply to its type looks like a link stub", async () => {
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: {
            nodes: () => [
              { __typename: "Article", id: "a1", title: "t" },
              { __typename: "Video", id: "v1", length: 1 },
            ],
          },
          Node: { __resolveType: (o: any) => o.__typename },
        },
        typeDefs: `
          type Query { nodes: [Node!]! }
          interface Node { id: ID! }
          type Article implements Node { id: ID! title: String! }
          type Video implements Node { id: ID! length: Int! }`,
      });
      let error: unknown;
      try {
        const r = await h.run(`{ nodes { ... on Video { length } } }`);
        expect(r.result.data).toEqual({ nodes: [{}, { length: 1 }] });
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });

    test("R6: entity TTL running out during a partial request is renewed with data from the cache", async () => {
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
      const setTime = (o: number) => jest.setSystemTime(start + o);
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
        await h.run(query); // t=0, price v1 valid until t=100
        state.price = 2;
        state.title = 2;
        setTime(50);
        await h.strategy.invalidateEntities([{ id: "x", typename: "Product" }]);
        gated = true;
        const inflight = h.run(query); // price still valid at read time
        await started.promise;
        setTime(150); // price's TTL runs out while the request is running
        gated = false;
        gate.resolve();
        await inflight;
        setTime(200); // price data is 200ms old, its TTL is 100ms
        const r = await h.run(query);
        expect((r.result.data as any).price.v).toBe(2);
      } finally {
        jest.useRealTimers();
      }
    });

    test("R7: resolutions keep fragments on non-entity union members -> invalid document", async () => {
      const state = { list: ["1"], name: "a" };
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
              ...state.list.map((id) => ({
                __typename: "A",
                id,
                name: state.name + id,
              })),
              { __typename: "B", name: "b" },
            ],
          },
          Thing: { __resolveType: (o: any) => o.__typename },
        },
        typeDefs: `
          type Query { things: [Thing!]! a(id: ID!): A @cacheResolver }
          union Thing = A | B
          type A { id: ID! name: String! }
          type B { name: String! }`,
      });
      const query = `{ things { ... on A { id name } ... on B { name } } }`;
      await h.run(query);
      state.name = "z";
      await h.strategy.invalidateEntities([{ id: "1", typename: "A" }]);
      const r = await h.run(query);
      expect((r.result.data as any).things[0].name).toBe("z1");
      expect(h.logger.warnings).toEqual([]);
    });

    test("R7b: resolutions drop fragments on types the resolver's type can't be", async () => {
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
          interface Named { name: String! }
          type A implements Named { id: ID! name: String! }
          type B implements Named { id: ID! name: String! }`,
      });
      const query = `{ things { ... on A { id } ... on B { id name } ... on Named { name } } }`;
      await h.run(query);
      state.name = "z";
      await h.strategy.invalidateEntities([{ id: "1", typename: "A" }]);
      const r = await h.run(query);
      expect(r.result.data).toEqual({ things: [{ id: "1", name: "z1" }] });
      expect(r.executed[0]).toContain("... on Named");
      // The client's fragment on B can't apply to A and must be dropped.
      expect(r.executed[0]).not.toMatch(/\.\.\. on B \{\s+id\s+name/);
      expect(h.logger.warnings).toEqual([]);
    });

    test("R8: cached errors are dropped on hits (makeResultProcessor default shouldCacheResult)", async () => {
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: { item: () => ({ id: "1" }) },
          Item: {
            bad: () => {
              throw new Error("boom");
            },
          },
        },
        typeDefs: `type Query { item: Item! } type Item { id: ID! bad: String }`,
      });
      const q = `{ item { id bad } }`;
      const first = await h.run(q);
      expect(first.result.errors?.length).toBe(1);
      const second = await h.run(q);
      expect(second.result.errors?.length).toBe(1);
    });

    test("R9: batch cache resolver omitting an entity leaves stale data and marks it valid", async () => {
      const items: Record<string, any> = {
        "1": { id: "1", name: "one" },
        "2": { id: "2", name: "two" },
      };
      const hidden = new Set<string>();
      const h = createHarness({
        cache: await getFactory()(),
        resolvers: {
          Query: {
            items: () => Object.values(items),
            itemsByIds: (_: unknown, { ids }: any) =>
              ids
                .filter((id: string) => !hidden.has(id))
                .map((id: string) => items[id]),
          },
        },
        typeDefs: `type Query { items: [Item!]! itemsByIds(ids: [ID!]!): [Item!]! @cacheResolver } type Item { id: ID! name: String! }`,
      });
      expect(h.config.cacheResolvers.Item?.batch).toBe(true);
      const q = `{ items { id name } }`;
      await h.run(q);
      items["1"].name = "ONE";
      hidden.add("1"); // e.g. the batch resolver doesn't return it (deleted/filtered/reordered loader)
      await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);
      const r = await h.run(q);
      expect((r.result.data as any).items[0].name).toBe("ONE");
      hidden.clear();
      const r2 = await h.run(q);
      expect((r2.result.data as any).items[0].name).toBe("ONE");
    });
  });
}
