import { PARTIAL_CACHE_ALIASPREFIX } from "./constants.js";
import { getCacheAlias } from "./utils.js";

export class CacheResolutionError extends Error {}

export function getCacheResolverAlias(coordinates: string, index?: number) {
  return (
    getCacheAlias(coordinates.replace(/^Query\./g, "").replace(/\./g, "_")) +
    (index !== undefined ? `_${index}` : "")
  );
}

export function parseCacheResolverAlias(alias: string) {
  alias = alias.slice(PARTIAL_CACHE_ALIASPREFIX.length);
  return alias.replace(/_\d+$/, "").replace(/_/g, ".");
}
