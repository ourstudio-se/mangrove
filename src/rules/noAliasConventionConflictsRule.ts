import { FieldNode, GraphQLError, Kind, ValidationRule } from "graphql";
import { PARTIAL_CACHE_ALIASPREFIX } from "../constants.js";

export const noAliasConventionConflictsRule: ValidationRule = (context) => {
  return {
    OperationDefinition(operationDefinitionNode) {
      const errorNodes: FieldNode[] = [];
      for (const selection of operationDefinitionNode.selectionSet.selections) {
        if (selection.kind !== Kind.FIELD) {
          continue;
        }
        if (selection.alias?.value.startsWith(PARTIAL_CACHE_ALIASPREFIX)) {
          errorNodes.push(selection);
        }
      }

      context.reportError(
        new GraphQLError(
          `Root field aliases can't start with ${PARTIAL_CACHE_ALIASPREFIX}`,
          {
            nodes: errorNodes,
          },
        ),
      );
    },
  };
};
