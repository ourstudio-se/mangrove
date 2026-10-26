// Verifies that both published entry points load and expose the same API.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const esm = await import("../lib/esm/index.js");
const cjs = require("../lib/cjs/index.js");

const esmExports = Object.keys(esm).sort();
const cjsExports = Object.keys(cjs).sort();

for (const name of [
  "useMangrove",
  "lazyInvalidationStrategy",
  "createRedisCache",
  "createMemoryCache",
  "makeExecutorWrapper",
  "parseClientQuery",
]) {
  if (!esmExports.includes(name) || !cjsExports.includes(name)) {
    throw new Error(`Missing export ${name}`);
  }
}

if (esmExports.join() !== cjsExports.join()) {
  throw new Error("ESM and CJS exports differ");
}

console.log(`OK: ${esmExports.length} exports from both ESM and CJS builds`);

// Run a cached query end to end through each build.
const { buildSchema, execute, parse } = await import("graphql");

for (const [label, lib] of [
  ["esm", esm],
  ["cjs", cjs],
]) {
  const schema = buildSchema(`
    directive @cacheResolver(keyArg: String) on FIELD_DEFINITION
    type Query { items: [Item!]! item(id: ID!): Item @cacheResolver }
    type Item { id: ID! data: String! }
  `);
  let calls = 0;
  const rootValue = { items: () => (calls++, [{ data: "a", id: "1" }]) };
  const config = lib.makeBySchemaConfigGenerator({ idFields: new Set(["id"]) })(
    schema,
  );
  const strategy = lib.lazyInvalidationStrategy({
    cache: lib.createMemoryCache(),
  });
  const wrapped = lib.makeExecuteWrapper({
    ...config,
    getPartialExecutionOpts: strategy.getPartialExecutionOpts,
    processResult: lib.makeResultProcessor({
      awaitWriteBeforeResponse: true,
      storeExecutionResult: strategy.storeExecutionResult,
      ttl: 60_000,
    }),
    session: () => null,
  })(execute);
  const document = config.parser(parse("{ items { id data } }"));
  const first = await wrapped({ document, rootValue, schema });
  const second = await wrapped({ document, rootValue, schema });
  if (JSON.stringify(first) !== JSON.stringify(second) || calls !== 1) {
    throw new Error(`${label}: expected a cache hit`);
  }
}

console.log("OK: cached execution works with both builds");
