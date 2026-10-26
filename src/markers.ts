import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
} from "./constants.js";

/*
 * Mangrove adds "marker" fields to documents to identify entities:
 * `__entityCacheTypeName: __typename` and an id marker. The id marker of an
 * id field of type `ID!` is `__entityCacheId`; id fields of other types get a
 * suffix encoding the type (e.g. `__entityCacheId_ID` for a nullable ID), so
 * that the markers of differently typed ids (e.g. in different members of a
 * union) never conflict.
 */

const ID_MARKER_PREFIX = `${ALIAS_ENTITYCACHE_ID}_`;

export function idMarkerAlias(idFieldType?: string) {
  if (idFieldType === undefined || idFieldType === "ID!") {
    return ALIAS_ENTITYCACHE_ID;
  }
  return `${ID_MARKER_PREFIX}${idFieldType.replace(/!/g, "_")}`;
}

export function isIdMarkerKey(key: string) {
  return key === ALIAS_ENTITYCACHE_ID || key.startsWith(ID_MARKER_PREFIX);
}

export function isMarkerKey(key: string) {
  return key === ALIAS_ENTITYCACHE_TYPENAME || isIdMarkerKey(key);
}

/** The entity id carried by an object's id markers, as a string. */
export function getMarkedId(
  value: Record<string, unknown>,
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!isIdMarkerKey(key)) {
      continue;
    }
    const id = value[key];
    if (typeof id === "string" || typeof id === "number") {
      return String(id);
    }
  }
  return undefined;
}

export function getMarkedTypename(
  value: Record<string, unknown>,
): string | undefined {
  const typename = value[ALIAS_ENTITYCACHE_TYPENAME];
  return typeof typename === "string" && typename !== "" ? typename : undefined;
}
