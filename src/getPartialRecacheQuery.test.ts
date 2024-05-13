import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  PARTIAL_CACHE_ALIASPREFIX,
} from "./constants";
import { CacheResolverMap, EntityCacheResult, Id } from "./typings";
import { buildEntityTreeNode, spawnTreeRoot } from "./tree";
import { getPartialRecacheQuery } from "./getPartialRecacheQuery";
import { gql, strToDataPath } from "./utils";
import { parse, print, stripIgnoredCharacters } from "graphql";
import { parseClientQuery } from "./parser";

// Mock entity creators functions
function _Entity(
  typename: string,
  id: Id,
  invalidated: boolean,
  path: string,
): EntityCacheResult {
  return {
    entity: {
      id,
      typename,
    },
    invalidated,
    path: strToDataPath(path),
  };
}
type EntityCacheResultMocker = (
  id: Id,
  invalidated: boolean,
  path: string,
) => EntityCacheResult;
const Dashboard: EntityCacheResultMocker = _Entity.bind(null, "Dashboard");
const Activity: EntityCacheResultMocker = _Entity.bind(null, "Activity");
const TodoItem: EntityCacheResultMocker = _Entity.bind(null, "TodoItem");
const UpdateInfo: EntityCacheResultMocker = _Entity.bind(null, "UpdateInfo");
const User: EntityCacheResultMocker = _Entity.bind(null, "User");

