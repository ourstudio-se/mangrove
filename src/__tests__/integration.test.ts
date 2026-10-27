/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end over HTTP: Mangrove as a Yoga plugin, and Mangrove wrapping an
 * HTTP executor in front of a plain Yoga server (which validates every
 * document Mangrove generates).
 */
import { AddressInfo } from "node:net";
import { CacheResolverMap } from "../typings.js";
import { DIRECTIVES } from "./harness.js";
import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { createMemoryCache } from "../caches/memory.js";
import { createServer, Server } from "node:http";
import { createYoga } from "graphql-yoga";
import { getIntrospectionQuery, parse } from "graphql";
import { lazyInvalidationStrategy } from "../invalidationStrategies/lazyInvalidationStrategy.js";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { makeExecutorWrapper } from "../runner.js";
import { makeResultProcessor } from "../resultProcessor.js";
import { parseClientQuery } from "../parser.js";
import { useMangrove } from "../plugin.js";

function createData() {
  const owners: Record<string, any> = {
    o1: { id: "o1", name: "Ann" },
    o2: { id: "o2", name: "Bob" },
  };
  const items: any[] = [
    { id: "1", name: "one", owner: "o1" },
    { id: "2", name: "two", owner: "o2" },
  ];
  const calls = { item: 0, items: 0, owner: 0 };
  const schema = makeExecutableSchema({
    resolvers: {
      Item: { owner: (item: any) => owners[item.owner] },
      Mutation: {
        rename: (_: unknown, { id, name }: any) => {
          const item = items.find((i) => i.id === id);
          item.name = name;
          return item;
        },
      },
      Query: {
        item: (_: unknown, { id }: any) => {
          calls.item++;
          return items.find((i) => i.id === id) ?? null;
        },
        items: (_: unknown, { first }: any) => {
          calls.items++;
          return first === undefined ? items : items.slice(0, first);
        },
        owner: (_: unknown, { id }: any) => {
          calls.owner++;
          return owners[id] ?? null;
        },
      },
    },
    typeDefs: [
      DIRECTIVES,
      `
      type Query {
        items(first: Int): [Item!]!
        item(id: ID!): Item @cacheResolver
        owner(id: ID!): Owner @cacheResolver
      }
      type Mutation { rename(id: ID!, name: String!): Item! }
      type Item { id: ID! name: String! owner: Owner! }
      type Owner { id: ID! name: String! }`,
    ],
  });
  return { calls, items, owners, schema };
}

async function listen(handler: any): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/graphql` };
}

async function post(url: string, body: object) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return (await response.json()) as any;
}

describe("as a Yoga plugin", () => {
  let server: Server;
  let url: string;
  let data: ReturnType<typeof createData>;
  let strategy: ReturnType<typeof lazyInvalidationStrategy>;

  beforeEach(async () => {
    data = createData();
    strategy = lazyInvalidationStrategy({ cache: createMemoryCache() });
    const yoga = createYoga({
      logging: false,
      plugins: [
        useMangrove({
          awaitWriteBeforeResponse: true,
          invalidationStrategy: strategy,
          session: () => null,
          ttl: 60_000,
        }),
      ],
      schema: data.schema,
    });
    ({ server, url } = await listen(yoga));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("caches and partially refreshes queries", async () => {
    const query = `query Q($first: Int) { items(first: $first) { id name owner { id name } } }`;
    const body = { query, variables: { first: 2 } };

    const first = await post(url, body);
    expect(first).toEqual({
      data: {
        items: [
          { id: "1", name: "one", owner: { id: "o1", name: "Ann" } },
          { id: "2", name: "two", owner: { id: "o2", name: "Bob" } },
        ],
      },
    });
    expect(await post(url, body)).toEqual(first);
    expect(data.calls.items).toBe(1);

    data.owners.o1.name = "Anna";
    await strategy.invalidateEntities([{ id: "o1", typename: "Owner" }]);

    const refreshed = await post(url, body);
    expect(refreshed.data.items[0].owner.name).toBe("Anna");
    expect(data.calls.items).toBe(1);
    expect(data.calls.owner).toBe(1);
  });

  test("mutations, multiple operations and introspection", async () => {
    const document = `
      fragment I on Item { id name }
      query Get { items { ...I } }
      mutation Rename { rename(id: "1", name: "uno") { ...I } }`;

    expect(
      (await post(url, { operationName: "Get", query: document })).data
        .items[0],
    ).toEqual({
      id: "1",
      name: "one",
    });
    expect(
      await post(url, { operationName: "Rename", query: document }),
    ).toEqual({
      data: { rename: { id: "1", name: "uno" } },
    });

    const introspection = await post(url, { query: getIntrospectionQuery() });
    expect(introspection.errors).toBeUndefined();
    expect(introspection.data.__schema.queryType.name).toBe("Query");
  });
});

describe("wrapping an HTTP executor", () => {
  let server: Server;
  let url: string;
  let data: ReturnType<typeof createData>;

  beforeEach(async () => {
    data = createData();
    // A plain server: it validates every document Mangrove sends it.
    const yoga = createYoga({ logging: false, schema: data.schema });
    ({ server, url } = await listen(yoga));
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("caches on the client, with resolutions and link queries over HTTP", async () => {
    const cacheResolvers: CacheResolverMap = {
      Item: { idArg: "id", rootField: "item", type: "string" },
      Owner: { idArg: "id", rootField: "owner", type: "string" },
    };
    const strategy = lazyInvalidationStrategy({ cache: createMemoryCache() });
    const executor = makeExecutorWrapper({
      cacheResolvers,
      getPartialExecutionOpts: strategy.getPartialExecutionOpts,
      processResult: makeResultProcessor({
        awaitWriteBeforeResponse: true,
        storeExecutionResult: strategy.storeExecutionResult,
        ttl: 60_000,
      }),
      session: () => null,
    })(buildHTTPExecutor({ endpoint: url }));

    const document = parseClientQuery(
      parse(`
        query Q($first: Int) {
          items(first: $first) {
            id @idField
            name
            owner { id @idField name }
          }
        }
      `),
    );
    const run = async () =>
      (await executor({ document, variables: { first: 10 } })) as any;

    const first = await run();
    expect(first.errors).toBeUndefined();
    expect(first.data.items).toHaveLength(2);
    expect((await run()).data).toEqual(first.data);
    expect(data.calls.items).toBe(1);

    // Re-resolve one entity through its cache resolver.
    data.items[1].name = "deux";
    await strategy.invalidateEntities([{ id: "2", typename: "Item" }]);
    const second = await run();
    expect(second.errors).toBeUndefined();
    expect(second.data.items[1].name).toBe("deux");
    expect(data.calls.items).toBe(1);
    expect(data.calls.item).toBe(1);

    // A new list member is fetched through a link query, known ones aren't.
    data.items.push({ id: "3", name: "three", owner: "o1" });
    await strategy.invalidateEntities([{ typename: "Query" }]);
    const third = await run();
    expect(third.errors).toBeUndefined();
    expect(third.data.items.map((i: any) => i.name)).toEqual([
      "one",
      "deux",
      "three",
    ]);
    expect(third.data.items[2].owner).toEqual({ id: "o1", name: "Ann" });
    expect(data.calls.items).toBe(2);
    expect(data.calls.item).toBe(2);
  });
});
