import { ALIAS_ENTITYCACHE_ID, CoordinateRoot } from "./constants.js";
import { getMarkedId, getMarkedTypename, isMarkerKey } from "./markers.js";
import {
  CollectEntityWithLocationFunction,
  EntityWithLocation,
  Id,
  ObjMap,
  PathPart,
  SerializedKnownEntitiesMap,
} from "./typings.js";
import {
  DefinitionNode,
  DocumentNode,
  FragmentDefinitionNode,
  GraphQLError,
  Kind,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
  print,
  visit,
} from "graphql";
import { defaultCollectEntityWithLocation } from "./defaults.js";
import { memoize1 } from "./borrowedTools/memoize.js";

export { isCacheAliasName } from "./alias.js";

export function pruneSelectionSet(
  selectionSet: SelectionSetNode,
  keepSelections: readonly string[],
): SelectionSetNode {
  const selections = selectionSet.selections.filter((selection) => {
    switch (selection.kind) {
      case Kind.FIELD: {
        const key = selection.alias?.value ?? selection.name.value;
        return (
          keepSelections.includes(key) ||
          (isMarkerKey(key) && keepSelections.includes(ALIAS_ENTITYCACHE_ID))
        );
      }
      default:
        return true;
    }
  });

  return {
    ...selectionSet,
    selections,
  };
}

/*
 * Human readable path notation, used for debugging and in tests:
 *   Query.items~Item@0#"1".owner
 * `~Type` is the entity type at that position, `@n` the list index and `#…`
 * the JSON encoded entity id. Ids may contain any character.
 */

function dataPathPartToStr(part: PathPart) {
  let str = part.field;
  if (part.typename !== undefined) {
    str += `~${part.typename}`;
  }
  if (part.index !== undefined) {
    str += `@${part.index}`;
  }
  if (part.id !== undefined) {
    str += `#${JSON.stringify(part.id)}`;
  }
  return str;
}

