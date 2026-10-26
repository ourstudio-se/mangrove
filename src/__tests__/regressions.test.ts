/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CacheFactory,
  createHarness,
  memoryCacheFactory,
  redisCacheFactory,
  startRedis,
  stopRedis,
} from "./harness.js";
import { Cache } from "../typings.js";
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

const backends: [string, () => CacheFactory, boolean][] = [
  ["memory", () => memoryCacheFactory, true],
  ["redis", () => redisCacheFactory(redisUrl!), redisAvailable],
];

/** Counts cache writes of results (not set memberships). */
function countingCache(cache: Cache) {
  const counter = { sets: 0 };
  const wrapPipe = () => {
    const pipe = cache.getPipe();
    return {
      ...pipe,
      set: (...args: Parameters<Cache["set"]>) => {
        counter.sets++;
        return pipe.set(...args);
      },
    };
  };
  return { cache: { ...cache, getPipe: wrapPipe } as Cache, counter };
}

/**
 * Fakes Date only, starting from the real time: Redis keeps real time, so
 * mocked absolute expiries must stay in the future.
 */
function fakeDate() {
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
  return (offset: number) => jest.setSystemTime(start + offset);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const ITEM_OWNER_SCHEMA = /* GraphQL */ `
  type Query {
    items: [Item!]!
    item(id: ID!): Item @cacheResolver
    featured: Item
  }
  type Item {
    id: ID!
    name: String!
    owner: Owner!
  }
  type Owner {
    id: ID!
    name: String!
  }
`;

for (const [backend, getFactory, available] of backends) {
  const describeBackend = available ? describe : describe.skip;

  describeBackend(`${backend} cache`, () => {
    let createCache: CacheFactory;

    beforeAll(() => {
      createCache = getFactory();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function itemsWithOwners() {
      const owners: Record<string, any> = {
        "5": { id: "5", name: "Alice" },
        "6": { id: "6", name: "Bob" },
      };
      const items: any[] = [
        { id: "1", name: "one", ownerId: "5" },
        { id: "2", name: "two", ownerId: "6" },
      ];
      const calls = { item: 0, items: 0 };
      const resolvers = {
        Item: { owner: (item: any) => owners[item.ownerId] },
        Query: {
          featured: () => items[0],
          item: (_: unknown, { id }: { id: string }) => {
            calls.item++;
            return items.find((item) => item.id === id) ?? null;
          },
          items: () => {
            calls.items++;
            return items;
          },
        },
      };
      return { calls, items, owners, resolvers };
    }

    describe("C2: invalidated entity below an entity with a cache resolver", () => {
      test("in a list: re-resolves only the affected list item", async () => {
        const { owners, resolvers, calls } = itemsWithOwners();
        const h = createHarness({
          cache: await createCache(),
          resolvers,
          typeDefs: ITEM_OWNER_SCHEMA,
        });
        const query = `{ items { id name owner { id name } } }`;

        await h.run(query);
        owners["5"].name = "Alice (renamed)";
        await h.strategy.invalidateEntities([{ id: "5", typename: "Owner" }]);

        const { result, executed } = await h.run(query);

        expect((result.data as any).items[0].owner.name).toBe(
          "Alice (renamed)",
        );
        expect((result.data as any).items[1].owner.name).toBe("Bob");
        expect(executed).toHaveLength(1);
        expect(executed[0]).toContain('item(id: "1")');
        expect(executed[0]).not.toContain('item(id: "2")');
        expect(calls.items).toBe(1);
      });

      test("on a single object", async () => {
        const { owners, resolvers } = itemsWithOwners();
        const h = createHarness({
          cache: await createCache(),
          resolvers,
          typeDefs: ITEM_OWNER_SCHEMA,
        });
        const query = `{ featured { id name owner { id name } } }`;

        await h.run(query);
        owners["5"].name = "Alice (renamed)";
        await h.strategy.invalidateEntities([{ id: "5", typename: "Owner" }]);

        const { result, executed } = await h.run(query);

        expect((result.data as any).featured.owner.name).toBe(
          "Alice (renamed)",
        );
        expect(executed[0]).toContain('item(id: "1")');
        expect(h.logger.errors).toEqual([]);
        expect(h.logger.warnings).toEqual([]);
      });
    });

    describe("C3: invalidating a parent refetches children regardless of order", () => {
      for (const typename of ["Apple", "Zebra"]) {
        test(`root invalidation with a list of ${typename}`, async () => {
          const list = [{ id: "1", name: "Ann" }];
          const h = createHarness({
            cache: await createCache(),
            resolvers: { Query: { list: () => list } },
            typeDefs: `type Query { list: [${typename}!]! } type ${typename} { id: ID! name: String! }`,
          });
          const query = `{ list { id name } }`;

          await h.run(query);
          list.push({ id: "2", name: "Bob" });
          await h.strategy.invalidateEntities([{ typename: "Query" }]);

          const { result } = await h.run(query);

          expect((result.data as any).list.map((u: any) => u.name)).toEqual([
            "Ann",
            "Bob",
          ]);
        });
      }
    });

    test("C4: invalidating an entity in a nested list", async () => {
      const items = [{ data: "v1", id: "1" }];
      const h = createHarness({
        cache: await createCache(),
        resolvers: {
          Dashboard: { items: () => items },
          Query: { dashboard: () => ({ id: "d" }) },
        },
        typeDefs: `
          type Query { dashboard: Dashboard! }
          type Dashboard { id: ID! items: [Item!]! }
          type Item { id: ID! data: String! }`,
      });
      const query = `{ dashboard { id items { id data } } }`;

      await h.run(query);
      items[0].data = "v2";
      await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

      const { result } = await h.run(query);

      expect((result.data as any).dashboard.items[0].data).toBe("v2");
    });

    describe("C6: invalidation races and expiry", () => {
      test("an invalidation during a request is not undone by its store", async () => {
        const item = { data: "v1", id: "1" };
        const gate = deferred();
        const started = deferred();
        let gated = false;
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Item: {
              data: async (parent: any) => {
                const value = parent.data;
                if (gated) {
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

        gated = true;
        const inFlight = h.run(query);
        await started.promise;

        // The source changes while the request has already read v1.
        item.data = "v2";
        await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

        gated = false;
        gate.resolve();
        expect(((await inFlight).result.data as any).item.data).toBe("v1");

        const { result } = await h.run(query);
        expect((result.data as any).item.data).toBe("v2");
      });

      test("cache hits don't write back, and don't extend the expiry", async () => {
        const setTime = fakeDate();
        const { cache, counter } = countingCache(await createCache());
        let version = 1;
        const h = createHarness({
          cache,
          resolvers: { Query: { item: () => ({ id: "1", v: version }) } },
          ttl: 1000,
          typeDefs: `type Query { item: Item! } type Item { id: ID! v: Int! }`,
        });
        const query = `{ item { id v } }`;

        await h.run(query);
        expect(counter.sets).toBe(1);

        version = 2;
        setTime(500);
        const hit = await h.run(query);
        expect(hit.executed).toHaveLength(0);
        expect((hit.result.data as any).item.v).toBe(1);
        expect(counter.sets).toBe(1);

        setTime(1100);
        const expired = await h.run(query);
        expect(expired.result.extensions?.cache?.hit).toBe(false);
        expect((expired.result.data as any).item.v).toBe(2);
      });

      test("a partially refreshed result keeps its original expiry", async () => {
        const setTime = fakeDate();
        const state = { a: 1, b: 1 };
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Query: {
              a: () => ({ id: "a", v: state.a }),
              b: () => ({ id: "b", v: state.b }),
            },
          },
          ttl: 1000,
          typeDefs: `type Query { a: T! b: T! } type T { id: ID! v: Int! }`,
        });
        const query = `{ a { id v } b { id v } }`;

        await h.run(query);
        state.a = 2;
        state.b = 2;
        await h.strategy.invalidateEntities([{ id: "a", typename: "T" }]);

        setTime(300);
        const partial = await h.run(query);
        expect(partial.result.data).toEqual({
          a: { id: "a", v: 2 },
          b: { id: "b", v: 1 },
        });

        // b is as old as the original result: it must not outlive it.
        setTime(1100);
        const expired = await h.run(query);
        expect(expired.result.data).toEqual({
          a: { id: "a", v: 2 },
          b: { id: "b", v: 2 },
        });
      });

      test("per-entity TTLs are honoured", async () => {
        const setTime = fakeDate();
        const state = { price: 1, title: 1 };
        const h = createHarness({
          cache: await createCache(),
          entityTtls: { Price: 100 },
          resolvers: {
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

        await h.run(query);
        state.price = 2;
        state.title = 2;

        setTime(50);
        expect((await h.run(query)).result.data).toEqual({
          price: { id: "p", v: 1 },
          product: { id: "x", title: 1 },
        });

        // A partial refresh of the product stores the result again, but must
        // not extend how long the (unchanged) price is considered valid.
        await h.strategy.invalidateEntities([{ id: "x", typename: "Product" }]);
        setTime(60);
        expect((await h.run(query)).result.data).toEqual({
          price: { id: "p", v: 1 },
          product: { id: "x", title: 2 },
        });

        setTime(120);
        expect((await h.run(query)).result.data).toEqual({
          price: { id: "p", v: 2 },
          product: { id: "x", title: 2 },
        });
      });
    });

    describe("C7: merging by entity identity", () => {
      test("a link to an entity known elsewhere in the result", async () => {
        const { items, resolvers } = itemsWithOwners();
        let featured = items[0];
        resolvers.Query.featured = () => featured;
        const h = createHarness({
          cache: await createCache(),
          resolvers,
          typeDefs: ITEM_OWNER_SCHEMA,
        });
        const query = `{ featured { id name } items { id name } }`;

        await h.run(query);
        featured = items[1];
        await h.strategy.invalidateEntities([{ typename: "Query" }]);

        const expected = {
          featured: { id: "2", name: "two" },
          items: [
            { id: "1", name: "one" },
            { id: "2", name: "two" },
          ],
        };

        expect((await h.run(query)).result.data).toEqual(expected);
        // And it stays correct when served from the cache.
        expect((await h.run(query)).result.data).toEqual(expected);
      });

      test("links swapped between positions at the same coordinates", async () => {
        const items: Record<string, any> = {
          "1": { id: "1", name: "one" },
          "2": { id: "2", name: "two" },
        };
        const users = [
          { fav: "1", id: "u1" },
          { fav: "2", id: "u2" },
        ];
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Query: {
              item: (_: unknown, { id }: any) => items[id],
              users: () => users,
            },
            User: { fav: (user: any) => items[user.fav] },
          },
          typeDefs: `
            type Query { users: [User!]! item(id: ID!): Item @cacheResolver }
            type User { id: ID! fav: Item! }
            type Item { id: ID! name: String! }`,
        });
        const query = `{ users { id fav { id name } } }`;

        await h.run(query);
        users[0].fav = "2";
        users[1].fav = "1";
        await h.strategy.invalidateEntities([{ typename: "User" }]);

        const { result, executed } = await h.run(query);
        expect(result.data).toEqual({
          users: [
            { fav: { id: "2", name: "two" }, id: "u1" },
            { fav: { id: "1", name: "one" }, id: "u2" },
          ],
        });
        // Both items are known at users.fav: no link queries needed.
        expect(executed).toHaveLength(1);
      });

      test("entities of different types with the same id", async () => {
        let results: any[] = [
          { __typename: "A", a: "alpha", id: "1" },
          { __typename: "B", b: "beta", id: "1" },
        ];
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Query: {
              a: () => results[0],
              b: () => results[1],
              results: () => results,
            },
          },
          typeDefs: `
            type Query { results: [R!]! a(id: ID!): A @cacheResolver b(id: ID!): B @cacheResolver }
            union R = A | B
            type A { id: ID! a: String! }
            type B { id: ID! b: String! }`,
        });
        const query = `{ results { ... on A { id a } ... on B { id b } } }`;

        await h.run(query);
        results = [results[1], results[0]];
        await h.strategy.invalidateEntities([{ typename: "Query" }]);

        expect((await h.run(query)).result.data).toEqual({
          results: [
            { b: "beta", id: "1" },
            { a: "alpha", id: "1" },
          ],
        });
      });
    });

    describe("H1: variables", () => {
      test("link queries carry the variables they use", async () => {
        const items = [{ id: "1" }, { id: "2" }];
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Item: { data: (item: any, { n }: any) => `${item.id}:${n}` },
            Query: {
              item: (_: unknown, { id }: any) => items.find((i) => i.id === id),
              items: () => items,
            },
          },
          typeDefs: `
            type Query { items: [Item!]! item(id: ID!): Item @cacheResolver }
            type Item { id: ID! data(n: Int): String! }`,
        });
        const query = `query Q($n: Int) { items { id data(n: $n) } }`;

        await h.run(query, { variables: { n: 7 } });
        items.push({ id: "3" });
        await h.strategy.invalidateEntities([{ typename: "Query" }]);

        const { result, executed } = await h.run(query, {
          variables: { n: 7 },
        });

        expect((result.data as any).items.map((i: any) => i.data)).toEqual([
          "1:7",
          "2:7",
          "3:7",
        ]);
        expect(executed[1]).toContain("query Q__linkQuery($n: Int)");
      });

      test("unused variable definitions are removed from partial queries", async () => {
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Item: { data: (_: unknown, { n }: any) => `d${n}` },
            Query: {
              item: () => ({ id: "1" }),
              items: () => [{ id: "2" }],
            },
          },
          typeDefs: `
            type Query { items: [Item!]! item(id: ID!): Item @cacheResolver }
            type Item { id: ID! data(n: Int): String! }`,
        });
        const query = `query Q($n: Int) { a: item(id: "1") { id data(n: $n) } items { id } }`;

        await h.run(query, { variables: { n: 1 } });
        await h.strategy.invalidateEntities([{ typename: "Query" }]);

        // The harness rejects invalid documents (e.g. unused variables).
        const { result, executed } = await h.run(query, {
          variables: { n: 1 },
        });
        expect(executed).toHaveLength(1);
        expect(executed[0]).not.toContain("$n");
        expect(result.data).toEqual({
          a: { data: "d1", id: "1" },
          items: [{ id: "2" }],
        });
      });
    });

    test("H2: documents with several operations", async () => {
      const item = { id: "1", name: "v1" };
      const h = createHarness({
        cache: await createCache(),
        resolvers: { Query: { item: () => ({ ...item }), other: () => "x" } },
        typeDefs: `type Query { item: Item! other: String! } type Item { id: ID! name: String! }`,
      });
      const query = `
        query GetItem { item { id name } }
        query GetOther { other }`;

      await h.run(query, { operationName: "GetItem" });
      item.name = "v2";
      await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

      const { result } = await h.run(query, { operationName: "GetItem" });
      expect(result.data).toEqual({ item: { id: "1", name: "v2" } });
      expect(
        (await h.run(query, { operationName: "GetOther" })).result.data,
      ).toEqual({
        other: "x",
      });
    });

    describe("H3: abstract types", () => {
      const NODE_SCHEMA = `
        type Query {
          node(id: ID!): Node @cacheResolver
          search: [SearchResult!]!
          nodes: [Node!]!
        }
        interface Node { id: ID! }
        union SearchResult = Article | Video
        type Article implements Node { id: ID! title: String! }
        type Video implements Node { id: ID! length: Int! }`;

      function nodeData() {
        const nodes: Record<string, any> = {
          a1: { __typename: "Article", id: "a1", title: "First" },
          v1: { __typename: "Video", id: "v1", length: 10 },
        };
        const resolvers = {
          Query: {
            node: (_: unknown, { id }: any) => nodes[id] ?? null,
            nodes: () => Object.values(nodes),
            search: () => Object.values(nodes),
          },
        };
        return { nodes, resolvers };
      }

      test("interface-typed fields identify their entities", async () => {
        const { nodes, resolvers } = nodeData();
        const h = createHarness({
          cache: await createCache(),
          resolvers,
          typeDefs: NODE_SCHEMA,
        });
        const query = `{ nodes { id ... on Article { title } } }`;

        await h.run(query);
        nodes.a1.title = "Updated";
        await h.strategy.invalidateEntities([
          { id: "a1", typename: "Article" },
        ]);

        const { result } = await h.run(query);
        expect((result.data as any).nodes[0].title).toBe("Updated");
        expect(h.logger.errors).toEqual([]);
      });

      test("union lists are re-resolved per type through an interface resolver", async () => {
        const { nodes, resolvers } = nodeData();
        const h = createHarness({
          cache: await createCache(),
          resolvers,
          typeDefs: NODE_SCHEMA,
        });
        const query = `{ search { ... on Article { id title } ... on Video { id length } } }`;

        expect(h.config.cacheResolvers.Article?.rootField).toBe("node");
        expect(h.config.cacheResolvers.Video?.rootField).toBe("node");

        await h.run(query);
        nodes.v1.length = 20;
        await h.strategy.invalidateEntities([{ id: "v1", typename: "Video" }]);

        const { result, executed } = await h.run(query);
        expect(result.data).toEqual({
          search: [
            { id: "a1", title: "First" },
            { id: "v1", length: 20 },
          ],
        });
        expect(executed[0]).toContain('node(id: "v1")');
        expect(executed[0]).not.toContain("... on Article");
        expect(h.logger.warnings).toEqual([]);
      });
    });

    describe("H4: arbitrary ids and field names", () => {
      for (const id of [
        "a.b",
        'x"y',
        "C:\\new",
        "urn:x:1",
        "user@example.com",
        "a>b",
        "#1",
        "0",
      ]) {
        test(`id ${JSON.stringify(id)}`, async () => {
          const items: Record<string, any> = { [id]: { id, v: 1 } };
          const h = createHarness({
            cache: await createCache(),
            resolvers: {
              Query: {
                item: (_: unknown, args: any) => items[args.id] ?? null,
                items: () => Object.values(items),
              },
            },
            typeDefs: `
              type Query { items: [Item!]! item(id: ID!): Item @cacheResolver }
              type Item { id: ID! v: Int! }`,
          });
          const query = `{ items { id v } }`;

          await h.run(query);
          items[id].v = 2;
          await h.strategy.invalidateEntities([{ id, typename: "Item" }]);

          const { result, executed } = await h.run(query);
          expect(result.data).toEqual({ items: [{ id, v: 2 }] });
          expect(executed).toHaveLength(1);
          expect(result.extensions?.cache?.partial).toBe(true);
          expect(h.logger.errors).toEqual([]);
        });
      }

      test("field names containing underscores", async () => {
        const item = { id: "1", v: 1 };
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Query: { item: () => ({ ...item }), top_item: () => ({ ...item }) },
          },
          typeDefs: `
            type Query { top_item: Item! item(id: ID!): Item @cacheResolver }
            type Item { id: ID! v: Int! }`,
        });
        const query = `{ top_item { id v } }`;

        await h.run(query);
        item.v = 2;
        await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

        const { result, executed } = await h.run(query);
        expect(result.data).toEqual({ top_item: { id: "1", v: 2 } });
        expect(executed[0]).toContain("item(id:");
      });
    });

    describe("H5: merge edge cases", () => {
      test("lists containing null", async () => {
        let list: any[] = [{ id: "1", v: "one" }, null, { id: "2", v: "two" }];
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Query: {
              item: (_: unknown, { id }: any) => list.find((i) => i?.id === id),
              list: () => list,
            },
          },
          typeDefs: `
            type Query { list: [Item]! item(id: ID!): Item @cacheResolver }
            type Item { id: ID! v: String! }`,
        });
        const query = `{ list { id v } }`;

        await h.run(query);
        list = [list[2], null, list[0]];
        await h.strategy.invalidateEntities([{ typename: "Query" }]);

        expect((await h.run(query)).result.data).toEqual({
          list: [{ id: "2", v: "two" }, null, { id: "1", v: "one" }],
        });
      });

      test("a cache resolver returning null falls back to full execution", async () => {
        const { items, resolvers } = itemsWithOwners();
        const h = createHarness({
          cache: await createCache(),
          resolvers,
          typeDefs: ITEM_OWNER_SCHEMA,
        });
        const query = `{ items { id name } }`;

        await h.run(query);
        // Item 1 is deleted, but only the item is invalidated.
        items.splice(0, 1);
        await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

        const { result } = await h.run(query);
        expect(result.data).toEqual({ items: [{ id: "2", name: "two" }] });
        expect(h.logger.warnings.length).toBeGreaterThan(0);
      });

      test("an object that changed type doesn't keep fields of the old type", async () => {
        let thing: any = { __typename: "A", a: "aa" };
        const h = createHarness({
          cache: await createCache(),
          resolvers: { Query: { thing: () => thing } },
          typeDefs: `
            type Query { thing: Thing! }
            union Thing = A | B
            type A { a: String! }
            type B { b: String! }`,
        });
        const query = `{ thing { ... on A { a } ... on B { b } } }`;

        await h.run(query);
        thing = { __typename: "B", b: "bb" };
        await h.strategy.invalidateEntities([{ typename: "Query" }]);

        expect((await h.run(query)).result.data).toEqual({
          thing: { b: "bb" },
        });
      });
    });

    test("H6: Int ids of known entities are not refetched", async () => {
      let items = [
        { id: 1, v: "one" },
        { id: 2, v: "two" },
      ];
      const h = createHarness({
        cache: await createCache(),
        resolvers: {
          Query: {
            item: (_: unknown, { id }: any) => items.find((i) => i.id === id),
            items: () => items,
          },
        },
        typeDefs: `
          type Query { items: [Item!]! item(id: Int!): Item @cacheResolver }
          type Item { id: Int! v: String! }`,
      });
      const query = `{ items { id v } }`;

      await h.run(query);
      items = [items[1], items[0]];
      await h.strategy.invalidateEntities([{ typename: "Query" }]);

      const { result, executed } = await h.run(query);
      expect(result.data).toEqual({
        items: [
          { id: 2, v: "two" },
          { id: 1, v: "one" },
        ],
      });
      expect(executed).toHaveLength(1);
    });

    test("errors in partial executions are reported against the original query", async () => {
      let fail = false;
      const h = createHarness({
        cache: await createCache(),
        resolvers: {
          Item: {
            v: () => {
              if (fail) throw new Error("boom");
              return 1;
            },
          },
          Query: {
            item: () => ({ id: "1" }),
            items: () => [{ id: "1" }],
          },
        },
        typeDefs: `
          type Query { items: [Item!]! item(id: ID!): Item @cacheResolver }
          type Item { id: ID! v: Int }`,
      });
      const query = `{ items { id v } }`;

      await h.run(query);
      fail = true;
      await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

      const { result } = await h.run(query);
      expect(result.errors?.[0].path).toEqual(["items", 0, "v"]);
      expect(result.data).toEqual({ items: [{ id: "1", v: null }] });
    });

    describe("operations that aren't cached", () => {
      test("mutations are executed every time without marker fields", async () => {
        let counter = 0;
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Mutation: { bump: () => ({ id: "1", n: ++counter }) },
            Query: { x: () => 1 },
          },
          typeDefs: `
            type Query { x: Int }
            type Mutation { bump: Counter! }
            type Counter { id: ID! n: Int! }`,
        });
        const mutation = `
          fragment C on Counter { id n }
          mutation M { bump { ...C } }`;

        expect((await h.run(mutation)).result.data).toEqual({
          bump: { id: "1", n: 1 },
        });
        expect((await h.run(mutation)).result.data).toEqual({
          bump: { id: "1", n: 2 },
        });
      });

      test("disabled requests keep their operationName and lose marker fields", async () => {
        const h = createHarness({
          cache: await createCache(),
          enabled: () => false,
          resolvers: { Query: { a: () => ({ id: "1" }), b: () => 2 } },
          typeDefs: `type Query { a: A! b: Int! } type A { id: ID! }`,
        });

        const { result } = await h.run(`query A { a { id } } query B { b }`, {
          operationName: "A",
        });
        expect(result).toEqual({ data: { a: { id: "1" } } });
      });
    });

    describe("invalidating whole types", () => {
      test("only affects that type", async () => {
        const state = { group: 1, item: 1 };
        const h = createHarness({
          cache: await createCache(),
          resolvers: {
            Query: {
              group: () => ({ id: "1", v: state.group }),
              item: () => ({ id: "1", v: state.item }),
            },
          },
          typeDefs: `
            type Query { item: Item! group: ItemGroup! }
            type Item { id: ID! v: Int! }
            type ItemGroup { id: ID! v: Int! }`,
        });
        const query = `{ item { id v } group { id v } }`;

        await h.run(query);
        state.item = 2;
        state.group = 2;
        await h.strategy.invalidateEntities([{ typename: "Item" }]);

        expect((await h.run(query)).result.data).toEqual({
          group: { id: "1", v: 1 },
          item: { id: "1", v: 2 },
        });
      });

      test("rejects an empty typename", async () => {
        const h = createHarness({
          cache: await createCache(),
          resolvers: {},
          typeDefs: `type Query { x: Int }`,
        });
        await expect(
          h.strategy.invalidateEntities([{ typename: "" }]),
        ).rejects.toThrow();
      });
    });

    test("the README walkthrough", async () => {
      const items: { id: string }[] = [{ id: "1" }, { id: "2" }];
      let generation = 0;
      const dataCalls: string[] = [];
      const h = createHarness({
        cache: await createCache(),
        resolvers: {
          Item: {
            data: (item: { id: string }) => {
              dataCalls.push(item.id);
              return `${item.id}-${generation}`;
            },
          },
          Query: {
            item: (_: unknown, { id }: any) => items.find((i) => i.id === id),
            items: () => items,
          },
        },
        typeDefs: `
          type Query { items: [Item!]! item(id: ID!): Item @cacheResolver }
          type Item { id: ID! data: String! }`,
      });
      const query = `query BigItemQuery { items { id data } }`;
      const data = async () =>
        ((await h.run(query)).result.data as any).items.map((i: any) => i.data);

      expect(await data()).toEqual(["1-0", "2-0"]);
      generation = 1;
      expect(await data()).toEqual(["1-0", "2-0"]);

      await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);
      dataCalls.length = 0;
      expect(await data()).toEqual(["1-1", "2-0"]);
      expect(dataCalls).toEqual(["1"]);

      items.push({ id: "3" });
      await h.strategy.invalidateEntities([{ typename: "Query" }]);
      dataCalls.length = 0;
      expect(await data()).toEqual(["1-1", "2-0", "3-1"]);
      expect(dataCalls).toEqual(["3"]);

      items.push(items.shift()!);
      await h.strategy.invalidateEntities([{ typename: "Query" }]);
      dataCalls.length = 0;
      expect(await data()).toEqual(["2-0", "3-1", "1-1"]);
      expect(dataCalls).toEqual([]);
    });
  });
}
