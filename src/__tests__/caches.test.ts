import {
  CacheFactory,
  createRedisClient,
  memoryCacheFactory,
  redisCacheFactory,
  startRedis,
  stopRedis,
} from "./harness.js";
import { createRedisCache } from "../caches/redis.js";
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

const backends: [string, () => CacheFactory, boolean][] = [
  ["memory", () => memoryCacheFactory, true],
  ["redis", () => redisCacheFactory(redisUrl!), redisAvailable],
];

for (const [backend, getFactory, available] of backends) {
  (available ? describe : describe.skip)(`${backend} cache contract`, () => {
    test("values", async () => {
      const cache = await getFactory()();
      expect(await cache.get("k")).toBeNull();
      expect(await cache.exists("k")).toBe(false);
      await cache.set("k", "v", 60_000);
      expect(await cache.get("k")).toBe("v");
      expect(await cache.exists("k")).toBe(true);
      await cache.clear(["k"]);
      expect(await cache.get("k")).toBeNull();
    });

    test("set members expire individually", async () => {
      const cache = await getFactory()();
      await cache.addMembersToSet("s", [
        ["short", 50],
        ["long", 60_000],
      ]);
      expect((await cache.getSetMembers("s")).sort()).toEqual([
        "long",
        "short",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await cache.getSetMembers("s")).toEqual(["long"]);
      expect(await cache.isSetMember("s", "short")).toBe(false);
      expect(await cache.isSetMember("s", "long")).toBe(true);
    });

    test("onlyNew never extends existing members", async () => {
      const cache = await getFactory()();
      await cache.addMembersToSet("s", [["m", 50]]);
      await cache.addMembersToSet("s", [["m", 60_000]], { onlyNew: true });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await cache.isSetMember("s", "m")).toBe(false);
    });

    test("guarded insertions are skipped after a newer invalidation", async () => {
      const cache = await getFactory()();
      const epoch = await cache.getEpoch();

      await cache.invalidate({ keys: ["Item:1"], markers: ["Item:1"] });
      expect(await cache.getEpoch()).toBe(epoch + 1);

      await cache.addMembersToSet("Item:1", [["op", 60_000]], {
        guard: { epoch, markers: ["Item:1", "Item"] },
      });
      expect(await cache.isSetMember("Item:1", "op")).toBe(false);

      // Unrelated markers don't interfere, and newer epochs are fine.
      await cache.addMembersToSet("Item:2", [["op", 60_000]], {
        guard: { epoch, markers: ["Item:2", "Item"] },
      });
      await cache.addMembersToSet("Item:1", [["op", 60_000]], {
        guard: { epoch: epoch + 1, markers: ["Item:1", "Item"] },
      });
      expect(await cache.isSetMember("Item:2", "op")).toBe(true);
      expect(await cache.isSetMember("Item:1", "op")).toBe(true);
    });

    test("invalidating an index deletes its members", async () => {
      const cache = await getFactory()();
      await cache.addMembersToSet("Item:1", [["op", 60_000]]);
      await cache.addMembersToSet("ItemGroup:1", [["op", 60_000]]);
      await cache.addMembersToSet("typeindex:Item", [["Item:1", 60_000]]);

      await cache.invalidate({
        indexes: ["typeindex:Item"],
        keys: ["Item"],
        markers: ["Item"],
      });

      expect(await cache.isSetMember("Item:1", "op")).toBe(false);
      expect(await cache.isSetMember("ItemGroup:1", "op")).toBe(true);
      expect(await cache.exists("typeindex:Item")).toBe(false);
    });

    test("pipes apply all operations together", async () => {
      const cache = await getFactory()();
      const pipe = cache.getPipe();
      await pipe.set("a", "1", 60_000);
      await pipe.addMembersToSet("s", [["m", 60_000]]);
      expect(await cache.get("a")).toBeNull();
      await pipe.execute();
      expect(await cache.get("a")).toBe("1");
      expect(await cache.isSetMember("s", "m")).toBe(true);
    });

    test("conditional pipes don't overwrite writes from later epochs", async () => {
      const cache = await getFactory()();
      const condition = (epoch: number) => ({
        epoch,
        key: "op:epoch",
        ttl: 60_000,
      });

      const newer = cache.getPipe(condition(2));
      await newer.set("result", "new", 60_000);
      await newer.addMembersToSet("Item:1", [["op", 60_000]]);
      await newer.execute();

      const older = cache.getPipe(condition(1));
      await older.set("result", "old", 60_000);
      await older.clear(["Item:1"]);
      await older.addMembersToSet("Item:2", [["op", 60_000]]);
      await older.execute();

      expect(await cache.get("result")).toBe("new");
      expect(await cache.isSetMember("Item:1", "op")).toBe(true);
      expect(await cache.isSetMember("Item:2", "op")).toBe(false);

      const same = cache.getPipe(condition(2));
      await same.set("result", "same epoch", 60_000);
      await same.execute();
      expect(await cache.get("result")).toBe("same epoch");
    });

    test("rejects non-positive TTLs", async () => {
      const cache = await getFactory()();
      await expect(cache.set("k", "v", 0)).rejects.toThrow();
      await expect(cache.addMembersToSet("s", [["m", -1]])).rejects.toThrow();
    });
  });
}

(redisAvailable ? describe : describe.skip)("redis cache specifics", () => {
  test("key prefixes namespace every key", async () => {
    const client = createRedisClient(redisUrl!);
    await client.flushall();
    const cache = createRedisCache({ client, keyPrefix: "app1:" });

    await cache.set("k", "v", 60_000);
    await cache.addMembersToSet("typeindex:T", [["T:1", 60_000]]);
    await cache.addMembersToSet("T:1", [["op", 60_000]]);
    await cache.invalidate({
      indexes: ["typeindex:T"],
      keys: [],
      markers: ["T"],
    });

    const keys = (await client.keys("*")).sort();
    expect(keys).toEqual([
      "app1:k",
      "app1:mangrove:epoch",
      "app1:mangrove:invalidated:T",
    ]);
  });

  test("plain sets live as long as their longest member", async () => {
    const client = createRedisClient(redisUrl!);
    await client.flushall();
    const cache = createRedisCache({ allowDistinctMemberTTLs: false, client });

    await cache.addMembersToSet("s", [["a", 60_000]]);
    await cache.addMembersToSet("s", [["b", 100]]);
    expect(await client.pttl("s")).toBeGreaterThan(50_000);
  });

  test("failed writes reject", async () => {
    const client = createRedisClient(redisUrl!);
    await client.flushall();
    const cache = createRedisCache({ client });
    await client.set("s", "not a set");

    await expect(cache.addMembersToSet("s", [["m", 60_000]])).rejects.toThrow(
      /WRONGTYPE/,
    );
  });

  test("compression is applied to stored values", async () => {
    const client = createRedisClient(redisUrl!);
    await client.flushall();
    const cache = createRedisCache({
      client,
      compression: async (data) => Buffer.from(data).reverse(),
      decompression: (data) => Buffer.from(data).reverse().toString(),
    });

    await cache.set("k", "abc", 60_000);
    expect(await client.get("k")).toBe("cba");
    expect(await cache.get("k")).toBe("abc");
  });
});
