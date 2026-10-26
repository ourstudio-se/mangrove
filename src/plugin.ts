import {
  CacheResolverMap,
  ParseDocument,
  UsePartialCacheParameter,
} from "./typings.js";
import {
  defaultBuildResponseCacheKey,
  defaultCollectEntityWithLocation,
  defaultGetDocumentString,
  defaultShouldCacheResult,
} from "./defaults.js";
import { GraphQLSchema } from "graphql";
import { isIntrospectionDocument } from "./utils.js";
import { makeBySchemaConfigGenerator } from "./schemaConfig.js";
import { makeExecuteWrapper } from "./runner.js";
import { makeResultFormatter } from "./resultFormatter.js";
import { makeResultProcessor } from "./resultProcessor.js";
import type { Plugin } from "@envelop/core";

function replaceContents<T>(
  target: Record<string, T>,
  ...sources: Record<string, T>[]
) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, ...sources);
}

export function useMangrove<
  PluginContext extends Record<string, unknown> = NonNullable<unknown>,
>({
  awaitWriteBeforeResponse,
  invalidationStrategy,
  entityTtls: configuredEntityTtls = {},
  ttl,
  collectEntityWithLocation = defaultCollectEntityWithLocation,
  session,
  enabled,
  cacheResolvers: configuredCacheResolvers = {},
  idFields: _idFields = ["id"],
  buildResponseCacheKey = defaultBuildResponseCacheKey,
  getDocumentString = defaultGetDocumentString,
  logger = console,
  shouldCacheResult = defaultShouldCacheResult,
  includeExtensionMetadata = typeof process !== "undefined"
    ? process.env["NODE_ENV"] === "development"
    : false,
}: UsePartialCacheParameter<PluginContext>): Plugin<PluginContext> {
  const idFields = new Set(_idFields);

  // Owned by the plugin: configured values, overridden by what the schema
  // declares. Rebuilt on every schema change.
  const cacheResolvers: CacheResolverMap = { ...configuredCacheResolvers };
  const entityTtls: Record<string, number> = { ...configuredEntityTtls };

  let parser: ParseDocument | undefined;
  let schema: GraphQLSchema | undefined;

  const { getPartialExecutionOpts, storeExecutionResult } =
    invalidationStrategy;

  const processResult = makeResultProcessor({
    awaitWriteBeforeResponse,
    collectEntityWithLocation,
    entityTtls,
    logger,
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
    enabled: enabled as ((context: unknown) => boolean) | undefined,
    formatResult,
    getDocumentString,
    getPartialExecutionOpts,
    logger,
    processResult,
    session: session as (context: unknown) => string | undefined | null,
  });

  const configureBySchema = makeBySchemaConfigGenerator({ idFields, logger });

  return {
    onExecute(onExecuteParams) {
      const executeFn = wrapExecute(onExecuteParams.executeFn);
      onExecuteParams.setExecuteFn(executeFn);
    },
    onParse() {
      return ({ result, replaceParseResult, context }) => {
        if (enabled && !enabled(context)) {
          return;
        }
        if (!parser || !result || result instanceof Error) {
          return;
        }
        if (isIntrospectionDocument(result)) {
          return;
        }
        replaceParseResult(parser(result));
      };
    },
    onSchemaChange({ schema: newSchema }) {
      if (schema === newSchema) {
        return;
      }
      schema = newSchema;

      const config = configureBySchema(newSchema);

      parser = config.parser;

      replaceContents(entityTtls, configuredEntityTtls, config.entityTtls);
      replaceContents(
        cacheResolvers,
        configuredCacheResolvers,
        config.cacheResolvers,
      );
    },
  };
}
