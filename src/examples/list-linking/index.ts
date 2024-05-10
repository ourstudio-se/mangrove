import { ExecutionResult, execute as _execute, parse } from "graphql";
import { Redis } from "ioredis";
import { animals, uniqueNamesGenerator } from "unique-names-generator";
import { createRedisCache } from "../../caches/redis";
import { gql } from "../../utils";
import { lazyInvalidationStrategy } from "../../invalidationStrategies/lazyInvalidationStrategy";
import { makeBySchemaConfigGenerator } from "../../schemaConfig";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { makeExecuteWrapper } from "../../runner";
import { makeResultFormatter } from "../../resultFormatter";
import { makeResultProcessor } from "../../resultProcessor";

interface Item {
  id: string;
}

interface BigItemQuery {
  items: Item[];
}

const items: Item[] = [{ id: "1" }, { id: "2" }];

const schema = makeExecutableSchema({
  resolvers: {
    Item: {
      data: () => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              uniqueNamesGenerator({
                dictionaries: [animals],
                style: "capital",
              }),
            );
          }, 500);
        });
      },
    },
    Query: {
      item: (_: any, { id }: { id: string }) => {
        return items.find((item) => item.id === id);
      },
      items: () => items,
    },
  },
  typeDefs: gql`
    directive @cacheResolver on FIELD_DEFINITION

    schema {
      query: Query
    }

    type Query {
      items: [Item!]!
      item(id: ID!): Item @cacheResolver
    }

    type Item {
      id: ID!
      data: String!
    }
  `,
});

const configBySchema = makeBySchemaConfigGenerator({
  idFields: new Set(["id"]),
});

const config = configBySchema(schema);

const client = new Redis();

const cache = createRedisCache({ client });

const { getPartialExecutionOpts, invalidateEntities, storeExecutionResult } =
  lazyInvalidationStrategy({ cache });

const ttl = 60 * 60 * 1000;

const processResult = makeResultProcessor({
  ...config,
  awaitWriteBeforeResponse: true,
  storeExecutionResult,
  ttl,
});

const sessionId = (Math.random() * 1000).toString();

const wrapExecute = makeExecuteWrapper({
  ...config,
  formatResult: makeResultFormatter({ includeExtensionMetadata: true, ttl }),
  getPartialExecutionOpts,
  processResult,
  session: () => sessionId,
});

const execute = wrapExecute(_execute);

const document = config.parser(
  parse(gql`
    query BigItemQuery {
      items {
        id
        data
      }
    }
  `),
);

(async () => {
  let result: ExecutionResult<BigItemQuery> = (await execute({
    document,
    schema,
  })) as any;

  // eslint-disable-next-line no-console
  console.log(result.data?.items);

  items.push({
    id: "3",
  });

  await invalidateEntities([
    {
      typename: "Query",
    },
  ]);

  result = (await execute({
    document,
    schema,
  })) as any;

  // eslint-disable-next-line no-console
  console.log(result.data?.items);

  await invalidateEntities([
    {
      id: "1",
      typename: "Item",
    },
  ]);

  result = (await execute({
    document,
    schema,
  })) as any;

  // eslint-disable-next-line no-console
  console.log(result.data?.items);

  items.push(items.shift()!);

  await invalidateEntities([
    {
      typename: "Query",
    },
  ]);

  result = (await execute({
    document,
    schema,
  })) as any;
  // eslint-disable-next-line no-console
  console.log(result.data?.items);

  process.exit(0);
})();
