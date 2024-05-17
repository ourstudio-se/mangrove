import {
  DocumentNode,
  FieldNode,
  Kind,
  OperationDefinitionNode,
  SelectionSetNode,
  visit,
} from "graphql";
import { EntityTreeNode } from "./typings";
import { convertFieldNodeToLink } from "./links";
import { getCacheResolutionMapper } from "./getCacheResolutionMapper";
import { memoInlineFragments, pruneSelectionSet } from "./utils";
import { visitWithEntityTree } from "./tree";

export interface GetPartialRecacheQueryParameter {
  entityTree: EntityTreeNode;
  originalDocument: DocumentNode;
}

export function getPartialRecacheQuery({
  originalDocument,
  entityTree,
}: GetPartialRecacheQueryParameter) {
  if (originalDocument.definitions.length > 1) {
    originalDocument = memoInlineFragments(originalDocument);
  }

  const cacheResolutions: FieldNode[] = [];
  let isNoopDocument = false;

  const linkSelections: Record<string, SelectionSetNode> = {};

  const visitor = visitWithEntityTree(entityTree, (invalidator) => ({
    [Kind.SELECTION_SET]: {
      leave: (selectionSet) => {
        const selections = invalidator.getSelectionsToKeep();
        if (selections === null) {
          return;
        }
        return pruneSelectionSet(selectionSet, selections);
      },
    },
    [Kind.INLINE_FRAGMENT]: {
      leave: (inlineFragment) => {
        /**
         * An empty selection set is not allowed in
         * GraphQL, in our IR it serves as a signal to
         * completely remove the field, allowing us to
         * distinguish it from fields that simply do not
         * have selection sets
         */
        if (inlineFragment.selectionSet.selections.length === 0) {
          return null;
        }
        return;
      },
    },
    [Kind.OPERATION_DEFINITION]: {
      leave: (operation) => {
        const selections = [
          ...(operation.selectionSet?.selections ?? []),
          ...cacheResolutions,
        ];

        if (selections.length === 0) {
          isNoopDocument = true;
          return null;
        }

        return <OperationDefinitionNode>{
          ...operation,
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections,
          },
        };
      },
    },
    [Kind.FIELD]: {
      leave: (field) => {
        if (!field.selectionSet) {
          return;
        }

        /**
         * An empty selection set is not allowed in
         * GraphQL, in our IR it serves as a signal to
         * completely remove the field, allowing us to
         * distinguish it from fields that simply do not
         * have selection sets
         */
        if (field.selectionSet.selections.length === 0) {
          return null;
        }

        const node = invalidator.getCurrentNode();

        const coordinates = invalidator.getCoordinates();

        if (!node?.resolvers) {
          return;
        }

        const resolvers = node.resolvers;

        linkSelections[coordinates] = field.selectionSet;

        const requiredEntities = invalidator.getRequiredEntities();

        if (requiredEntities) {
          for (const [typename, ids] of Object.entries(requiredEntities)) {
            const resolver = resolvers[typename];

            if (resolver === undefined) {
              continue;
            }

            const mapResolutions = getCacheResolutionMapper(resolver);

            const resolutions = mapResolutions(
              ids,
              coordinates,
              field.selectionSet,
            );

            for (const resolution of resolutions) {
              cacheResolutions.push(resolution);
            }
          }
        }

        return convertFieldNodeToLink(field);
      },
    },
  }));

  const newDocument = visit(originalDocument, visitor);

  if (isNoopDocument) {
    return null;
  }

  return {
    linkSelections,
    query: newDocument,
  };
}
