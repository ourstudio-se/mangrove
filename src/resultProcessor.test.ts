import { ALIAS_ENTITYCACHE_ID, ALIAS_ENTITYCACHE_TYPENAME } from "./constants";
import { ExecutionResult, parse } from "graphql";
import { getCacheAlias } from "./utils";
import { makeResultProcessor } from "./resultProcessor";

describe("resultProcessor", () => {
  test("collects entities", (done) => {
    const nextResult: ExecutionResult = {
      data: {
        dashboard: {
          latestUpdates: [
            {
              [ALIAS_ENTITYCACHE_ID]: "1",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-04T00:00:00Z",
              id: "1",
              text: "Lorem ipsum",
            },
            {
              [ALIAS_ENTITYCACHE_ID]: "2",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-03T00:00:00Z",
              id: "2",
              text: "Dolor hic set amit",
            },
          ],
          topActivity: {
            [ALIAS_ENTITYCACHE_ID]: 2,
            [ALIAS_ENTITYCACHE_TYPENAME]: "Activity",
            __typename: "Activity",
            description: "Lorem ipsum dolor",
            id: 2,
            title: "Lorem ipsum",
          },
        },
      },
    };

    const processResult = makeResultProcessor({
      async storeExecutionResult({ cacheKey, collectedEntities, ttl }) {
        try {
          expect(cacheKey).toBe("abc123");
          expect(ttl).toBe(60 * 60 * 1000);
          expect(collectedEntities).toEqual([
            {
              entity: {
                id: "1",
                typename: "UpdateInfo",
              },
              path: [
                {
                  field: "Query",
                },
                {
                  field: "dashboard",
                },
                {
                  field: "latestUpdates",
                  id: "1",
                  index: 0,
                },
              ],
            },
            {
              entity: {
                id: "2",
                typename: "UpdateInfo",
              },
              path: [
                {
                  field: "Query",
                },
                {
                  field: "dashboard",
                },
                {
                  field: "latestUpdates",
                  id: "2",
                  index: 1,
                },
              ],
            },
            {
              entity: {
                id: 2,
                typename: "Activity",
              },
              path: [
                {
                  field: "Query",
                },
                {
                  field: "dashboard",
                },
                {
                  field: "topActivity",
                },
              ],
            },
          ]);
        } finally {
          done();
        }
      },
      ttl: 60 * 60 * 1000,
    });

    processResult({
      cacheKey: "abc123",
      nextResults: [nextResult],
      originalDocument: parse(`query { a }`),
    });
  });

  test("merges partial result into cached result", async () => {
    const cachedResult: ExecutionResult = {
      data: {
        dashboard: {
          latestUpdates: [
            {
              [ALIAS_ENTITYCACHE_ID]: "1",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-04T00:00:00Z",
              id: "1",
              text: "Lorem ipsum",
            },
            {
              [ALIAS_ENTITYCACHE_ID]: "2",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-03T00:00:00Z",
              id: "2",
              text: "Dolor hic set amit",
            },
          ],
          topActivity: {
            [ALIAS_ENTITYCACHE_ID]: 2,
            [ALIAS_ENTITYCACHE_TYPENAME]: "Activity",
            __typename: "Activity",
            description: "Lorem ipsum dolor",
            id: 2,
            title: "Lorem ipsum",
          },
        },
      },
    };

    const nextResult: ExecutionResult = {
      data: {
        dashboard: {
          topActivity: {
            [ALIAS_ENTITYCACHE_ID]: 2,
            [ALIAS_ENTITYCACHE_TYPENAME]: "Activity",
            __typename: "Activity",
            description: "Lorem ipsum dolor",
            id: 2,
            title: "[Changed] Lorem ipsum",
          },
        },
      },
    };

    const processResult = makeResultProcessor({
      async storeExecutionResult() {
        return;
      },
      ttl: 60 * 60 * 1000,
    });

    const { result: processedResult } = await processResult({
      cacheKey: "abc123",
      cachedResult,
      nextResults: [nextResult],
      originalDocument: parse(`query { a }`),
    });

    const data = processedResult.data as any;

    expect(data?.["dashboard"]?.["topActivity"]).toEqual({
      __typename: "Activity",
      description: "Lorem ipsum dolor",
      id: 2,
      title: "[Changed] Lorem ipsum",
    });

    expect(data?.["dashboard"]?.["latestUpdates"]?.[0]).toEqual({
      __typename: "UpdateInfo",
      date: "2023-12-04T00:00:00Z",
      id: "1",
      text: "Lorem ipsum",
    });

    expect(data?.["dashboard"]?.["latestUpdates"]?.[1]).toEqual({
      __typename: "UpdateInfo",
      date: "2023-12-03T00:00:00Z",
      id: "2",
      text: "Dolor hic set amit",
    });
  });

  test("maps non batch cache resolver results into main data tree", async () => {
    const cachedResult: ExecutionResult = {
      data: {
        dashboard: {
          latestUpdates: [
            {
              [ALIAS_ENTITYCACHE_ID]: "1",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-04T00:00:00Z",
              id: "1",
              text: "Lorem ipsum",
            },
            {
              [ALIAS_ENTITYCACHE_ID]: "2",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-03T00:00:00Z",
              id: "2",
              text: "Dolor hic set amit",
            },
          ],
          topActivity: {
            [ALIAS_ENTITYCACHE_ID]: 2,
            [ALIAS_ENTITYCACHE_TYPENAME]: "Activity",
            __typename: "Activity",
            description: "Lorem ipsum dolor",
            id: 2,
            title: "Lorem ipsum",
          },
        },
      },
    };

    const nextResult: ExecutionResult = {
      data: {
        [getCacheAlias(`dashboard_latestUpdates`)]: {
          [ALIAS_ENTITYCACHE_ID]: "2",
          [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
          __typename: "UpdateInfo",
          date: "2023-12-03T00:00:00Z",
          id: "2",
          text: "[Changed] Dolor hic set amit",
        },
      },
    };

    const processResult = makeResultProcessor({
      async storeExecutionResult() {
        return;
      },
      ttl: 60 * 60 * 1000,
    });

    const { result: processedResult } = await processResult({
      cacheKey: "abc123",
      cachedResult,
      nextResults: [nextResult],
      originalDocument: parse(`query { a }`),
    });

    const data = processedResult.data as any;

    expect(data?.["dashboard"]?.["topActivity"]).toEqual({
      __typename: "Activity",
      description: "Lorem ipsum dolor",
      id: 2,
      title: "Lorem ipsum",
    });

    expect(data?.["dashboard"]?.["latestUpdates"]?.[0]).toEqual({
      __typename: "UpdateInfo",
      date: "2023-12-04T00:00:00Z",
      id: "1",
      text: "Lorem ipsum",
    });

    expect(data?.["dashboard"]?.["latestUpdates"]?.[1]).toEqual({
      __typename: "UpdateInfo",
      date: "2023-12-03T00:00:00Z",
      id: "2",
      text: "[Changed] Dolor hic set amit",
    });
  });

  test("maps batch cache resolver results into main data tree", async () => {
    const cachedResult: ExecutionResult = {
      data: {
        dashboard: {
          latestUpdates: [
            {
              [ALIAS_ENTITYCACHE_ID]: "1",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-04T00:00:00Z",
              id: "1",
              text: "Lorem ipsum",
            },
            {
              [ALIAS_ENTITYCACHE_ID]: "2",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-03T00:00:00Z",
              id: "2",
              text: "Dolor hic set amit",
            },
            {
              [ALIAS_ENTITYCACHE_ID]: "3",
              [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
              __typename: "UpdateInfo",
              date: "2023-12-03T00:00:00Z",
              id: "3",
              text: "Foo bar",
            },
          ],
          topActivity: {
            [ALIAS_ENTITYCACHE_ID]: 2,
            [ALIAS_ENTITYCACHE_TYPENAME]: "Activity",
            __typename: "Activity",
            description: "Lorem ipsum dolor",
            id: 2,
            title: "Lorem ipsum",
          },
        },
      },
    };

    const nextResult: ExecutionResult = {
      data: {
        [getCacheAlias(`dashboard_latestUpdates`)]: [
          {
            [ALIAS_ENTITYCACHE_ID]: "1",
            [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
            __typename: "UpdateInfo",
            date: "2023-12-04T00:00:00Z",
            id: "1",
            text: "[Changed] Lorem ipsum",
          },
          {
            [ALIAS_ENTITYCACHE_ID]: "3",
            [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
            __typename: "UpdateInfo",
            date: "2023-12-03T00:00:00Z",
            id: "3",
            text: "[Changed] Foo bar",
          },
        ],
      },
    };

    const processResult = makeResultProcessor({
      async storeExecutionResult() {
        return;
      },
      ttl: 60 * 60 * 1000,
    });

    const { result: processedResult } = await processResult({
      cacheKey: "abc123",
      cachedResult,
      nextResults: [nextResult],
      originalDocument: parse(`query { a }`),
    });

    const data = processedResult.data as any;

    expect(data?.["dashboard"]?.["topActivity"]).toEqual({
      __typename: "Activity",
      description: "Lorem ipsum dolor",
      id: 2,
      title: "Lorem ipsum",
    });

    expect(data?.["dashboard"]?.["latestUpdates"]?.[0]).toEqual({
      __typename: "UpdateInfo",
      date: "2023-12-04T00:00:00Z",
      id: "1",
      text: "[Changed] Lorem ipsum",
    });

    expect(data?.["dashboard"]?.["latestUpdates"]?.[1]).toEqual({
      __typename: "UpdateInfo",
      date: "2023-12-03T00:00:00Z",
      id: "2",
      text: "Dolor hic set amit",
    });

    expect(data?.["dashboard"]?.["latestUpdates"]?.[2]).toEqual({
      __typename: "UpdateInfo",
      date: "2023-12-03T00:00:00Z",
      id: "3",
      text: "[Changed] Foo bar",
    });
  });

  // test("uses indexwise array merging only for lists with downstream entities", async () => {
  //   const cachedResult: ExecutionResult = {
  //     data: {
  //       dashboard: {
  //         latestUpdates: [
  //           {
  //             [ALIAS_ENTITYCACHE_ID]: "1",
  //             [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
  //             __typename: "UpdateInfo",
  //             affectsVersions: [
  //               {
  //                 versionHash: "0954118b09e19437df744fbffa5434fb",
  //                 versionTag: "1.0.0",
  //               },
  //               {
  //                 versionHash: "ea1cf321d584c66963df2449af5dd592",
  //                 versionTag: "1.1.0",
  //               },
  //             ],
  //             date: "2023-12-04T00:00:00Z",
  //             id: "1",
  //             text: "Lorem ipsum",
  //           },
  //           {
  //             [ALIAS_ENTITYCACHE_ID]: "2",
  //             [ALIAS_ENTITYCACHE_TYPENAME]: "UpdateInfo",
  //             __typename: "UpdateInfo",
  //             affectsVersions: [
  //               {
  //                 versionHash: "ea1cf321d584c66963df2449af5dd592",
  //                 versionTag: "1.1.0",
  //               },
  //             ],
  //             date: "2023-12-03T00:00:00Z",
  //             id: "2",
  //             text: "Dolor hic set amit",
  //           },
  //         ],
  //       },
  //     },
  //   };
  //
  //   const nextResult: ExecutionResult = {
  //     data: {
  //       dashboard: {
  //         latestUpdates: [
  //           {
  //             affectsVersions: [
  //               {
  //                 versionHash: "0954118b09e19437df744fbffa5434fb",
  //                 versionTag: "1.0.0",
  //               },
  //             ],
  //           },
  //           {
  //             affectsVersions: [],
  //           },
  //         ],
  //       },
  //     },
  //   };
  //
  //   const processResult = makeResultProcessor({
  //     async storeExecutionResult() {
  //       return;
  //     },
  //     ttl: 60 * 60 * 1000,
  //   });
  //
  //   const { result: processedResult } = await processResult({
  //     cacheKey: "abc123",
  //     cachedResult,
  //     nextResults: [nextResult],
  //   });
  //
  //   expect(processedResult.data?.["dashboard"]?.["latestUpdates"]?.[0]).toEqual(
  //     {
  //       __typename: "UpdateInfo",
  //       affectsVersions: [
  //         {
  //           versionHash: "0954118b09e19437df744fbffa5434fb",
  //           versionTag: "1.0.0",
  //         },
  //       ],
  //       date: "2023-12-04T00:00:00Z",
  //       id: "1",
  //       text: "Lorem ipsum",
  //     },
  //   );
  //
  //   expect(processedResult.data?.["dashboard"]?.["latestUpdates"]?.[1]).toEqual(
  //     {
  //       __typename: "UpdateInfo",
  //       affectsVersions: [],
  //       date: "2023-12-03T00:00:00Z",
  //       id: "2",
  //       text: "Dolor hic set amit",
  //     },
  //   );
  // });
});
