import {
  ALIAS_ENTITYCACHE_ID as ID,
  ALIAS_ENTITYCACHE_TYPENAME as TYPENAME,
} from "../constants.js";
import { CacheMergeError, createMergeContext, mergeData } from "../merge.js";
import { DIRECTIVES, RecordingLogger } from "./harness.js";
import { Kind, parse, print, specifiedRules, validate } from "graphql";
import { getCacheResolverAlias, parseCacheResolverAlias } from "../alias.js";
import { idToValueNode } from "../getCacheResolutionMapper.js";
import { makeBySchemaConfigGenerator } from "../schemaConfig.js";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { noAliasConventionConflictsRule } from "../rules/noAliasConventionConflictsRule.js";
import { parseClientQuery } from "../parser.js";

describe("cache resolver aliases", () => {
  test.each([
    "Query.a",
    "Query.dashboard.my_field",
    "Query.a_b.c",
    "Query.a.b_c",
    "Query._private.__x",
    "Query.address_2",
    "Query.x_i3",
  ])("round-trip %s", (coordinates) => {
    for (const index of [0, 7, 123]) {
      const alias = getCacheResolverAlias(coordinates, index);
      expect(alias).toMatch(/^[_A-Za-z][_0-9A-Za-z]*$/);
      expect(parseCacheResolverAlias(alias)).toBe(coordinates);
    }
  });

  test("distinct coordinates never share an alias", () => {
    expect(getCacheResolverAlias("Query.a_b.c", 0)).not.toBe(
      getCacheResolverAlias("Query.a.b_c", 0),
    );
  });
});

describe("id literals", () => {
  test("strings are never parsed as GraphQL source", () => {
    expect(
      idToValueNode({ idArg: "id", rootField: "x", type: "string" }, 'x"y\\n'),
    ).toEqual({ kind: Kind.STRING, value: 'x"y\\n' });
  });

  test("invalid numbers are rejected", () => {
    const int = { idArg: "id", rootField: "x", type: "int" } as const;
    expect(idToValueNode(int, "-12")).toEqual({ kind: Kind.INT, value: "-12" });
    expect(() => idToValueNode(int, "abc")).toThrow();
    expect(() => idToValueNode(int, "1e3")).toThrow();
  });
});

describe("mergeData", () => {
  const entity = (typename: string, id: string, rest: object = {}) => ({
    [ID]: id,
    [TYPENAME]: typename,
    ...rest,
  });

  test("replaces an entity with a different one at the same position", () => {
    const cached = { a: entity("T", "1", { x: 1, y: 1 }) };
    const context = createMergeContext(cached);
    const merged = mergeData(
      structuredClone(cached),
      { a: entity("T", "2", { x: 2 }) },
      "Query",
      context,
    );
    expect(merged).toEqual({ a: entity("T", "2", { x: 2 }) });
  });

  test("fills a link stub from a snapshot at the same coordinates", () => {
    const cached = {
      users: [
        { fav: entity("I", "1", { n: "one" }) },
        { fav: entity("I", "2", { n: "two" }) },
      ],
    };
    const context = createMergeContext(cached);
    const merged = mergeData(
      structuredClone(cached),
      { users: [{ fav: entity("I", "2") }, { fav: entity("I", "1") }] },
      "Query",
      context,
    );
    expect(merged).toEqual({
      users: [
        { fav: entity("I", "2", { n: "two" }) },
        { fav: entity("I", "1", { n: "one" }) },
      ],
    });
  });

  test("an identity change at a pruned position is an error", () => {
    const cached = { a: entity("T", "1", { b: entity("U", "1", { x: 1 }) }) };
    const context = createMergeContext(cached, ["Query.a.b"]);
    expect(() =>
      mergeData(
        structuredClone(cached),
        { a: entity("T", "1", { b: entity("U", "2", { x: 2 }) }) },
        "Query",
        context,
      ),
    ).toThrow(CacheMergeError);
  });
});

