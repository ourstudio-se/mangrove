import { ALIAS_ENTITYCACHE_TYPENAME } from "./constants.js";
import { isIdMarkerKey, isMarkerKey } from "./markers.js";
import {
  ASTVisitor,
  DocumentNode,
  FieldNode,
  Kind,
  OperationDefinitionNode,
  OperationTypeNode,
  SelectionNode,
  SelectionSetNode,
  visit,
} from "graphql";
import { EntityTree, visitWithEntityTree } from "./tree.js";
import {
  ResolutionAliases,
  mapCacheResolutions,
} from "./getCacheResolutionMapper.js";
import {
  getOperation,
  memoInlineFragments,
  pruneSelectionSet,
  pruneUnusedVariables,
} from "./utils.js";
import {
  CacheResolver,
  EntityTreeNode,
  ResolutionExpectations,
} from "./typings.js";

export interface GetPartialRecacheQueryParameter {
  entityTree: EntityTree;
  operationName?: string;
  originalDocument: DocumentNode;
}

export interface PartialRecacheQuery {
  /** Selection sets to use for link queries, by coordinates. */
  linkSelections: Record<string, SelectionSetNode>;
  /** Coordinates whose selection sets were narrowed down. */
  prunedCoordinates: string[];
  query: DocumentNode;
  /** The entities requested by each cache resolution. */
  resolutions: ResolutionExpectations;
}

function isMarkerField(selection: SelectionNode): selection is FieldNode {
  return (
    selection.kind === Kind.FIELD &&
    selection.alias !== undefined &&
    isMarkerKey(selection.alias.value)
  );
}

function linkSelectionsOf(selectionSet: SelectionSetNode): SelectionNode[] {
  return selectionSet.selections.flatMap((selection): SelectionNode[] => {
    if (isMarkerField(selection)) {
      return [
        {
          alias: selection.alias,
          kind: Kind.FIELD,
          name: selection.name,
        },
      ];
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inner = linkSelectionsOf(selection.selectionSet);
      if (inner.length === 0) {
        return [];
      }
      return [
        {
          ...selection,
          selectionSet: { kind: Kind.SELECTION_SET, selections: inner },
        },
      ];
    }
    return [];
  });
}

function hasIdMarker(selections: readonly SelectionNode[]): boolean {
  return selections.some((selection) =>
    selection.kind === Kind.FIELD
      ? selection.alias !== undefined && isIdMarkerKey(selection.alias.value)
      : selection.kind === Kind.INLINE_FRAGMENT &&
        hasIdMarker(selection.selectionSet.selections),
  );
}

/**
 * Replaces a field's selection set with one that only identifies the entity
 * (its typename and id, inside the same type conditions as in the original).
 * Returns null if the selection set doesn't identify the entity.
 */
export function convertFieldNodeToLink(field: FieldNode): FieldNode | null {
  if (!field.selectionSet) {
    return null;
  }

  const selections = linkSelectionsOf(field.selectionSet);

  if (!hasIdMarker(selections)) {
    return null;
  }

  return {
    ...field,
    selectionSet: { kind: Kind.SELECTION_SET, selections },
  };
}

/**
 * Narrows a selection set down to what applies to `resolver`'s type
 * (`typename`), dropping inline fragments that can't apply to it. If the
 * resolver knows its type conditions (resolvers configured from a schema do),
 * only fragments on those are kept; otherwise fragments on other known entity
 * types are dropped.
 */
export function selectionSetForType(
  selectionSet: SelectionSetNode,
  typename: string,
  resolver: CacheResolver,
  otherTypenames: Iterable<string>,
): SelectionSetNode {
  const applies: (condition: string) => boolean = resolver.typeConditions
    ? (condition) =>
        condition === typename || resolver.typeConditions!.includes(condition)
    : (() => {
        const others = new Set(otherTypenames);
        others.delete(typename);
        return (condition: string) => !others.has(condition);
      })();

  return {
    ...selectionSet,
    selections: selectionSet.selections.filter(
      (selection) =>
        selection.kind !== Kind.INLINE_FRAGMENT ||
        !selection.typeCondition ||
        applies(selection.typeCondition.name.value),
    ),
  };
}

function nodeCanLink(node: EntityTreeNode | undefined): node is EntityTreeNode {
  return node !== undefined && node.linkable;
}

