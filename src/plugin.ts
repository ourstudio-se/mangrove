import { ParseDocument, UsePartialCacheParameter } from "./typings";
import {
  defaultBuildResponseCacheKey,
  defaultCollectEntityWithLocation,
  defaultGetDocumentString,
  defaultShouldCacheResult,
} from "./defaults";
import { getParserFromSchema } from "./parser";
import { isIntrospectionDocument } from "./utils";
import { makeBySchemaConfigGenerator } from "./schemaConfig";
import { makeExecuteWrapper } from "./runner";
import { makeResultFormatter } from "./resultFormatter";
import { makeResultProcessor } from "./resultProcessor";
import { memoize1 } from "./borrowedTools/memoize";
import type { Plugin } from "@envelop/core";

export function useMangrove<
  PluginContext extends Record<string, unknown> = NonNullable<unknown>,
>({
  awaitWriteBeforeResponse,
  invalidationStrategy,
  entityTtls = {},
  ttl,
  collectEntityWithLocation = defaultCollectEntityWithLocation,
  session,
  enabled,
  cacheResolvers = {},
  idFields: _idFields = ["id"],
  buildResponseCacheKey = defaultBuildResponseCacheKey,
  getDocumentString = defaultGetDocumentString,
  shouldCacheResult = defaultShouldCacheResult,
  includeExtensionMetadata = typeof process !== "undefined"
    ? process.env["NODE_ENV"] === "development" || !!process.env["DEBUG"]
    : false,
}: UsePartialCacheParameter<PluginContext>): Plugin<PluginContext> {
  enabled = enabled ? memoize1(enabled) : enabled;
  const idFields = new Set(_idFields);

  let parser: ParseDocument | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schema: any;

  const { getPartialExecutionOpts, storeExecutionResult } =
    invalidationStrategy;

  const processResult = makeResultProcessor({
    awaitWriteBeforeResponse,
    collectEntityWithLocation,
    entityTtls,
    shouldCacheResult,
    storeExecutionResult,
    ttl,
  });

  const formatResult = makeResultFormatter({
    includeExtensionMetadata,
    ttl,
  });

  const wrapExecute = makeExecuteWrapper({
    buildResponseCacheKey,
    cacheResolvers,
    enabled,
    formatResult,
    getDocumentString,
    getPartialExecutionOpts,
    processResult,
    session,
  });

  const configureBySchema = makeBySchemaConfigGenerator({ idFields });

  return {
    async onExecute(onExecuteParams) {
      const executeFn = wrapExecute(onExecuteParams.executeFn);
      onExecuteParams.setExecuteFn(executeFn);
    },
    onParse() {
      return ({ result, replaceParseResult, context }) => {
        if (enabled && !enabled(context)) {
          return;
        }
        if (isIntrospectionDocument(result)) {
          return;
        }
        if (!parser) {
          return;
        }
        const newDocument = parser(result);
        replaceParseResult(newDocument);
      };
    },
    onSchemaChange({ schema: newSchema }) {
      if (schema === newSchema) {
        return;
      }
      schema = newSchema;

      const config = configureBySchema(schema);

      parser = getParserFromSchema(schema, config.idFieldByTypeName);

      for (const key of Object.keys(config.entityTtls)) {
        entityTtls[key] = config.entityTtls[key];
      }

      for (const key of Object.keys(config.cacheResolvers)) {
        cacheResolvers[key] = config.cacheResolvers[key];
      }
    },
  };
}
