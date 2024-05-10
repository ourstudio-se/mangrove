import { isArray, isObject } from "./utils";
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLSchema,
  SelectionSetNode,
} from "graphql";
import type { ExecutionRequest } from "@graphql-tools/utils";

export type Maybe<T> = null | undefined | T;

export interface ObjMap<T> {
  [key: string]: T;
}

export interface CacheExtension extends ObjMap<unknown> {
  cache?: {
    cacheKey?: string;
    expires?: Date;
    hit?: boolean;
    knownEntities?: SerializedKnownEntitiesMap;
    linkQueries?: string[];
    linkSelections?: Record<string, string>;
    originalDocument?: string;
    partialQuery?: string;
  };
}

export type CachedExecutionResult = ExecutionResult<
  Record<string, any>,
  CacheExtension
>;

export type EntityRecord = {
  id?: Id;
  typename: string;
};

export interface EntityTypeReference {
  entityKey: string;
  path: readonly PathPart[];
}

export interface ObjectPathPart {
  field: string;
}

export interface ListPathPart {
  field: string;
  id?: Id;
  index: number;
}

export type PathPart = ObjectPathPart | ListPathPart;

export function isListPathPart(pathPart?: PathPart): pathPart is ListPathPart {
  return (
    pathPart !== undefined &&
    "index" in pathPart &&
    pathPart.index !== undefined
  );
}

export interface EntityWithLocation {
  entity: EntityRecord;
  path: readonly PathPart[];
}

export interface EntityCacheResult extends EntityWithLocation {
  invalidated: boolean;
}

export interface TypeLinkWithCoordinates {
  coordinates: string;
  ids: (string | number)[];
  selectionSet: SelectionSetNode;
  typename: string;
}

export interface Logger {
  error(...payload: any[]): void;
  warn(...payload: any[]): void;
}

export interface PartialExecutionOpts {
  knownEntities: KnownEntitiesMap;
  linkSelections: Record<string, SelectionSetNode>;
  query?: DocumentNode;
  result?: CachedExecutionResult;
}

export interface InvalidationGetPartialExecutionOptsParameter {
  cacheKey: string;
  query: DocumentNode;
  resolvers: CacheResolverMap;
}

export interface InvalidationStoreExecutionResultParameter {
  cacheKey: string;
  collectedEntities: readonly EntityWithLocation[];
  entityTtls: Record<string, number>;
  executionResult: CachedExecutionResult;
  originalDocument: DocumentNode;
  ttl: number;
}

export interface InvalidationStrategy {
  getPartialExecutionOpts(
    parameter: InvalidationGetPartialExecutionOptsParameter,
  ): Promise<PartialExecutionOpts>;
  invalidateEntities(
    entitiesToInvalidate: Iterable<EntityRecord>,
  ): Promise<void>;
  storeExecutionResult(
    parameter: InvalidationStoreExecutionResultParameter,
  ): Promise<void>;
}

export interface CacheMutations {
  addMembersToSet(
    key: string,
    membersWithTtls: Iterable<[string, number]>,
  ): Promise<void>;
  clear(keys: Iterable<string>): Promise<void>;
  removeMembersFromSet(key: string, members: Iterable<string>): Promise<void>;
  set(key: string, data: string, ttl: number): Promise<void>;
}

export interface Cache extends CacheMutations {
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<string | null>;
  getKeysStartingWith(startsWith: string): Promise<string[]>;
  getPipe(): CachePipe;
  getSetMembers(key: string): Promise<string[]>;
}

export interface CachePipe extends CacheMutations {
  execute(): Promise<void>;
}

export interface CacheResolver {
  batch?: boolean;
  idArg: string;
  rootField: string;
  type: "string" | "int";
}

export type CacheResolverMap = Record<string, CacheResolver>;

export interface EntityTreeNodeSelection {
  node: EntityTreeNode;
  requiredIds?: Set<Id>;
}

export interface EntityTreeNodeSelections {
  [index: string]: EntityTreeNodeSelection;
}

export interface EntityTreeNode {
  coordinates: string;
  isDirty: boolean;
  isInvalidated: boolean;
  isList: boolean;
  isRequired: boolean;
  requiredTypename?: string;
  resolver?: CacheResolver;
  selections?: EntityTreeNodeSelections;
}

export type Id = string | number;

export interface CacheResolvedEntity extends ObjMap<unknown> {
  __entityCacheId: Id;
  __entityCacheTypeName: string;
}

export function isCacheResolvedEntity(
  value: any,
): value is CacheResolvedEntity {
  return (
    isObject(value) &&
    "__entityCacheId" in value &&
    "__entityCacheTypeName" in value
  );
}