describe("schema configuration", () => {
  function configure(typeDefs: string) {
    const logger = new RecordingLogger();
    const schema = makeExecutableSchema({ typeDefs: [DIRECTIVES, typeDefs] });
    const config = makeBySchemaConfigGenerator({
      idFields: new Set(["id"]),
      logger,
    })(schema);
    return { config, logger, schema };
  }

  test("key argument types", () => {
    const { config, logger } = configure(`
      type Query {
        a(id: ID!): A @cacheResolver
        b(id: Float!): B @cacheResolver
        c(id: Long!): C @cacheResolver
        d(ids: [Int!]!): [D!]! @cacheResolver
      }
      scalar Long
      type A { id: ID! } type B { id: Float! } type C { id: Long! } type D { id: Int! }`);

    expect(config.cacheResolvers.A).toEqual({
      batch: false,
      idArg: "id",
      rootField: "a",
      type: "string",
    });
    expect(config.cacheResolvers.B?.type).toBe("float");
    expect(config.cacheResolvers.C).toBeUndefined();
    expect(config.cacheResolvers.D).toEqual({
      batch: true,
      idArg: "ids",
      rootField: "d",
      type: "int",
    });
    expect(logger.warnings).toHaveLength(1);
  });

  test("rejects unusable root fields", () => {
    const { config, logger } = configure(`
      type Query {
        a(id: ID!, locale: String!): A @cacheResolver
        b(wrong: ID!): B @cacheResolver(keyArg: "id")
        c(id: ID!, locale: String = "en"): C @cacheResolver
      }
      type A { id: ID! } type B { id: ID! } type C { id: ID! }`);

    expect(config.cacheResolvers.A).toBeUndefined();
    expect(config.cacheResolvers.B).toBeUndefined();
    expect(config.cacheResolvers.C?.idArg).toBe("id");
    expect(logger.warnings).toHaveLength(2);
  });

  test("abstract root fields resolve every possible type", () => {
    const { config } = configure(`
      type Query { node(id: ID!): Node @cacheResolver article(id: ID!): Article @cacheResolver }
      interface Node { id: ID! }
      type Article implements Node { id: ID! }
      type Video implements Node { id: ID! }`);

    expect(config.cacheResolvers.Video?.rootField).toBe("node");
    // Concrete resolvers take precedence.
    expect(config.cacheResolvers.Article?.rootField).toBe("article");
  });

  test("the parser identifies entities behind interfaces and unions", () => {
    const { config, schema } = configure(`
      type Query { node: Node u: U }
      interface Node { id: ID! }
      union U = A | B | V
      type A implements Node { id: ID! }
      type B implements Node { id: ID! }
      type V { value: Int }`);

    const document = config.parser(
      parse(`{ node { id } u { ... on V { value } } }`),
    );

    expect(validate(schema, document)).toEqual([]);
    const printed = print(document);
    expect(printed).toContain(
      `node {\n    id\n    ${TYPENAME}: __typename\n    ${ID}: id`,
    );
    expect(printed).toContain(`... on A {\n      ${ID}: id`);
    expect(printed).toContain(`... on B {\n      ${ID}: id`);
    expect(printed).not.toContain("... on V {\n      __entityCacheId");
  });

  test("documents with mutations are left alone", () => {
    const { config } = configure(`
      type Query { a: A } type Mutation { a: A } type A { id: ID! }`);
    const document = parse(`
      fragment F on A { id }
      mutation M { a { ...F } }
      query Q { a { ...F } }`);
    expect(config.parser(document)).toBe(document);
    expect(print(parseClientQuery(document))).not.toContain(TYPENAME);
  });
});

describe("noAliasConventionConflictsRule", () => {
  const schema = makeExecutableSchema({
    typeDefs: `type Query { a: Int b: B } type B { c: Int }`,
  });
  const rules = [...specifiedRules, noAliasConventionConflictsRule];

  test("accepts ordinary documents", () => {
    expect(validate(schema, parse(`{ a x: a b { c } }`), rules)).toEqual([]);
  });

  test("rejects reserved aliases, including in fragments", () => {
    const errors = validate(
      schema,
      parse(`
        fragment F on Query { _ENTITY_x: a }
        { ...F b { _ENTITY_y: c } }`),
      rules,
    );
    expect(errors).toHaveLength(2);
  });
});