function selectOperation(
  originalDocument: DocumentNode,
  operationName?: string,
): OperationDefinitionNode | undefined {
  const document = memoInlineFragments(originalDocument);
  return getOperation(document, operationName);
}

/**
 * Collects the selection set of every linkable field in the unpruned
 * operation, with nested linkable fields already turned into links. These are
 * used to build link queries, which need the full selection set.
 */
function collectLinkSelections(
  operation: OperationDefinitionNode,
  entityTree: EntityTree,
): Record<string, SelectionSetNode> {
  const linkSelections: Record<string, SelectionSetNode> = {};

  visit(
    operation,
    visitWithEntityTree(
      entityTree,
      (invalidator): ASTVisitor => ({
        [Kind.FIELD]: {
          leave: (field) => {
            const node = invalidator.getCurrentNode();
            if (!field.selectionSet || !nodeCanLink(node)) {
              return;
            }
            const link = convertFieldNodeToLink(field);
            if (!link) {
              return;
            }
            linkSelections[invalidator.getCoordinates()] = field.selectionSet;
            return link;
          },
        },
      }),
    ),
  );

  return linkSelections;
}

export function getPartialRecacheQuery({
  originalDocument,
  entityTree,
  operationName,
}: GetPartialRecacheQueryParameter): PartialRecacheQuery | null {
  const operation = selectOperation(originalDocument, operationName);

  if (!operation) {
    throw new Error(
      operationName
        ? `Unknown operation "${operationName}"`
        : "Must provide operation name if query contains multiple operations",
    );
  }

  if (operation.operation !== OperationTypeNode.QUERY) {
    throw new Error(`Can't partially re-execute a ${operation.operation}`);
  }

  const linkSelections = collectLinkSelections(operation, entityTree);
  const aliases = new ResolutionAliases();
  const cacheResolutions: FieldNode[] = [];
  const prunedCoordinates: string[] = [];

  const visitor = visitWithEntityTree(
    entityTree,
    (invalidator): ASTVisitor => ({
      [Kind.SELECTION_SET]: {
        leave: (selectionSet) => {
          const selections = invalidator.getSelectionsToKeep();
          if (selections === null) {
            return;
          }
          prunedCoordinates.push(invalidator.getCoordinates());
          return pruneSelectionSet(selectionSet, selections);
        },
      },
      [Kind.INLINE_FRAGMENT]: {
        leave: (inlineFragment) => {
          /**
           * An empty selection set is not allowed in GraphQL; in our IR it
           * signals that the fragment should be removed entirely.
           */
          if (inlineFragment.selectionSet.selections.length === 0) {
            return null;
          }
          return;
        },
      },
      [Kind.FIELD]: {
        leave: (field) => {
          if (!field.selectionSet) {
            return;
          }

          if (field.selectionSet.selections.length === 0) {
            return null;
          }

          const node = invalidator.getCurrentNode();

          if (!nodeCanLink(node)) {
            return;
          }

          const link = convertFieldNodeToLink(field);

          if (!link) {
            return;
          }

          const coordinates = invalidator.getCoordinates();

          for (const [typename, ids] of node.requiredEntities) {
            const resolver = node.resolvers[typename];

            if (resolver === undefined) {
              continue;
            }

            const selectionSet = selectionSetForType(
              field.selectionSet,
              typename,
              resolver,
              [...node.typenames, ...entityTree.resolverTypenames],
            );

            cacheResolutions.push(
              ...mapCacheResolutions(
                resolver,
                typename,
                ids,
                coordinates,
                selectionSet,
                aliases,
              ),
            );
          }

          return link;
        },
      },
    }),
  );

  const rewritten = visit(operation, visitor) as OperationDefinitionNode | null;

  const selections = [
    ...(rewritten?.selectionSet.selections ?? []),
    ...cacheResolutions,
  ];

  // Nothing but the root typename (or nothing at all) left to fetch.
  const fetchesSomething = selections.some(
    (selection) =>
      !(
        selection.kind === Kind.FIELD &&
        selection.alias?.value === ALIAS_ENTITYCACHE_TYPENAME
      ),
  );

  if (!fetchesSomething) {
    return null;
  }

  const query: DocumentNode = {
    definitions: [
      pruneUnusedVariables({
        ...operation,
        selectionSet: { kind: Kind.SELECTION_SET, selections },
      }),
    ],
    kind: Kind.DOCUMENT,
  };

  return {
    linkSelections,
    prunedCoordinates,
    query,
    resolutions: aliases.expectations,
  };
}
