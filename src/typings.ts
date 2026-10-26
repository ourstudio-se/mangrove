import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
} from "./constants.js";
import { getMarkedId, getMarkedTypename } from "./markers.js";
import { isArray, isObject } from "./utils.js";
import type {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLSchema,
  SelectionSetNode,
  VariableDefinitionNode,
} from "graphql";
import type { ExecutionRequest } from "@graphql-tools/utils";
import type { MergeContext } from "./merge.js";

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
    partial?: boolean;
    partialQuery?: string;
  };
}

export type CachedExecutionResult = ExecutionResult<
  Record<string, unknown>,
  CacheExtension
>;

export type Id = string | number;

export type EntityRecord = {
  id?: Id;
  typename: string;
};

/**
 * One step of a data path. `index` is set for list items. `typename`/`id`
 * describe the entity found at this position, if any, which lets the entity
 * tree know which ancestor entity a nested entity was reached through.
 */
export interface PathPart {
  field: string;
  id?: string;
  index?: number;
  typename?: string;
}

/** @deprecated Use PathPart */
export type ObjectPathPart = PathPart;

/** @deprecated Use PathPart */
export type ListPathPart = PathPart & { index: number };

export function isListPathPart(pathPart?: PathPart): pathPart is ListPathPart {
  return pathPart !== undefined && pathPart.index !== undefined;
}

export interface EntityWithLocation {
  entity: EntityRecord;
  path: readonly PathPart[];
}

export interface EntityCacheResult extends EntityWithLocation {
  invalidated: boolean;
}

export interface Logger {
  error(...payload: unknown[]): void;
  warn(...payload: unknown[]): void;
}

export interface PartialExecutionOpts {
  /**
   * Opaque state produced by the invalidation strategy when reading the
   * cache, handed back to it when storing the result of this request.
   */
  cacheState?: unknown;
  linkSelections: Record<string, SelectionSetNode>;
  /** Coordinates whose selection sets were narrowed in `query`. */
  prunedCoordinates?: readonly string[];
  /** The entities requested by each cache resolution in `query`. */
  resolutions?: ResolutionExpectations;
  /**
   * The document to execute. `undefined` together with a `result` means that
   * the cached result can be served as-is.
   */
  query?: DocumentNode;
  result?: CachedExecutionResult;
}

export interface InvalidationGetPartialExecutionOptsParameter {
  cacheKey: string;
  operationName?: string;
  query: DocumentNode;
  resolvers: CacheResolverMap;
}

