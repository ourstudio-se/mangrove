/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Differential test: random sequences of changes to the data, each followed
 * by the invalidations the caching model requires (the entity whose fields
 * changed, or Query for root fields). After every step, each query served
 * through Mangrove must equal executing it directly.
 */
import {
  CacheFactory,
  createHarness,
  memoryCacheFactory,
  redisCacheFactory,
  startRedis,
  stopRedis,
} from "./harness.js";
import { EntityRecord } from "../typings.js";
import { execute, parse } from "graphql";
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

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const typeDefs = (withResolvers: boolean) => `
  type Query {
    items: [Item!]!
    featured: Item
    owners: [Owner!]!
    search: [SearchResult!]!
    item(id: ID!): Item ${withResolvers ? "@cacheResolver" : ""}
    owner(id: ID!): Owner ${withResolvers ? "@cacheResolver" : ""}
  }
  type Item { id: ID! name: String! owner: Owner! tags: [Tag!]! note(prefix: String): String }
  type Owner { id: ID! name: String! items: [Item!]! }
  type Tag { id: ID! label: String! }
  union SearchResult = Item | Owner
`;

const QUERIES: [string, Record<string, unknown>?][] = [
  [`{ items { id name owner { id name } } }`],
  [
    `{ featured { id name tags { id label } owner { id name items { id name } } } }`,
  ],
  [
    `query Q($p: String) { owners { id name items { id note(prefix: $p) tags { label } } } }`,
    { p: ">" },
  ],
  [
    `fragment I on Item { id name owner { name } }
     query S { search { ... on Item { ...I } ... on Owner { id name } } top: featured { ...I } }`,
  ],
  [
    `{ items { id tags { id label } } a: featured { id } b: featured { name } }`,
  ],
];

interface State {
  featured: string | null;
  items: Record<string, { name: string; owner: string; tags: string[] }>;
  itemOrder: string[];
  owners: Record<string, { name: string }>;
  search: [string, string][];
  tags: Record<string, { label: string }>;
}

function initialState(): State {
  return {
    featured: "i1",
    itemOrder: ["i1", "i2", "i3"],
    items: {
      i1: { name: "one", owner: "o1", tags: ["t1"] },
      i2: { name: "two", owner: "o1", tags: [] },
      i3: { name: "three", owner: "o2", tags: ["t1", "t2"] },
    },
    owners: { o1: { name: "Ann" }, o2: { name: "Bob" } },
    search: [
      ["Item", "i2"],
      ["Owner", "o1"],
    ],
    tags: { t1: { label: "red" }, t2: { label: "blue" } },
  };
}

function makeResolvers(state: State) {
  const item = (id: string) =>
    state.items[id] ? { __typename: "Item", id, ...state.items[id] } : null;
  const owner = (id: string) =>
    state.owners[id] ? { __typename: "Owner", id, ...state.owners[id] } : null;
  return {
    Item: {
      note: (i: any, { prefix }: any) => `${prefix ?? ""}${i.name}`,
      owner: (i: any) => owner(i.owner),
      tags: (i: any) => i.tags.map((id: string) => ({ id, ...state.tags[id] })),
    },
    Owner: {
      items: (o: any) =>
        state.itemOrder
          .filter((id) => state.items[id].owner === o.id)
          .map(item),
    },
    Query: {
      featured: () => (state.featured ? item(state.featured) : null),
      item: (_: unknown, { id }: any) => item(id),
      items: () => state.itemOrder.map(item),
      owner: (_: unknown, { id }: any) => owner(id),
      owners: () => Object.keys(state.owners).map(owner),
      search: () =>
        state.search.flatMap(([type, id]) => {
          const value = type === "Item" ? item(id) : owner(id);
          return value ? [value] : [];
        }),
    },
  };
}

type Mutation = (state: State, rand: () => number) => EntityRecord[] | null;

const pick = <T>(rand: () => number, list: T[]): T | undefined =>
  list[Math.floor(rand() * list.length)];

let counter = 100;

