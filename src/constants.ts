import { OperationTypeNode } from "graphql";

export const PARTIAL_CACHE_ALIASPREFIX = "_ENTITY_";

export const CoordinateRoot = {
  [OperationTypeNode.MUTATION]: "Mutation",
  [OperationTypeNode.QUERY]: "Query",
  [OperationTypeNode.SUBSCRIPTION]: "Subscription",
};

export const ALIAS_ENTITYCACHE_ID = "__entityCacheId";
export const ALIAS_ENTITYCACHE_TYPENAME = "__entityCacheTypeName";

export const DIRECTIVE_NAME_IDFIELD = "idField";
export const DIRECTIVE_NAME_CACHERESOLVER = "cacheResolver";
export const DIRECTIVE_NAME_CACHEENTITY = "cacheEntity";

export const ROOT_ENTITY_ID = JSON.stringify(`{"__root": true}`);
