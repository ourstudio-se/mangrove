import { CoordinateRoot, PARTIAL_CACHE_ALIASPREFIX } from "./constants.js";

export class CacheResolutionError extends Error {}

/*
 * Cache resolution aliases encode the data coordinates they should be merged
 * back into, e.g. `Query.dashboard.my_field` -> `_ENTITY_dashboard__my_1field_i0`.
 *
 * Every underscore emitted by the encoder is the first half of a pair:
 *   `__`  -> `.`
 *   `_1`  -> a literal `_`
 *   `_i<n>` -> the (unique) resolution index, always last
 * which makes the encoding reversible for any valid GraphQL name.
 */

function encodeCoordinates(coordinates: string) {
  let out = "";
  for (const char of coordinates) {
    if (char === "_") {
      out += "_1";
    } else if (char === ".") {
      out += "__";
    } else {
      out += char;
    }
  }
  return out;
}

export function getCacheResolverAlias(coordinates: string, index: number) {
  const relative = coordinates.startsWith(`${CoordinateRoot.query}.`)
    ? coordinates.slice(CoordinateRoot.query.length + 1)
    : coordinates;

  return `${PARTIAL_CACHE_ALIASPREFIX}${encodeCoordinates(relative)}_i${index}`;
}

export function isCacheAliasName(nameValue: string) {
  return nameValue.startsWith(PARTIAL_CACHE_ALIASPREFIX);
}

/**
 * Returns the absolute coordinates (`Query.…`) encoded in a cache resolver alias.
 */
export function parseCacheResolverAlias(alias: string) {
  const encoded = alias.slice(PARTIAL_CACHE_ALIASPREFIX.length);
  let out = "";

  for (let i = 0; i < encoded.length; i++) {
    const char = encoded[i];

    if (char !== "_") {
      out += char;
      continue;
    }

    const next = encoded[i + 1];

    if (next === "_") {
      out += ".";
      i++;
    } else if (next === "1") {
      out += "_";
      i++;
    } else if (next === "i" && /^\d+$/.test(encoded.slice(i + 2))) {
      break;
    } else {
      throw new CacheResolutionError(
        `Malformed cache resolver alias: ${alias}`,
      );
    }
  }

  return `${CoordinateRoot.query}.${out}`;
}