describe("getPartialRecacheQuery", () => {
  test("generates simple partial query", () => {
    const originalDocument = parse(gql`
      query FullQuery {
        dashboard {
          topActivity {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            title
            description
          }
          latestUpdates {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            date
            time
            text
          }
          todoList {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            label
            text
          }
        }
      }
    `);

    const entityCacheResults: readonly EntityCacheResult[] = [
      Dashboard(1, false, "Query.dashboard"),
      Activity(2, true, "Query.dashboard.topActivity"),
      UpdateInfo("1", false, "Query.dashboard.latestUpdates"),
      TodoItem("1", false, "Query.dashboard.todoList"),
    ];

    const cacheResolvers: CacheResolverMap = {};

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    // prettier-ignore
    expect(printedPartial).toBe(gql`query FullQuery {
  dashboard {
    topActivity {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      title
      description
    }
  }
}`);
  });

  test("always select full selection sets when traversing nonentity object types", () => {
    const originalDocument = parse(gql`
        query FullQuery {
          dashboard {
            someOtherField {
              someOtherStuff
            }
            activities {
              id
              author {
                ${ALIAS_ENTITYCACHE_ID}: id
                ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                name
              }
              category {
                name
              }
            }
          }
        }
      `);

    const entityCacheResults: readonly EntityCacheResult[] = [
      Dashboard(1, false, "Query.dashboard"),
      User("2", true, "Query.dashboard.activities.author"),
    ];

    const cacheResolvers: CacheResolverMap = {};

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    // prettier-ignore
    expect(printedPartial).toBe(gql`query FullQuery {
  dashboard {
    activities {
      id
      author {
        ${ALIAS_ENTITYCACHE_ID}: id
        ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
        name
      }
      category {
        name
      }
    }
  }
}`);
  });

  test("always take full selection when traversing a list", () => {
    const originalDocument = parse(gql`
      query FullQuery {
        dashboard {
          activities {
            author {
              name
            }
            thisShouldBeIncluded
          }
          thisShouldBePruned
        }
      }
    `);

    const entityCacheResults: EntityCacheResult[] = [
      Dashboard(1, false, "Query.dashboard"),
      Activity(1, false, "Query.dashboard.activities@0#1"),
      User(1, true, "Query.dashboard.activities@0#1.author"),
    ];

    const cacheResolvers: CacheResolverMap = {};

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("No result");
    }

    const printedPartial = print(result.query);

    // prettier-ignore
    expect(printedPartial).toBe(gql`query FullQuery {
  dashboard {
    activities {
      author {
        name
      }
      thisShouldBeIncluded
    }
  }
}`)
  });

  test("returns null for query without invalidations", () => {
    const originalDocument = parse(gql`
      query FullQuery {
        dashboard {
          topActivity {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            title
            description
          }
          latestUpdates {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            date
            time
            text
          }
          todoList {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            label
            text
          }
        }
      }
    `);

    const entityCacheResults: readonly EntityCacheResult[] = [];

    const cacheResolvers: CacheResolverMap = {};

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const partialDocument = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    expect(partialDocument).toBe(null);
  });

  test("correctly filters out dead branches", () => {
    const originalDocument = parse(gql`
        query FullQuery {
          dashboard {
            topActivity {
              ${ALIAS_ENTITYCACHE_ID}: id
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              title
              description
            }
            latestUpdates {
              ${ALIAS_ENTITYCACHE_ID}: id
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              date
              time
              text
            }
            todoList {
              ${ALIAS_ENTITYCACHE_ID}: id
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              label
              text
            }
          }
          someCachedData {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            name
          }
        }
      `);

    const entityCacheResults: readonly EntityCacheResult[] = [
      Dashboard("1", false, "Query.dashboard"),
      Activity("2", true, "Query.dashboard.topActivity"),
      Activity("3", false, "Query.someCachedData"),
    ];

    const cacheResolvers: CacheResolverMap = {};

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    // prettier-ignore
    expect(printedPartial).toBe(gql`query FullQuery {
  dashboard {
    topActivity {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      title
      description
    }
  }
}`);
  });

  test("traverses multiple definitions", () => {
    const originalDocument = parse(gql`
        fragment Activity on Activity {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          title
          description
          relatedUpdate {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            date
            ...SystemUpdateInfo
            ...UserUpdateInfo
          }
        }

        fragment SystemUpdateInfo on SystemUpdateInfo {
          version
        }

        fragment UserUpdateInfo on UserUpdateInfo {
          byUser
        }

        fragment TodoItem on TodoItem {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          label
          text
        }

        query FullQuery {
          dashboard {
            topActivity {
              ...Activity
              someField
            }
            latestUpdates {
              ${ALIAS_ENTITYCACHE_ID}: id
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              ...SystemUpdateInfo
              ...UserUpdateInfo
            }
            todoList {
              ...TodoItem
            }
          }
        }
      `);

    const entityCacheResults: readonly EntityCacheResult[] = [
      UpdateInfo("2", true, "Query.dashboard.topActivity.relatedUpdate"),
      Dashboard("1", false, "Query.dashboard"),
      Activity("1", false, "Query.dashboard.topActivity"),
    ];

    const cacheResolvers: CacheResolverMap = {};

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    // prettier-ignore
    expect(printedPartial).toBe(gql`query FullQuery {
  dashboard {
    topActivity {
      ... on Activity {
        relatedUpdate {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          date
          ... on SystemUpdateInfo {
            version
          }
          ... on UserUpdateInfo {
            byUser
          }
        }
      }
    }
  }
}`);
  });

  test("creates singleton entity resolution", () => {
    const originalDocument = parse(gql`
        fragment Activity on Activity {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          title
          description
          relatedUpdate {
            ...UpdateInfo
          }
        }

        fragment UpdateInfo on UpdateInfo {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          date
          time
          text
        }

        fragment TodoItem on TodoItem {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          label
          text
        }

        query FullQuery {
          dashboard {
            user {
              ${ALIAS_ENTITYCACHE_ID}: id
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              name
            }
            topActivity {
              ...Activity
            }
            latestUpdates {
              ...UpdateInfo
              nonFragmentField
            }
            todoList {
              ...TodoItem
            }
          }
        }
      `);

    const entityCacheResults: readonly EntityCacheResult[] = [
      UpdateInfo("2", true, 'Query.dashboard.latestUpdates@7#"2"'),
      UpdateInfo("2", true, "Query.dashboard.topActivity.relatedUpdate"),
      User("123", true, "Query.dashboard.user"),
      Dashboard("1", false, "Query.dashboard"),
    ];

    const cacheResolvers: CacheResolverMap = {
      UpdateInfo: {
        idArg: "id",
        rootField: "getUpdateInfo",
        type: "int",
      },
    };

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    const linkSelectionKeys = Object.keys(result.linkSelections);

    expect(linkSelectionKeys).toHaveLength(2);
    expect(linkSelectionKeys).toContain(
      "Query.dashboard.topActivity.relatedUpdate",
    );

    expect(
      stripIgnoredCharacters(
        print(
          result.linkSelections["Query.dashboard.topActivity.relatedUpdate"],
        ),
      ),
    ).toEqual(
      stripIgnoredCharacters(
        gql`{
          ... on UpdateInfo {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            date
            time
            text
          }
        }`,
      ),
    );

    expect(
      stripIgnoredCharacters(
        print(result.linkSelections["Query.dashboard.latestUpdates"]),
      ),
    ).toEqual(
      stripIgnoredCharacters(
        gql`{
          ... on UpdateInfo {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            date
            time
            text
          }
          nonFragmentField
        }`,
      ),
    );

    // prettier-ignore
    expect(printedPartial).toBe(gql`query FullQuery {
  dashboard {
    user {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      name
    }
    latestUpdates {
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      ${ALIAS_ENTITYCACHE_ID}: id
    }
  }
  ${PARTIAL_CACHE_ALIASPREFIX}dashboard_topActivity_relatedUpdate_0: getUpdateInfo(id: 2) {
    ... on UpdateInfo {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      date
      time
      text
    }
  }
  ${PARTIAL_CACHE_ALIASPREFIX}dashboard_latestUpdates_0: getUpdateInfo(id: 2) {
    ... on UpdateInfo {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      date
      time
      text
    }
    nonFragmentField
  }
}`);
  });

  test("creates a mapped cache resolution", () => {
    const originalDocument = parse(gql`
        fragment Activity on Activity {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          title
          description
          relatedUpdate {
            ...UpdateInfo
          }
        }

        fragment UpdateInfo on UpdateInfo {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          date
          time
          text
        }

        fragment TodoItem on TodoItem {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          label
          text
        }

        query FullQuery {
          dashboard {
            user {
              ${ALIAS_ENTITYCACHE_ID}: id
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              name
            }
            topActivity {
              ...Activity
            }
            latestUpdates {
              ...UpdateInfo
              nonFragmentField
            }
            todoList {
              ...TodoItem
            }
          }
        }
      `);

    const entityCacheResults: readonly EntityCacheResult[] = [
      UpdateInfo("2", true, 'Query.dashboard.latestUpdates@2#"7"'),
      UpdateInfo("3", true, 'Query.dashboard.latestUpdates@3"4"'),
      UpdateInfo("2", true, "Query.dashboard.topActivity.relatedUpdate"),
      User("123", true, "Query.dashboard.user"),
      Dashboard("1", false, "Query.dashboard"),
    ];

    const cacheResolvers: CacheResolverMap = {
      UpdateInfo: {
        batch: true,
        idArg: "id",
        rootField: "getUpdateInfo",
        type: "int",
      },
    };

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    expect(
      stripIgnoredCharacters(
        print(
          result.linkSelections["Query.dashboard.topActivity.relatedUpdate"],
        ),
      ),
    ).toBe(
      stripIgnoredCharacters(
        gql`{
          ... on UpdateInfo {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            date
            time
            text
          }
        }`,
      ),
    );

    expect(
      stripIgnoredCharacters(
        print(result.linkSelections["Query.dashboard.latestUpdates"]),
      ),
    ).toBe(
      stripIgnoredCharacters(
        gql`{
          ... on UpdateInfo {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            date
            time
            text
          }
          nonFragmentField
        }`,
      ),
    );

    // prettier-ignore
    expect(printedPartial).toBe(gql`query FullQuery {
  dashboard {
    user {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      name
    }
    latestUpdates {
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      ${ALIAS_ENTITYCACHE_ID}: id
    }
  }
  ${PARTIAL_CACHE_ALIASPREFIX}dashboard_topActivity_relatedUpdate: getUpdateInfo(id: [2]) {
    ... on UpdateInfo {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      date
      time
      text
    }
  }
  ${PARTIAL_CACHE_ALIASPREFIX}dashboard_latestUpdates: getUpdateInfo(id: [2, 3]) {
    ... on UpdateInfo {
      ${ALIAS_ENTITYCACHE_ID}: id
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      date
      time
      text
    }
    nonFragmentField
  }
}`);
  });

  test("avoid conflicting cache resolution when invalidating both list query and downstream entity using a cache resolver", () => {
    const originalDocument = parse(gql`query MyQuery {
        listQuery {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          name
          items {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            name
          }
        }
      }`);

    const entityCacheResults: readonly EntityCacheResult[] = [
      Activity(1, true, "Query.listQuery"),
      TodoItem(1, true, "Query.listQuery.items@0#1"),
    ];

    const cacheResolvers: CacheResolverMap = {
      TodoItem: {
        idArg: "id",
        rootField: "getRelatedEntity",
        type: "string",
      },
    };

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    /**
     * Since a node above the invalidated RelatedEntity has been invalidated,
     * we should not be fetching it separately using a cache resolver
     */
    // prettier-ignore
    expect(printedPartial).toBe(gql`query MyQuery {
  listQuery {
    ${ALIAS_ENTITYCACHE_ID}: id
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    name
    items {
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      ${ALIAS_ENTITYCACHE_ID}: id
    }
  }
  ${PARTIAL_CACHE_ALIASPREFIX}listQuery_items_0: getRelatedEntity(id: "1") {
    ${ALIAS_ENTITYCACHE_ID}: id
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    name
  }
}`);
  });

  test("avoids conflicting cache resolution when invalidating both list query and downstream entity using a cache resolver, where the entity is inside a fragment", () => {
    const originalDocument = parse(gql`fragment SomeObject on SomeObject {
        anotherObject {
          relatedEntity {
            ${ALIAS_ENTITYCACHE_ID}: id
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            name
          }
        }
      }

      query MyQuery {
        listQuery {
          ${ALIAS_ENTITYCACHE_ID}: id
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          name
          items {
            ...SomeObject
          }
        }
      }`);

    const entityCacheResults: readonly EntityCacheResult[] = [
      Activity(1, true, "Query.listQuery"),
      TodoItem(2, true, "Query.listQuery.items@0.anotherObject.relatedEntity"),
    ];

    const cacheResolvers: CacheResolverMap = {
      TodoItem: {
        idArg: "id",
        rootField: "getRelatedEntity",
        type: "string",
      },
    };

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    // prettier-ignore
    expect(printedPartial).toBe(gql`query MyQuery {
  listQuery {
    ${ALIAS_ENTITYCACHE_ID}: id
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    name
  }
  ${PARTIAL_CACHE_ALIASPREFIX}listQuery_items_anotherObject_relatedEntity_0: getRelatedEntity(id: "2") {
    ${ALIAS_ENTITYCACHE_ID}: id
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    name
  }
}`);
  });

  test("collects link selections from cache resolver breakpoints", () => {
    const originalDocument = parseClientQuery(
      parse(gql`
        query Query {
          rootA {
            id @idField
            b {
              id @idField
              c {
                id @idField
              }
            }
          }
        }
      `),
    );

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
        rootField: "C",
        type: "string",
      },
    };

    const entityCacheResults: readonly EntityCacheResult[] = [
      _Entity("A", 1, true, "Query.rootA"),
      _Entity("B", 2, false, "Query.rootA.b"),
      _Entity("C", 3, false, "Query.rootA.b.c"),
    ];

    const entityTree = spawnTreeRoot();

    for (const ecr of entityCacheResults) {
      buildEntityTreeNode(entityTree, ecr, resolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const linkSelections = result.linkSelections;

    expect(print(linkSelections["Query.rootA"])).toBe(gql`{
  id
  b {
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    ${ALIAS_ENTITYCACHE_ID}: id
  }
  ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
  ${ALIAS_ENTITYCACHE_ID}: id
}`);

    expect(print(linkSelections["Query.rootA.b"])).toBe(gql`{
  id
  c {
    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
    ${ALIAS_ENTITYCACHE_ID}: id
  }
  ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
  ${ALIAS_ENTITYCACHE_ID}: id
}`);

    expect(print(linkSelections["Query.rootA.b.c"])).toBe(gql`{
  id
  ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
  ${ALIAS_ENTITYCACHE_ID}: id
}`);
  });

  test("complex realworld example", () => {
    const originalDocument = parse(gql`
        fragment Address on FleetAccountCompanyAddress {
          line1
          line2
          locality
          countryCode
          postalCode
        }

        fragment Company on FleetAccountCompany {
          address {
            ...Address
          }
          contactEmailAddress
          contactPhoneNumber
          name
          organizationNumber
          taxIdentifier
          businessEmailAddress
          invoiceAddress {
            ...Address
          }
        }

        query {
          sysAllCases {
            ${ALIAS_ENTITYCACHE_ID}: key
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            listType
            nodes {
              ${ALIAS_ENTITYCACHE_ID}: key
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              accountConnection {
                ${ALIAS_ENTITYCACHE_ID}: key
                ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                node {
                  ${ALIAS_ENTITYCACHE_ID}: key
                  ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                  company {
                    ...Company
                  }
                  desiredFleetSize
                  sellableMarket
                  status
                  accountType
                  approvalStatus
                  agreement {
                    status
                    discountPlanId
                  }
                  invitesConnection {
                    ${ALIAS_ENTITYCACHE_ID}: key
                    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                    nodes {
                      ${ALIAS_ENTITYCACHE_ID}: key
                      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                      emailAddress
                      role
                      created
                    }
                  }
                  approvalRequirementsConnection {
                    ${ALIAS_ENTITYCACHE_ID}: key
                    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                    nodes {
                      ${ALIAS_ENTITYCACHE_ID}: key
                      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                      name
                      isCompleted
                    }
                  }
                  referencesConnection {
                    ${ALIAS_ENTITYCACHE_ID}: key
                    ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
                    nodes {
                      role
                      volvoId
                    }
                  }
                }
              }
            }
          }
        }
      `);

    const FleetCaseAccountConnection: EntityCacheResultMocker = _Entity.bind(
      null,
      "FleetCaseAccountConnection",
    );
    const FleetAccountCompany: EntityCacheResultMocker = _Entity.bind(
      null,
      "FleetAccountCompany",
    );
    const FleetAccountCompanyAddress: EntityCacheResultMocker = _Entity.bind(
      null,
      "FleetAccountCompanyAddress",
    );

    FleetAccountCompany;
    FleetAccountCompanyAddress;

    const entityCacheResults: readonly EntityCacheResult[] = [
      FleetCaseAccountConnection(
        "7df30e0d149b0b540536b05647725fc0779a38265190e4b69182dbfc8aaf12fe",
        true,
        "Query.sysAllCases.nodes@0.accountConnection",
      ),
      _Entity("SysAllCases", 1, false, "Query.sysAllCases"),
      _Entity("FleetAccount", 1, false, "Query.sysAllCases.nodes@0"),
    ];

    const cacheResolvers: CacheResolverMap = {};

    const entityTree = spawnTreeRoot();

    for (const entityCacheResult of entityCacheResults) {
      buildEntityTreeNode(entityTree, entityCacheResult, cacheResolvers);
    }

    const result = getPartialRecacheQuery({
      entityTree,
      originalDocument,
    });

    if (!result) {
      throw new Error("Partial document not created");
    }

    const printedPartial = print(result.query);

    // prettier-ignore
    expect(printedPartial).toBe(gql`{
  sysAllCases {
    nodes {
      ${ALIAS_ENTITYCACHE_ID}: key
      ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
      accountConnection {
        ${ALIAS_ENTITYCACHE_ID}: key
        ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
        node {
          ${ALIAS_ENTITYCACHE_ID}: key
          ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
          company {
            ... on FleetAccountCompany {
              address {
                ... on FleetAccountCompanyAddress {
                  line1
                  line2
                  locality
                  countryCode
                  postalCode
                }
              }
              contactEmailAddress
              contactPhoneNumber
              name
              organizationNumber
              taxIdentifier
              businessEmailAddress
              invoiceAddress {
                ... on FleetAccountCompanyAddress {
                  line1
                  line2
                  locality
                  countryCode
                  postalCode
                }
              }
            }
          }
          desiredFleetSize
          sellableMarket
          status
          accountType
          approvalStatus
          agreement {
            status
            discountPlanId
          }
          invitesConnection {
            ${ALIAS_ENTITYCACHE_ID}: key
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            nodes {
              ${ALIAS_ENTITYCACHE_ID}: key
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              emailAddress
              role
              created
            }
          }
          approvalRequirementsConnection {
            ${ALIAS_ENTITYCACHE_ID}: key
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            nodes {
              ${ALIAS_ENTITYCACHE_ID}: key
              ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
              name
              isCompleted
            }
          }
          referencesConnection {
            ${ALIAS_ENTITYCACHE_ID}: key
            ${ALIAS_ENTITYCACHE_TYPENAME}: __typename
            nodes {
              role
              volvoId
            }
          }
        }
      }
    }
  }
}`)
  });
});
