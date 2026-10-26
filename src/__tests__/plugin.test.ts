/* eslint-disable @typescript-eslint/no-explicit-any */
import { envelop, useEngine, useSchema } from "@envelop/core";
import {
  execute,
  parse,
  print,
  specifiedRules,
  subscribe,
  validate,
} from "graphql";
import { CacheResolverMap } from "../typings.js";
import { DIRECTIVES } from "./harness.js";
import { createMemoryCache } from "../caches/memory.js";
import { lazyInvalidationStrategy } from "../invalidationStrategies/lazyInvalidationStrategy.js";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { useMangrove } from "../plugin.js";

function setup(
  options: {
    cacheResolvers?: CacheResolverMap;
    includeExtensionMetadata?: boolean;
  } = {},
) {
  const items = [{ data: "one", id: "1" }];
  const calls = { items: 0 };
  const schema = makeExecutableSchema({
    resolvers: {
      Mutation: {
        rename: (_: unknown, { data }: any) => (
          (items[0].data = data), items[0]
        ),
      },
      Query: {
        item: (_: unknown, { id }: any) => items.find((i) => i.id === id),
        items: () => (calls.items++, items),
      },
    },
    typeDefs: [
      DIRECTIVES,
      `
      type Query { items: [Item!]! item(id: ID!): Item @cacheResolver }
      type Mutation { rename(data: String!): Item! }
      type Item { id: ID! data: String! }`,
    ],
  });
  const strategy = lazyInvalidationStrategy({ cache: createMemoryCache() });
  const getEnveloped = envelop({
    plugins: [
      useEngine({ execute, parse, specifiedRules, subscribe, validate }),
      useSchema(schema),
      useMangrove({
        awaitWriteBeforeResponse: true,
        invalidationStrategy: strategy,
        session: () => null,
        ttl: 60_000,
        ...options,
      }),
    ],
  });

  async function run(source: string) {
    const enveloped = getEnveloped({});
    const document = enveloped.parse(source);
    const errors = enveloped.validate(enveloped.schema, document);
    if (errors.length > 0) {
      throw errors[0];
    }
    return (await enveloped.execute({
      contextValue: await enveloped.contextFactory(),
      document,
      schema: enveloped.schema,
    })) as any;
  }

  return { calls, getEnveloped, items, run, strategy };
}

describe("useMangrove", () => {
  test("caches, and partially re-executes after invalidation", async () => {
    const { calls, items, run, strategy } = setup();
    const query = `{ items { id data } }`;

    expect((await run(query)).data).toEqual({
      items: [{ data: "one", id: "1" }],
    });
    expect((await run(query)).data).toEqual({
      items: [{ data: "one", id: "1" }],
    });
    expect(calls.items).toBe(1);

    items[0].data = "uno";
    await strategy.invalidateEntities([{ id: "1", typename: "Item" }]);

    const result = await run(query);
    expect(result.data).toEqual({ items: [{ data: "uno", id: "1" }] });
    expect(result.extensions).toBeUndefined();
    // Item 1 was re-resolved through `item(id:)`, not through the list.
    expect(calls.items).toBe(1);
  });

  test("mutations run normally, without marker fields", async () => {
    const { run } = setup();
    const result = await run(`
      fragment I on Item { id data }
      mutation { rename(data: "x") { ...I } }`);
    expect(result).toEqual({ data: { rename: { data: "x", id: "1" } } });
  });

  test("does not modify the configured cache resolvers", async () => {
    const cacheResolvers: CacheResolverMap = {};
    const { run } = setup({ cacheResolvers });
    await run(`{ items { id } }`);
    expect(cacheResolvers).toEqual({});
  });

  test("metadata is only exposed when asked for", async () => {
    const { run } = setup({ includeExtensionMetadata: true });
    const result = await run(`{ items { id } }`);
    expect(result.extensions.cache.hit).toBe(false);
    expect(Object.keys(result.data.items[0])).toEqual(["id"]);
  });

  test("parse decorates queries only", async () => {
    const { getEnveloped } = setup();
    const { parse: parseWithPlugins } = getEnveloped({});
    expect(print(parseWithPlugins(`{ items { id } }`))).toContain(
      "__entityCacheId: id",
    );
    expect(
      print(parseWithPlugins(`mutation { rename(data: "x") { id } }`)),
    ).not.toContain("__entityCacheId");
    expect(print(parse(`{ items { id } }`))).not.toContain("__entityCacheId");
  });
});