function splitPathString(str: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (inString) {
      current += char;
      if (char === "\\") {
        current += str[++i] ?? "";
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      current += char;
    } else if (char === ".") {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  parts.push(current);
  return parts;
}

function strToDataPathPart(str: string): PathPart {
  const match = /^([^~@#]+)(?:~([^@#]+))?(?:@(\d+))?(?:#(.+))?$/.exec(str);

  if (!match) {
    throw new Error(`Invalid data path part: ${str}`);
  }

  const [, field, typename, index, id] = match;

  const part: PathPart = { field };

  if (typename !== undefined) {
    part.typename = typename;
  }
  if (index !== undefined) {
    part.index = parseInt(index, 10);
  }
  if (id !== undefined) {
    part.id = String(JSON.parse(id));
  }

  return part;
}

export function dataPathToStr(path: readonly PathPart[]) {
  return path.map(dataPathPartToStr).join(".");
}

export function strToDataPath(str: string): readonly PathPart[] {
  if (str === "") {
    throw new Error("Empty string cannot be a data path");
  }
  return splitPathString(str).map(strToDataPathPart);
}

export function pathToCoordinates(path: readonly PathPart[]) {
  return path.map((part) => part.field).join(".");
}

export function isObject(
  value: unknown,
): value is Record<string | number | symbol, unknown> {
  return isObjectOrArray(value) && !isArray(value);
}

export function isArray(
  value: unknown,
): value is Array<unknown> | readonly unknown[] {
  return Array.isArray(value);
}

export function isObjectOrArray(
  value: unknown,
): value is object | Array<unknown> {
  return typeof value === "object" && value !== null;
}

export function not<Args extends unknown[]>(test: (...args: Args) => boolean) {
  return (...args: Args) => !test(...args);
}

/** Deep copy of JSON-like data. */
export function cloneData<T>(data: T): T {
  if (isArray(data)) {
    return data.map(cloneData) as T;
  }
  if (isObject(data)) {
    const copy: ObjMap<unknown> = {};
    for (const key of Object.keys(data)) {
      copy[key] = cloneData(data[key]);
    }
    return copy as T;
  }
  return data;
}

/** Returns a copy of `data` without Mangrove's internal marker fields. */
export function cleanupData<T>(data: T): T {
  if (isArray(data)) {
    return data.map(cleanupData) as T;
  }
  if (isObject(data)) {
    const copy: ObjMap<unknown> = {};
    for (const key of Object.keys(data)) {
      if (isMarkerKey(key)) {
        continue;
      }
      copy[key] = cleanupData(data[key]);
    }
    return copy as T;
  }
  return data;
}

export function getOperation(
  document: DocumentNode,
  operationName?: string | null,
): OperationDefinitionNode | undefined {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );

  if (operationName) {
    return operations.find(
      (operation) => operation.name?.value === operationName,
    );
  }

  return operations.length === 1 ? operations[0] : undefined;
}

export function isIntrospectionQuery(operation: OperationDefinitionNode) {
  if (operation.operation !== "query") {
    return false;
  }

  return operation.selectionSet.selections.every((selection) => {
    return (
      selection.kind === Kind.FIELD &&
      (selection.name.value === "__schema" ||
        selection.name.value === "__type" ||
        selection.name.value === "__typename")
    );
  });
}

export function isIntrospectionDocument(document: DocumentNode) {
  return document.definitions
    .filter(
      (definition): definition is OperationDefinitionNode =>
        definition.kind === Kind.OPERATION_DEFINITION,
    )
    .every(isIntrospectionQuery);
}

/**
 * Replaces every fragment spread with an equivalent inline fragment (keeping
 * the spread's directives) and drops the fragment definitions.
 */
function inlineFragments(originalDocument: DocumentNode): DocumentNode {
  const fragmentDefs: Record<string, FragmentDefinitionNode> = {};

  for (const definition of originalDocument.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragmentDefs[definition.name.value] = definition;
    }
  }

  if (Object.keys(fragmentDefs).length === 0) {
    return originalDocument;
  }

  function flattenSelectionSet(
    selectionSet: SelectionSetNode,
    visiting: readonly string[],
  ): SelectionSetNode {
    return {
      ...selectionSet,
      selections: selectionSet.selections.map((selection) =>
        flattenSelection(selection, visiting),
      ),
    };
  }

  function flattenSelection(
    selection: SelectionNode,
    visiting: readonly string[],
  ): SelectionNode {
    switch (selection.kind) {
      case Kind.FIELD:
        return selection.selectionSet
          ? {
              ...selection,
              selectionSet: flattenSelectionSet(
                selection.selectionSet,
                visiting,
              ),
            }
          : selection;
      case Kind.INLINE_FRAGMENT:
        return {
          ...selection,
          selectionSet: flattenSelectionSet(selection.selectionSet, visiting),
        };
      case Kind.FRAGMENT_SPREAD: {
        const name = selection.name.value;
        const fragment = fragmentDefs[name];
        if (!fragment) {
          throw new GraphQLError(
            "Fragment definition does not exist: " + name,
            { nodes: [selection] },
          );
        }
        if (visiting.includes(name)) {
          throw new GraphQLError(`Cyclic fragment spread: ${name}`, {
            nodes: [selection],
          });
        }
        return {
          directives: selection.directives,
          kind: Kind.INLINE_FRAGMENT,
          selectionSet: flattenSelectionSet(fragment.selectionSet, [
            ...visiting,
            name,
          ]),
          typeCondition: fragment.typeCondition,
        };
      }
    }
  }

  return {
    ...originalDocument,
    definitions: originalDocument.definitions.flatMap(
      (definition): DefinitionNode[] => {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          return [];
        }
        if (definition.kind === Kind.OPERATION_DEFINITION) {
          const operation: OperationDefinitionNode = {
            ...definition,
            selectionSet: flattenSelectionSet(definition.selectionSet, []),
          };
          return [operation];
        }
        return [definition];
      },
    ),
  };
}

export const memoInlineFragments = memoize1(inlineFragments);

/**
 * Removes variable definitions that are no longer referenced by an operation.
 */
export function pruneUnusedVariables(
  operation: OperationDefinitionNode,
): OperationDefinitionNode {
  if (!operation.variableDefinitions?.length) {
    return operation;
  }

  const used = new Set<string>();

  visit(operation.selectionSet, {
    Variable(node) {
      used.add(node.name.value);
    },
  });

  // Directives on the operation itself may reference variables too.
  for (const directive of operation.directives ?? []) {
    visit(directive, {
      Variable(node) {
        used.add(node.name.value);
      },
    });
  }

  return {
    ...operation,
    variableDefinitions: operation.variableDefinitions.filter((definition) =>
      used.has(definition.variable.name.value),
    ),
  };
}

export function gql(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce(
    (acc, str, i) => acc + str + (i < values.length ? String(values[i]) : ""),
    "",
  );
}

export function isId(id: unknown): id is Id {
  return typeof id === "string" || typeof id === "number";
}

export const memoizedPrint = memoize1(print);

/**
 * Walks result data and collects every entity together with its location.
 *
 * Paths start at `Query`. Descendants of an entity inherit the entity's
 * annotated path part (typename/id), so that every entity knows which
 * entities it was reached through.
 */
export function collectEntityRecords(
  data: unknown,
  collectEntityWithLocation: CollectEntityWithLocationFunction = defaultCollectEntityWithLocation,
  path: readonly PathPart[] = [{ field: CoordinateRoot.query }],
): EntityWithLocation[] {
  const records: EntityWithLocation[] = [];

  function walk(value: unknown, currentPath: readonly PathPart[]) {
    if (isArray(value)) {
      const last = currentPath[currentPath.length - 1];
      if (!last) {
        return;
      }
      const prefix = currentPath.slice(0, -1);
      value.forEach((item, index) => {
        walk(item, [...prefix, { field: last.field, index }]);
      });
      return;
    }

    if (!isObject(value)) {
      return;
    }

    let basePath = currentPath;

    const record = collectEntityWithLocation(
      value as Record<string, unknown>,
      currentPath,
    );

    if (record) {
      records.push(record);
      basePath = record.path;
    }

    for (const key of Object.keys(value)) {
      if (isMarkerKey(key)) {
        continue;
      }
      walk(value[key], [...basePath, { field: key }]);
    }
  }

  walk(data, path);

  return records;
}

/**
 * Coordinates at which `data` holds objects that aren't identifiable
 * entities (the root object aside). Such positions can't be reached through
 * links.
 */
export function collectOpaqueCoordinates(data: unknown): string[] {
  const found = new Set<string>();

  function walk(value: unknown, coordinates: string, isRoot: boolean) {
    if (isArray(value)) {
      for (const item of value) {
        walk(item, coordinates, false);
      }
      return;
    }
    if (!isObject(value)) {
      return;
    }
    if (
      !isRoot &&
      (getMarkedTypename(value) === undefined ||
        getMarkedId(value) === undefined)
    ) {
      found.add(coordinates);
    }
    for (const key of Object.keys(value)) {
      if (!isMarkerKey(key)) {
        walk(value[key], `${coordinates}.${key}`, false);
      }
    }
  }

  walk(data, CoordinateRoot.query, true);

  return Array.from(found);
}

export function getKnownEntities(
  collectedEntities: readonly EntityWithLocation[],
): Record<string, Set<string>> {
  const knownEntities: Record<string, Set<string>> = {};

  for (const {
    entity: { typename, id },
  } of collectedEntities) {
    if (id === undefined) {
      continue;
    }

    let typeIds = knownEntities[typename];

    if (typeIds === undefined) {
      typeIds = new Set();
      knownEntities[typename] = typeIds;
    }

    typeIds.add(String(id));
  }

  return knownEntities;
}

export function serializeKnownEntities(
  knownEntities: Record<string, Set<string>>,
): SerializedKnownEntitiesMap {
  return Object.fromEntries(
    Object.entries(knownEntities).map(([typename, ids]) => [
      typename,
      Array.from(ids),
    ]),
  );
}
