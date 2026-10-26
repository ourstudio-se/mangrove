import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
} from "./constants.js";
import {
  EntityRecord,
  EntityWithLocation,
  Maybe,
  PathPart,
  RunQueryArgs,
  ShouldCacheResultFunction,
} from "./typings.js";
import { ExecutionArgs } from "graphql";
import { hashSHA256 } from "./hashSHA256.js";
import jsonStableStringify from "fast-json-stable-stringify";
import { memoizedPrint } from "./utils.js";

export const defaultBuildResponseCacheKey = (params: {
  documentString: string;
  operationName?: Maybe<string>;
  sessionId: Maybe<string>;
  variableValues: ExecutionArgs["variableValues"];
}): Promise<string> =>
  hashSHA256(
    jsonStableStringify([
      params.documentString,
      params.operationName ?? null,
      params.variableValues ?? {},
      params.sessionId ?? null,
    ]),
  );

/**
 * Treats objects that carry both an entity typename and an id as entities.
 * The root object is an entity identified by its typename alone, so that the
 * root can be invalidated (`invalidateEntities([{ typename: "Query" }])`).
 *
 * The returned path has its last part annotated with the entity's typename and
 * id (normalized to a string).
 */
export function defaultCollectEntityWithLocation(
  data: Record<string, unknown>,
  path: readonly PathPart[],
): EntityWithLocation | null {
  const typename = data[ALIAS_ENTITYCACHE_TYPENAME];
  const rawId = data[ALIAS_ENTITYCACHE_ID];

  if (typeof typename !== "string" || typename === "") {
    return null;
  }

  if (typeof rawId !== "string" && typeof rawId !== "number") {
    if (path.length === 1) {
      return { entity: { typename }, path };
    }
    return null;
  }

  const id = String(rawId);

  const lastPathPart = path[path.length - 1];

  const annotatedPath: PathPart[] = [
    ...path.slice(0, -1),
    { ...lastPathPart, id, typename },
  ];

  return { entity: { id, typename }, path: annotatedPath };
}

export const defaultShouldCacheResult: ShouldCacheResultFunction = (
  params,
): boolean => {
  return !params.result.errors?.length;
};

export function defaultGetDocumentString(args: RunQueryArgs): string {
  return memoizedPrint(args.document);
}

export function defaultBuildLazyOperationKey(cacheKey: string) {
  return `operation:${cacheKey}`;
}

export function defaultBuildEntityKey(entity: EntityRecord) {
  let key = entity.typename;
  if (entity.id !== undefined && entity.id !== null) {
    key = `${key}:${entity.id}`;
  }
  return key;
}

export function defaultBuildTypeIndexKey(typename: string) {
  return `typeindex:${typename}`;
}
