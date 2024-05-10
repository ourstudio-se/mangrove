import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  PARTIAL_CACHE_ALIASPREFIX,
} from "./constants";
import { CacheResolverMap } from "./typings";
import { bindExecute, layeredCacheExecute } from "./runner";
import { execute, parse, print } from "graphql";
import { gql } from "./utils";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { parseClientQuery } from "./parser";
import { parseSelectionSet } from "@graphql-tools/utils";

const bindExecuteArgs = bindExecute(execute);

describe("layeredCacheExecute", () => {
  test("handles multiple rounds of link query delegation", async () => {
    const data = { a: { b: { c: { id: "3" }, id: "2" }, id: "1" } };
    const schema = makeExecutableSchema({
      resolvers: {
        Query: {
          a: () => data.a,
          b: () => data.a.b,
          c: () => data.a.b.c,
        },
      },
      typeDefs: gql`
        schema {
          query: Query
        }
        type A {
          id: ID
          b: B
        }
        type B {
          id: ID
          c: C
        }
        type C {
          id: ID
        }
        type Query {
          a(id: String): A
          b(id: String): B
          c(id: String): C
        }
      `,
    });
    const partialQuery = parseClientQuery(
      parse(gql`
        query MyQuery {
          ${PARTIAL_CACHE_ALIASPREFIX}someQuery_a_0: a(id: "1") {
            id @idField
            b {
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              ${ALIAS_ENTITYCACHE_ID}: id
            }
          }
        }
      `),
    );

    const runQuery = bindExecuteArgs({ schema });

    const resolvers: CacheResolverMap = {
      A: {
        idArg: "id",
        rootField: "a",
        type: "string",
      },
      B: {
        idArg: "id",
        rootField: "b",
        type: "string",
      },
      C: {
        idArg: "id",
        rootField: "c",
        type: "string",
      },
    };

    const linkSelections = {
      "Query.someQuery.a": parseSelectionSet(gql`
        {
          id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          ${ALIAS_ENTITYCACHE_ID}: id 
          b {
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            ${ALIAS_ENTITYCACHE_ID}: id 
          }
        }
      `),
      "Query.someQuery.a.b": parseSelectionSet(gql`
        {
          id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          ${ALIAS_ENTITYCACHE_ID}: id 
          c {
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            ${ALIAS_ENTITYCACHE_ID}: id 
          }
        }
      `),
      "Query.someQuery.a.b.c": parseSelectionSet(gql`
        {
          id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          ${ALIAS_ENTITYCACHE_ID}: id 
        } 
      `),
    };

    const result = await layeredCacheExecute({
      knownEntities: {},
      linkSelections,
      originalOperationName: "MyQuery",
      partialQuery,
      resolvers,
      runQuery,
    });

    const linkQueries = result.linkQueries;

    expect(print(linkQueries[0])).toBe(gql`query MyQuery__linkQuery {
  ${PARTIAL_CACHE_ALIASPREFIX}someQuery_a_b_0: b(id: "2") {
    id
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    ${ALIAS_ENTITYCACHE_ID}: id
    c {
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      ${ALIAS_ENTITYCACHE_ID}: id
    }
  }
}`);

    expect(print(linkQueries[1])).toBe(gql`query MyQuery__linkQuery {
  ${PARTIAL_CACHE_ALIASPREFIX}someQuery_a_b_c_0: c(id: "3") {
    id
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    ${ALIAS_ENTITYCACHE_ID}: id
  }
}`);
  });
});
