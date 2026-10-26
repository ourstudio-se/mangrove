/* eslint-disable @typescript-eslint/no-explicit-any */
// Findings of the extended differential fuzzer, as regression tests.
import { createHarness, memoryCacheFactory } from "./harness.js";
import { execute, parse } from "graphql";
import { Cache } from "../typings.js";

async function expectFresh(h: ReturnType<typeof createHarness>, query: string) {
  const expected = await execute({ document: parse(query), schema: h.schema });
  const { result } = await h.run(query);
  const actual = { ...result };
  delete actual.extensions;
  expect(actual).toEqual(expected);
}

describe("self-referencing entities", () => {
  const variants: [string, string][] = [
    ["A>A", "D>D"],
    ["A>A", "D>E"],
    ["A>B,B>B", "D>D"],
    ["A>B,B>A", "D>D"],
    ["A>A", "D>A"],
    ["A>B,B>C", "D>B"],
  ];

  for (const resolver of ["book", "node"]) {
    test.each(variants)(
      `${resolver}: initially %s, then A>D with %s`,
      async (initial, after) => {
        const books: Record<string, { sequel: string | null }> = {};
        for (const id of ["A", "B", "C", "D", "E"]) {
          books[id] = { sequel: null };
        }
        for (const pair of initial.split(",")) {
          books[pair[0]].sequel = pair[2];
        }
        const book = (id: string | null) =>
          id ? { __typename: "Book", id, name: `n${id}`, ...books[id] } : null;
        const h = createHarness({
          cache: await memoryCacheFactory(),
          resolvers: {
            Book: { sequel: (b: any) => book(b.sequel) },
            Query: {
              best: () => book("A"),
              book: (_: unknown, { id }: any) => book(id),
              node: (_: unknown, { id }: any) => book(id),
            },
          },
          typeDefs: `
            interface Node { id: ID! }
            type Query {
              best: Book
              book(id: ID!): Book ${resolver === "book" ? "@cacheResolver" : ""}
              node(id: ID!): Node ${resolver === "node" ? "@cacheResolver" : ""}
            }
            type Book implements Node { id: ID! name: String! sequel: Book }`,
        });
        const query = `{ best { id sequel { id sequel { id name } } } }`;

        await expectFresh(h, query);
        books.A.sequel = "D";
        books.D.sequel = after[2];
        await h.strategy.invalidateEntities([
          { id: "A", typename: "Book" },
          { id: "D", typename: "Book" },
        ]);
        await expectFresh(h, query);
        await expectFresh(h, query);
      },
    );
  }
});

describe("reading a result while another request refreshes it", () => {
  function gatedCache(base: Cache) {
    let gate: Promise<void> | undefined;
    let arrived: () => void = () => {};
    const cache: Cache = {
      ...base,
      // The strategy reads the entity references after the result.
      getSetMembers: async (key: string) => {
        if (gate) {
          const current = gate;
          gate = undefined;
          arrived();
          await current;
        }
        return base.getSetMembers(key);
      },
    };
    return {
      cache,
      pause() {
        let release!: () => void;
        gate = new Promise<void>((resolve) => (release = resolve));
        const reached = new Promise<void>((resolve) => (arrived = resolve));
        return { reached, release };
      },
    };
  }

  for (const withResolver of [false, true]) {
    test(`stale data is neither served nor stored (cache resolver: ${withResolver})`, async () => {
      const { cache, pause } = gatedCache(await memoryCacheFactory());
      const state: Record<string, number> = { 1: 1, 2: 1 };
      const h = createHarness({
        cache,
        resolvers: {
          Query: {
            item: (_: unknown, { id }: any) => ({ id, v: state[id] }),
            items: () => [
              { id: "1", v: state[1] },
              { id: "2", v: state[2] },
            ],
          },
        },
        typeDefs: `
          type Query { items: [Item!]! item(id: ID!): Item ${withResolver ? "@cacheResolver" : ""} }
          type Item { id: ID! v: Int! }`,
      });
      const query = `{ items { id v } }`;

      await h.run(query);
      state[1] = 2;
      await h.strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

      // A reads the old result, then stalls before reading its references.
      const { reached, release } = pause();
      const a = h.run(query);
      await reached;

      // B refreshes item 1 and stores; item 2 changes afterwards.
      await expectFresh(h, query);
      state[2] = 2;
      await h.strategy.invalidateEntities([{ id: "2", typename: "Item" }]);

      release();
      // A started after item 1's invalidation completed.
      expect(((await a).result.data as any).items[0].v).toBe(2);

      await expectFresh(h, query);
      await expectFresh(h, query);
    });
  }
});
