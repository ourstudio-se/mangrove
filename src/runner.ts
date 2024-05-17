import {
  BindExecutionArgs,
  BindExecutorRequest,
  CacheResolverMap,
  EntityRecord,
  KnownEntitiesMap,
  MakeQueryRunnerParameter,
  RunQuery,
  RunQueryArgs,
  TypeLinkWithCoordinates,
} from "./typings";
import {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLError,
  SelectionSetNode,
  execute as defaultExecute,
} from "graphql";
import { buildLinkQuery, makeLinkCollector } from "./links";
import {
  defaultBuildResponseCacheKey,
  defaultGetDocumentString,
} from "./defaults";
import { isAsyncIterable } from "./borrowedTools/isAsyncIterable";
import { isIntrospectionDocument } from "./utils";
import { isPromise } from "./borrowedTools/isPromise";
import type { ExecutionRequest, Executor } from "@graphql-tools/utils";

function ensureNonIterableResult(
  result: ExecutionResult | AsyncIterable<ExecutionResult>,
) {
  if (isAsyncIterable(result)) {
    throw new GraphQLError("Async operations not supported");
  }

  return result;
}

export function bindExecutor(executor: Executor): BindExecutorRequest {
  return (request) => {
    return (document, operationName) => {
      const resultOrPromise = executor({ ...request, document, operationName });

      if (isPromise(resultOrPromise)) {
        return resultOrPromise.then(ensureNonIterableResult);
      }

      return ensureNonIterableResult(resultOrPromise);
    };
  };
}

export function bindExecute(
  executeFn: typeof defaultExecute,
): BindExecutionArgs {
  return (args) => {
    return (document, operationName) => {
      return executeFn({ ...args, document, operationName });
    };
  };
}

function getArgsFromExecutionArgs(executionArgs: ExecutionArgs): RunQueryArgs {
  return {
    context: executionArgs.contextValue,
    document: executionArgs.document,
    operationName: executionArgs.operationName ?? undefined,
    variables: executionArgs.variableValues,
  };
}

function getArgsFromExecutorRequest(request: ExecutionRequest): RunQueryArgs {
  return {
    context: request.context,
    document: request.document,
    operationName: request.operationName,
    variables: request.variables,
  };
}

export interface LayeredCacheExecuteParameter {
  knownEntities: KnownEntitiesMap;
  linkSelections: Record<string, SelectionSetNode>;
  originalOperationName?: string;
  partialQuery?: DocumentNode;
  resolvers: CacheResolverMap;
  runQuery: RunQuery;
}

export async function layeredCacheExecute({
  runQuery,
  resolvers,
  linkSelections,
  knownEntities,
  originalOperationName,
  partialQuery,
}: LayeredCacheExecuteParameter): Promise<{
  linkQueries: DocumentNode[];
  result: ExecutionResult[];
}> {
  if (!partialQuery) {
    return { linkQueries: [], result: [] };
  }

  let nextResult = await runQuery(partialQuery, originalOperationName);

  const nextResults = [nextResult];

  if (!nextResult.data || Object.keys(linkSelections).length === 0) {
    return { linkQueries: [], result: nextResults };
  }

  const collectLinks = makeLinkCollector(linkSelections, knownEntities);

  let cacheLinks: TypeLinkWithCoordinates[] = [];
  const linkQueries: DocumentNode[] = [];

  while ((cacheLinks = collectLinks(nextResult.data)).length > 0) {
    const linkQueryResult = buildLinkQuery(
      cacheLinks,
      resolvers,
      originalOperationName,
    );

    if (!linkQueryResult) {
      break;
    }

    const { document: linkQuery, operationName } = linkQueryResult;

    nextResult = await runQuery(linkQuery, operationName);

    linkQueries.push(linkQuery);
    nextResults.push(nextResult);
  }

  return { linkQueries, result: nextResults };
}

export function makeQueryRunner({
  buildResponseCacheKey = defaultBuildResponseCacheKey,
  cacheResolvers,
  enabled,
  session,
  getDocumentString = defaultGetDocumentString,
  getPartialExecutionOpts,
  processResult,
  formatResult = ({ result }) => result,
}: MakeQueryRunnerParameter) {
  return async function runQuery(runner: RunQuery, args: RunQueryArgs) {
    if (
      (enabled && !enabled(args.context)) ||
      isIntrospectionDocument(args.document)
    ) {
      return runner(args.document);
    }

    const sessionId = session(args.context);

    const cacheKey = await buildResponseCacheKey({
      context: args.context,
      documentString: getDocumentString(args),
      operationName: args.operationName,
      sessionId,
      variableValues: args.variables,
    });

    const {
      query,
      result: cachedResult,
      knownEntities,
      linkSelections,
    } = await getPartialExecutionOpts({
      cacheKey,
      query: args.document,
      resolvers: cacheResolvers,
    });

    const originalOperationName = args.operationName ?? undefined;

    const { result: nextResults, linkQueries } = await layeredCacheExecute({
      knownEntities,
      linkSelections,
      originalOperationName,
      partialQuery: query,
      resolvers: cacheResolvers,
      runQuery: runner,
    });

    const { result, collectedEntities } = await processResult({
      cacheKey,
      cachedResult,
      nextResults,
      originalDocument: args.document,
    });

    const contextValue = (args.context ?? {}) as object;

    if ("collectResourceIdentifier" in contextValue) {
      // Dirty hack to trigger live query invalidation

      for (const { entity } of collectedEntities ?? []) {
        (
          contextValue.collectResourceIdentifier as (
            entity: EntityRecord,
          ) => void
        )(entity);
      }
    }

    return formatResult({
      cacheKey,
      cachedResult,
      collectedEntities,
      linkQueries,
      query,
      result,
    });
  };
}

export function makeExecuteWrapper(parameter: MakeQueryRunnerParameter) {
  const runQuery = makeQueryRunner(parameter);
  function wrapExecute(
    executeFn: typeof defaultExecute,
  ): typeof defaultExecute {
    const bindExecuteQuery = bindExecute(executeFn);

    return async function execute(args) {
      const executeQuery = bindExecuteQuery(args);
      return runQuery(executeQuery, getArgsFromExecutionArgs(args));
    };
  }

  return wrapExecute;
}

export function makeExecutorWrapper(parameter: MakeQueryRunnerParameter) {
  const runQuery = makeQueryRunner(parameter);
  function wrapExecutor(executor: Executor): Executor {
    const bindExecuteQuery = bindExecutor(executor);

    return async function executor<TReturn>(request: ExecutionRequest) {
      const executeQuery = bindExecuteQuery(request);
      return runQuery(
        executeQuery,
        getArgsFromExecutorRequest(request),
      ) as TReturn;
    };
  }

  return wrapExecutor;
}
