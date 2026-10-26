/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createHarness,
  createRedisClient,
  startRedis,
  stopRedis,
} from "./harness.js";
import { createRedisCache } from "../caches/redis.js";
import { spawnSync } from "node:child_process";

const redisAvailable =
  !!process.env.REDIS_URL ||
  spawnSync("redis-server", ["--version"]).status === 0;

let redisUrl: string;
beforeAll(async () => {
  if (redisAvailable) {
    redisUrl = (await startRedis())!;
  }
});
afterAll(async () => {
  await stopRedis();
});

for (const allowDistinctMemberTTLs of [true, false]) {
  (redisAvailable ? test : test.skip)(
    `type invalidation with keyPrefix + script flush (zset=${allowDistinctMemberTTLs})`,
    async () => {
      const client = createRedisClient(redisUrl);
      await client.flushall();
      const cache = createRedisCache({
        allowDistinctMemberTTLs,
        client,
        keyPrefix: "pfx:",
      });
      const state = { v: 1 };
      const h = createHarness({
        cache,
        resolvers: { Query: { item: () => ({ id: "1", v: state.v }) } },
        typeDefs: `type Query { item: Item! } type Item { id: ID! v: Int! }`,
      });
      const q = `{ item { id v } }`;
      await h.run(q);
      await client.script("FLUSH");
      state.v = 2;
      await h.strategy.invalidateEntities([{ typename: "Item" }]);
      const r = await h.run(q);
      expect((r.result.data as any).item.v).toBe(2);
      await client.script("FLUSH");
      state.v = 3;
      await h.strategy.invalidateEntities([{ typename: "Item", id: "1" }]);
      const r2 = await h.run(q);
      expect((r2.result.data as any).item.v).toBe(3);
      const r3 = await h.run(q);
      await h.run(q);
      await h.run(q);
      expect(r3.executed).toHaveLength(0);
      expect(h.logger.errors).toEqual([]);
    },
  );
}
