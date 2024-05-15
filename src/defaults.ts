import { ALIAS_ENTITYCACHE_ID, ALIAS_ENTITYCACHE_TYPENAME } from "./constants";
import {
  EntityRecord,
  EntityTypeReference,
  EntityWithLocation,
  Maybe,
  PathPart,
  RunQueryArgs,
  ShouldCacheResultFunction,
  isListPathPart,
} from "./typings";
import { ExecutionArgs } from "graphql";
import { hashSHA256 } from "./hashSHA256";
import jsonStableStringify from "fast-json-stable-stringify";
import { dataPathToStr, memoizedPrint, strToDataPath } from "./utils";

export const defaultBuildResponseCacheKey = (params: {
  documentString: string;
  operationName?: Maybe<string>;
  sessionId: Maybe<string>;
  variableValues: ExecutionArgs["variableValues"];
}): Promise<string> =>
  hashSHA256(
    [
      params.documentString,
      params.operationName ?? "",
      jsonStableStringify(params.variableValues ?? {}),
      params.sessionId ?? "",
    ].join("|"),
  );

export function defaultCollectEntityWithLocation(
  data: any,
  path: readonly PathPart[],
): EntityWithLocation | null {
  const typename = data[ALIAS_ENTITYCACHE_TYPENAME];
  const id = data[ALIAS_ENTITYCACHE_ID];

  if (!typename) {
    return null;
  }

  const entity: EntityRecord = { id, typename };

  const lastPathPart = path[path.length - 1];

  if (isListPathPart(lastPathPart)) {
    const nextPath = path.slice(0, 1);
    nextPath.push({ ...lastPathPart, id });
    path = nextPath;
  }

  return { entity, path };
}

export const defaultShouldCacheResult: ShouldCacheResultFunction = (
  params,
): boolean => {
  if (params.result.errors) {
    console.warn("[Mangrove] Failed to cache due to errors");
    return false;
  }

  return true;
};

export function defaultGetDocumentString(args: RunQueryArgs): string {
  return memoizedPrint(args.document);
}

export function defaultParseEntityReferenceKey(
  str: string,
): EntityTypeReference | null {
  const [entity, strPath] = str.split(">");
  if (!entity) {
    return null;
  }
  return {
    entityKey: entity,
    path: strToDataPath(strPath),
  };
}

export function defaultParseEntityKey(str: string): EntityRecord {
  const [typename, id] = str.split(":");
  return { id, typename };
}

export function defaultBuildLazyOperationKey(cacheKey: string) {
  return `operation:${cacheKey}`;
}

export function defaultBuildDocumentKey(cacheKey: string) {
  return `document:${cacheKey}`;
}

export function defaultBuildEntityKey(entity: EntityRecord) {
  let key = entity.typename;
  if (entity.id) {
    key = `${key}:${entity.id}`;
  }
  return key;
}

export function defaultBuildEntityReferenceKey(
  entityReference: EntityTypeReference,
): string {
  const path = dataPathToStr(entityReference.path);
  return `${entityReference.entityKey}>${path}`;
}
