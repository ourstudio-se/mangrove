import {
  CacheExtension,
  EntityWithLocation,
  Id,
  KnownEntitiesMap,
  PathPart,
  SerializedKnownEntitiesMap,
  isCacheResolvedEntityList,
  isListPathPart,
} from "./typings.js";
import {
  CoordinateRoot,
  PARTIAL_CACHE_ALIASPREFIX,
  ROOT_ENTITY_ID,
} from "./constants.js";
import {
  DocumentNode,
  ExecutionResult,
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

export function isCacheAliasName(nameValue: string) {
  return nameValue.startsWith(PARTIAL_CACHE_ALIASPREFIX);
}

export function getCacheAlias(nameValue: string) {
  return `${PARTIAL_CACHE_ALIASPREFIX}${nameValue}`;
}

export function pruneSelectionSet(
  selectionSet: SelectionSetNode,
  keepSelections: readonly string[],
): SelectionSetNode | null {
  const selections = selectionSet.selections.filter((selection) => {
    switch (selection.kind) {
      case Kind.FIELD:
        return keepSelections.includes(
          selection.alias?.value ?? selection.name.value,
        );
      default:
        return true;
    }
  });

  return {
    ...selectionSet,
    selections,
  };
}

function dataPathPartToStr(part: PathPart) {
  let str = part.field;

  if (isListPathPart(part)) {
    if (part.index !== undefined) {
      str = `${str}@${part.index.toString()}`;
    }
    if (part.id !== undefined) {
      str = `${str}#${JSON.stringify(part.id)}`;
    }
  }
  return str;
}

function strToDataPathPart(str: string): PathPart {
  let index: number | undefined;
  let id: Id | undefined;

  if (str.indexOf("@") !== -1) {
    let strIndex: string;
    [str, strIndex] = str.split("@");
    if (strIndex.indexOf("#") !== -1) {
      let strId: string;
      [strIndex, strId] = strIndex.split("#");
      id = JSON.parse(strId);
    }
    index = parseInt(strIndex, 10);
  }

  const field = str;

  return {
    field,
    id,
    index,
  };
}

export function dataPathToStr(path: readonly PathPart[]) {
  return path.map(dataPathPartToStr).join(".");
}

export function strToDataPath(str: string): readonly PathPart[] {
  if (str === "") {
    throw new Error("Empty string cannot be a data path");
  }
  return str.split(".").map(strToDataPathPart);
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

export function indexWiseDeepMerge<Target>(
  target: Target,
  ...sources: unknown[]
): Target {
  if (!sources.length) {
    return target;
  }

  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key])
          Object.assign(target, {
            [key]: isArray(source[key]) ? [] : {},
          });
        indexWiseDeepMerge(target[key], source[key]);
      } else {
        const arrTarget = target[key];
        let arrSource = source[key];
        if (
          isCacheResolvedEntityList(arrTarget) &&
          isCacheResolvedEntityList(arrSource)
        ) {
          /*
           * Dynamically merge entity lists
           * Should probably move this logic somewhere else
           * or change the name of the func
           */
          arrSource = arrSource.map((sourceEntity) => {
            const targetEntity = arrTarget.find(
              (entity) =>
                entity.__entityCacheId === sourceEntity.__entityCacheId,
            );
            if (targetEntity !== undefined) {
              return indexWiseDeepMerge({ ...targetEntity }, sourceEntity);
            }
            return sourceEntity;
          });
        }
        Object.assign(target, { [key]: arrSource });
      }
    }
  }

  return indexWiseDeepMerge(target, ...sources);
}