const MUTATIONS: [string, Mutation][] = [
  [
    "rename item",
    (s, r) => {
      const id = pick(r, s.itemOrder);
      if (!id) return null;
      s.items[id].name = `item${counter++}`;
      return [{ id, typename: "Item" }];
    },
  ],
  [
    "rename owner",
    (s, r) => {
      const id = pick(r, Object.keys(s.owners))!;
      s.owners[id].name = `owner${counter++}`;
      return [{ id, typename: "Owner" }];
    },
  ],
  [
    "relabel tag",
    (s, r) => {
      const id = pick(r, Object.keys(s.tags))!;
      s.tags[id].label = `tag${counter++}`;
      return [{ id, typename: "Tag" }];
    },
  ],
  [
    "change item owner",
    (s, r) => {
      const id = pick(r, s.itemOrder);
      if (!id) return null;
      const from = s.items[id].owner;
      const to = pick(r, Object.keys(s.owners))!;
      s.items[id].owner = to;
      return [
        { id, typename: "Item" },
        { id: from, typename: "Owner" },
        { id: to, typename: "Owner" },
      ];
    },
  ],
  [
    "change item tags",
    (s, r) => {
      const id = pick(r, s.itemOrder);
      if (!id) return null;
      s.items[id].tags = Object.keys(s.tags).filter(() => r() < 0.5);
      return [{ id, typename: "Item" }];
    },
  ],
  [
    "add item",
    (s, r) => {
      const id = `i${counter++}`;
      const owner = pick(r, Object.keys(s.owners))!;
      s.items[id] = { name: `new${id}`, owner, tags: [] };
      s.itemOrder.splice(Math.floor(r() * (s.itemOrder.length + 1)), 0, id);
      return [{ typename: "Query" }, { id: owner, typename: "Owner" }];
    },
  ],
  [
    "remove item",
    (s, r) => {
      const id = pick(r, s.itemOrder);
      if (!id) return null;
      const owner = s.items[id].owner;
      s.itemOrder = s.itemOrder.filter((i) => i !== id);
      s.search = s.search.filter(([, i]) => i !== id);
      if (s.featured === id) s.featured = s.itemOrder[0] ?? null;
      delete s.items[id];
      return [
        { typename: "Query" },
        { id: owner, typename: "Owner" },
        { id, typename: "Item" },
      ];
    },
  ],
  [
    "reorder items",
    (s, r) => {
      s.itemOrder.sort(() => r() - 0.5);
      // Owner.items follows the global order too.
      return [{ typename: "Query" }, { typename: "Owner" }];
    },
  ],
  [
    "change featured",
    (s, r) => {
      s.featured = r() < 0.2 ? null : pick(r, s.itemOrder) ?? null;
      return [{ typename: "Query" }];
    },
  ],
  [
    "change search",
    (s, r) => {
      const entries: [string, string][] = [
        ...s.itemOrder.map((id): [string, string] => ["Item", id]),
        ...Object.keys(s.owners).map((id): [string, string] => ["Owner", id]),
      ];
      s.search = entries.filter(() => r() < 0.4).sort(() => r() - 0.5);
      return [{ typename: "Query" }];
    },
  ],
  ["nothing", () => []],
];

const backends: [string, () => CacheFactory, boolean][] = [
  ["memory", () => memoryCacheFactory, true],
  ["redis", () => redisCacheFactory(redisUrl!), redisAvailable],
];

// Scale up with e.g. FUZZ_SEEDS=200 FUZZ_STEPS=200.
const SEEDS = Array.from(
  { length: Number(process.env.FUZZ_SEEDS ?? 6) },
  (_, i) => i + 1,
);
const STEPS = Number(process.env.FUZZ_STEPS ?? 60);

for (const [backend, getFactory, available] of backends) {
  (available ? describe : describe.skip)(`${backend} cache`, () => {
    for (const withResolvers of [true, false]) {
      for (const seed of SEEDS) {
        test(`seed ${seed}, cache resolvers: ${withResolvers}`, async () => {
          const rand = mulberry32(seed);
          const state = initialState();
          const h = createHarness({
            cache: await getFactory()(),
            resolvers: makeResolvers(state),
            typeDefs: typeDefs(withResolvers),
          });
          const history: string[] = [];

          for (let step = 0; step < STEPS; step++) {
            const [name, mutate] = pick(rand, MUTATIONS)!;
            const invalidations = mutate(state, rand);
            if (invalidations === null) continue;
            history.push(`${name} -> ${JSON.stringify(invalidations)}`);
            if (invalidations.length > 0) {
              await h.strategy.invalidateEntities(invalidations);
            }

            for (const [query, variables] of QUERIES) {
              // Not every query runs every step, so cache states diverge.
              if (rand() < 0.3) continue;

              const expected = await execute({
                document: parse(query),
                schema: h.schema,
                variableValues: variables,
              });
              const { result, executed } = await h.run(query, { variables });
              const actual = { ...result };
              delete actual.extensions;

              if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                throw new Error(
                  [
                    `Mismatch for seed ${seed} at step ${step} running ${query}`,
                    `expected ${JSON.stringify(expected)}`,
                    `received ${JSON.stringify(actual)}`,
                    "executed:",
                    ...executed,
                    "history:",
                    ...history,
                  ].join("\n"),
                );
              }
            }
          }

          expect(h.logger.errors).toEqual([]);
        });
      }
    }
  });
}