export interface InvalidationStoreExecutionResultParameter {
  cacheKey: string;
  cacheState?: unknown;
  collectedEntities: readonly EntityWithLocation[];
  entityTtls: Record<string, number>;
  executionResult: CachedExecutionResult;
  /**
   * The result was produced by merging fresh data into a cached result, as
   * opposed to executing the whole operation.
   */
  mergedIntoCachedResult?: boolean;
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

/**
 * Guards a set insertion against invalidations that happened after a request
 * started reading from the cache. The insertion is skipped if any of the
 * `markers` has been invalidated at an epoch later than `epoch`.
 */
export interface InvalidationGuard {
  epoch: number;
  markers: readonly string[];
}

export interface AddMembersOptions {
  guard?: InvalidationGuard;
  /**
   * Only add members that aren't in the set yet; never extend the expiry of
   * an existing member.
   */
  onlyNew?: boolean;
}

/**
 * Makes a pipe's mutations conditional: they only apply if no pipe with the
 * same key and a later epoch has been executed before (within `ttl`).
 */
export interface StoreCondition {
  epoch: number;
  key: string;
  ttl: number;
}

export interface InvalidateParameter {
  /** Index sets: every member is a key that is deleted, as is the set itself. */
  indexes?: Iterable<string>;
  keys: Iterable<string>;
  markers: Iterable<string>;
}

export interface CacheMutations {
  /**
   * Adds members to a set, each with its own time to live (in ms). The set
   * itself lives as long as its longest-lived member.
   */
  addMembersToSet(
    key: string,
    membersWithTtls: Iterable<[string, number]>,
    options?: AddMembersOptions,
  ): Promise<void>;
  clear(keys: Iterable<string>): Promise<void>;
  removeMembersFromSet(key: string, members: Iterable<string>): Promise<void>;
  set(key: string, data: string, ttl: number): Promise<void>;
}

export interface Cache extends CacheMutations {
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** The current invalidation epoch. Read before a request touches any data. */
  getEpoch(): Promise<number>;
  /**
   * Mutations queued on a pipe are applied atomically by `execute()`, and
   * only if the optional condition holds.
   */
  getPipe(condition?: StoreCondition): CachePipe;
  getSetMembers(key: string): Promise<string[]>;
  /**
   * Atomically bumps the invalidation epoch, records it for every marker and
   * deletes the given keys (and the keys listed in the given index sets).
   */
  invalidate(parameter: InvalidateParameter): Promise<void>;
  isSetMember(key: string, member: string): Promise<boolean>;
}

export interface CachePipe extends CacheMutations {
  execute(): Promise<void>;
}

export interface CacheResolver {
  batch?: boolean;
  idArg: string;
  rootField: string;
  type: "string" | "int" | "float";
  /**
   * Type conditions that apply to the resolved type: its interfaces and the
   * unions it belongs to. Fragments on anything else are left out of
   * resolutions. Filled in from the schema where available.
   */
  typeConditions?: string[];
}

export type CacheResolverMap = Record<string, CacheResolver>;

export interface EntityTreeNode {
  children: Map<string, EntityTreeNode>;
  coordinates: string;
  /** Invalidated, or below an invalidated node within the same segment: select in full. */
  isDirty: boolean;
  isEntity: boolean;
  isInvalidated: boolean;
  /** Objects that aren't identifiable entities were seen at this node. */
  hasOpaqueObjects: boolean;
  isList: boolean;
  /** On the path from the root to an invalidated entity. */
  isRequired: boolean;
  /**
   * Every entity type seen at this node has a cache resolver, so the node
   * can be severed from the document and reached through a link instead.
   */
  linkable: boolean;
  /** Entity ids that must be re-resolved through this node's cache resolvers. */
  requiredEntities: Map<string, Set<string>>;
  resolvers: CacheResolverMap;
  typenames: Set<string>;
}

export interface CacheResolvedEntity extends ObjMap<unknown> {
  [ALIAS_ENTITYCACHE_ID]: Id;
  [ALIAS_ENTITYCACHE_TYPENAME]: string;
}

export function isCacheResolvedEntity(
  value: unknown,
): value is CacheResolvedEntity {
  return (
    isObject(value) &&
    getMarkedTypename(value) !== undefined &&
    getMarkedId(value) !== undefined
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
  data: Record<string, unknown>,
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
  cacheState?: unknown;
  cachedResult?: ExecutionResult;
  /** Merge state for `cachedResult`; created from it if omitted. */
  mergeContext?: MergeContext;
  /** For each of `nextResults`, the entities its cache resolutions requested. */
  resolutions?: readonly (ResolutionExpectations | undefined)[];
  nextResults: ExecutionResult[];
  originalDocument: DocumentNode;
}

export type ResultProcessor = (parameter: ResultProcessorParameter) => Promise<{
  collectedEntities: readonly EntityWithLocation[];
  result: ExecutionResult;
}>;

export interface UsePartialCacheParameter<
  PluginContext extends Record<string, unknown> = NonNullable<unknown>,
> {
  awaitWriteBeforeResponse?: boolean;

  buildResponseCacheKey?: BuildResponseCacheKeyFunction;

  cacheResolvers?: CacheResolverMap;

  collectEntityWithLocation?: CollectEntityWithLocationFunction;

  enabled?(context: PluginContext): boolean;

  entityTtls?: Record<string, number>;

  getDocumentString?: GetDocumentStringFunction;

  idFields?: readonly string[];

  includeExtensionMetadata?: boolean;

  invalidationStrategy: InvalidationStrategy;

  logger?: Logger;

  /**
   * Returns an identifier that partitions the cache. Results are only shared
   * between requests that return the same identifier; `null`/`undefined`
   * means the result is shared by all requests without a session.
   */
  session(context: PluginContext): string | undefined | null;

  shouldCacheResult?: ShouldCacheResultFunction;

  ttl: number;
}

export interface MakeQueryRunnerParameter {
  buildResponseCacheKey?: BuildResponseCacheKeyFunction;

  cacheResolvers: CacheResolverMap;

  enabled?(context: unknown): boolean;

  formatResult?: FormatResult;

  getDocumentString?: GetDocumentStringFunction;

  getPartialExecutionOpts(
    parameter: InvalidationGetPartialExecutionOptsParameter,
  ): Promise<PartialExecutionOpts>;

  logger?: Logger;

  processResult: ResultProcessor;

  session(context: unknown): string | undefined | null;
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
  logger?: Logger;
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
  variables?: Record<string, unknown> | null | undefined;
}

export type SerializedKnownEntitiesMap = Record<string, string[]>;

/** The entities each cache resolution alias requested, by alias. */
export type ResolutionExpectations = Record<
  string,
  { ids: string[]; typename: string }
>;

export interface LinkGroup {
  coordinates: string;
  ids: string[];
  typename: string;
}

export interface LayeredExecutionContext {
  linkSelections: Record<string, SelectionSetNode>;
  variableDefinitions: readonly VariableDefinitionNode[];
}