export function isIntrospectionQuery(operation: OperationDefinitionNode) {
  if (operation.operation !== "query") {
    return false;
  }

  return operation.selectionSet.selections.every((selection) => {
    return selection.kind === Kind.FIELD && selection.name.value === "__schema";
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

function inlineFragments(originalDocument: DocumentNode) {
  const fragmentDefs: Record<string, FragmentDefinitionNode> = {};

  originalDocument = visit(originalDocument, {
    [Kind.FRAGMENT_DEFINITION]: (fragment) => {
      fragmentDefs[fragment.name.value] = fragment;
      return null;
    },
  });

  function flattenSelectionSet(
    selectionSet: SelectionSetNode,
  ): SelectionSetNode {
    return {
      ...selectionSet,
      selections: selectionSet.selections.map(flattenSelection),
    };
  }

  function flattenSelection(selection: SelectionNode): SelectionNode {
    switch (selection.kind) {
      case Kind.FIELD:
        return selection;
      case Kind.INLINE_FRAGMENT:
        return {
          ...selection,
          selectionSet: flattenSelectionSet(selection.selectionSet),
        };
      case Kind.FRAGMENT_SPREAD: {
        const fragment = fragmentDefs[selection.name.value];
        if (!fragment) {
          throw new GraphQLError(
            "Fragment definition does not exist: " + selection.name.value,
            { nodes: [selection] },
          );
        }
        return {
          kind: Kind.INLINE_FRAGMENT,
          selectionSet: flattenSelectionSet(fragment.selectionSet),
          typeCondition: fragment.typeCondition,
        };
      }
    }
  }

  return visit(originalDocument, {
    [Kind.SELECTION_SET]: (selectionSet) => {
      return flattenSelectionSet(selectionSet);
    },
  });
}

export const memoInlineFragments = memoize1(inlineFragments);

export function gql(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce((acc, str, i) => acc + str + (values[i] || ""), "");
}

export function isId(id: unknown): id is Id {
  return typeof id === "string" || typeof id === "number";
}

export function isRootId(id: Id) {
  return id === ROOT_ENTITY_ID;
}

export function attachToCacheExtensions<
  T extends keyof NonNullable<CacheExtension["cache"]>,
>(
  result: ExecutionResult,
  key: T,
  value: NonNullable<CacheExtension["cache"]>[T],
) {
  result.extensions ??= {};
  result.extensions.cache ??= {};
  (result.extensions.cache as NonNullable<CacheExtension["cache"]>)[key] =
    value;
}

export const memoizedPrint = memoize1(print);

export function collectEntityRecords(
  data: unknown,
  collectEntityWithLocation = defaultCollectEntityWithLocation,
  path: readonly PathPart[] = [{ field: CoordinateRoot.query }],
): EntityWithLocation[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }

  if (isObject(data)) {
    const records: EntityWithLocation[] = [];

    const entity = collectEntityWithLocation(data, path);

    if (entity) {
      records.push(entity);
    }

    for (const key of Object.keys(data)) {
      const nextPath = [...path, { field: key }];

      const childRecords = collectEntityRecords(
        data[key],
        collectEntityWithLocation,
        nextPath,
      );

      for (const childRecord of childRecords) {
        records.push(childRecord);
      }
    }

    return records;
  }

  if (isArray(data)) {
    return data.flatMap((item, index) => {
      const finalPart = path[path.length - 1];
      if (!finalPart) {
        return [];
      }
      const nextPath = [
        ...path.slice(0, path.length - 1),
        { ...finalPart, index },
      ];
      return collectEntityRecords(item, collectEntityWithLocation, nextPath);
    });
  }

  return [];
}

export function getKnownEntities(
  collectedEntities: readonly EntityWithLocation[],
) {
  const knownEntities: KnownEntitiesMap = {};

  for (const {
    entity: { typename, id },
  } of collectedEntities) {
    if (!id) {
      continue;
    }

    let typeIds = knownEntities[typename];

    if (typeIds === undefined) {
      typeIds = new Set();
      knownEntities[typename] = typeIds;
    }

    typeIds.add(id);
  }

  return knownEntities;
}

export function serializeKnownEntities(
  knownEntities: KnownEntitiesMap,
): SerializedKnownEntitiesMap {
  return Object.fromEntries(
    Object.entries(knownEntities).map(([typename, ids]) => [
      typename,
      Array.from(ids),
    ]),
  );
}

export function deserializeKnownEntities(
  serializeKnownEntities: SerializedKnownEntitiesMap,
): KnownEntitiesMap {
  return Object.fromEntries(
    Object.entries(serializeKnownEntities).map(([typename, ids]) => [
      typename,
      new Set(ids),
    ]),
  );
}