export function isCacheResolvedEntityList(
  value: unknown,
): value is CacheResolvedEntity[] {
  return isArray(value) && value.every(isCacheResolvedEntity);
}

export type BuildResponseCacheKeyFunction = (params: {
  /** GraphQL Context */
  context: ExecutionArgs["contextValue"];
  /** Raw document string as sent from the client. */
  documentString: string;
  /** The name of the GraphQL operation that should be executed from within the document. */
  operationName?: Maybe<string>;
  /** optional sessionId for make unique cache keys based on the session.  */
  sessionId: Maybe<string>;
  /** Variable values as sent form the client. */
  variableValues: ExecutionArgs["variableValues"];
}) => Promise<string>;

export type GetDocumentStringFunction = (executionArgs: RunQueryArgs) => string;

export type ShouldCacheResultFunction = (params: {
  cacheKey: string;
  result: ExecutionResult;
}) => boolean;

export type CollectEntityWithLocationFunction = (
  data: any,
  path: readonly PathPart[],
) => EntityWithLocation | null;

export interface MakeResultProcessorOpts {
  awaitWriteBeforeResponse?: boolean;
  collectEntityWithLocation?: CollectEntityWithLocationFunction;
  entityTtls?: Record<string, number>;
  logger?: Logger;
  shouldCacheResult?: ShouldCacheResultFunction;
  storeExecutionResult: InvalidationStrategy["storeExecutionResult"];
  ttl: number;
}

export interface ResultProcessorParameter {
  cacheKey: string;
  cachedResult?: ExecutionResult;
  nextResults: ExecutionResult[];
  originalDocument: DocumentNode;
}

export type ResultProcessor = (parameter: ResultProcessorParameter) => Promise<{
  collectedEntities?: readonly EntityWithLocation[];
  result: ExecutionResult;
}>;

export interface UsePartialCacheParameter<
  PluginContext extends Record<string, any> = NonNullable<unknown>,
> {
  awaitWriteBeforeResponse?: boolean;

  buildResponseCacheKey?: BuildResponseCacheKeyFunction;

  cacheResolvers?: CacheResolverMap;

  collectEntityWithLocation?: CollectEntityWithLocationFunction;

  enabled?(context: PluginContext): boolean;

  entityTtls?: Record<string, number>;

  getDocumentString?: GetDocumentStringFunction;

  idFields?: readonly string[];

  ignoredTypes?: string[];

  includeExtensionMetadata?: boolean;

  invalidationStrategy: InvalidationStrategy;

  session(context: PluginContext): string | undefined | null;

  shouldCacheResult?: ShouldCacheResultFunction;

  ttl: number;
}

export interface MakeQueryRunnerParameter {
  buildResponseCacheKey?: BuildResponseCacheKeyFunction;

  cacheResolvers: CacheResolverMap;

  enabled?(context: any): boolean;

  formatResult?: FormatResult;

  getDocumentString?: GetDocumentStringFunction;

  getPartialExecutionOpts(
    parameter: InvalidationGetPartialExecutionOptsParameter,
  ): Promise<PartialExecutionOpts>;

  processResult: ResultProcessor;

  session(context: any): string | undefined | null;
}

export interface MakeResultFormatterParameter {
  includeExtensionMetadata: boolean;

  ttl: number;
}

export interface FormatResultParameter {
  cacheKey: string;
  cachedResult?: CachedExecutionResult;
  collectedEntities?: readonly EntityWithLocation[];
  linkQueries?: DocumentNode[];
  query?: DocumentNode;
  result: ExecutionResult;
}

export type FormatResult = (
  parameter: FormatResultParameter,
) => ExecutionResult;

export type ConfigureFromSchema = (schema: GraphQLSchema) => {
  cacheResolvers: CacheResolverMap;
  entityTtls: Record<string, number>;
  idFieldByTypeName: Map<string, string>;
  parser: ParseDocument;
};

export interface MakeBySchemaConfigGeneratorParameter {
  idFields: Set<string>;
}

export type ParseDocument = (document: DocumentNode) => DocumentNode;

export type MaybePromise<T> = T | PromiseLike<T>;

export type RunQuery = (
  document: DocumentNode,
  operationName?: string,
) => MaybePromise<ExecutionResult>;

export type BindExecutorRequest = (
  request: Omit<ExecutionRequest, "document">,
) => RunQuery;
export type BindExecutionArgs = (
  args: Omit<ExecutionArgs, "document">,
) => RunQuery;

export interface RunQueryArgs {
  context: unknown;
  document: DocumentNode;
  operationName?: string;
  variables: any;
}

export type KnownEntitiesMap = Record<string, Set<Id>>;
export type SerializedKnownEntitiesMap = Record<string, Id[]>;

export interface RootId {
  __root: true;
}
