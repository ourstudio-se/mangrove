import { FieldNode, GraphQLError, ValidationRule } from "graphql";
import { PARTIAL_CACHE_ALIASPREFIX } from "../constants.js";

/**
 * Rejects aliases that could be mistaken for Mangrove's cache resolution
 * aliases. Fragments can contribute root fields too, so every field alias is
 * checked.
 */
export const noAliasConventionConflictsRule: ValidationRule = (context) => {
  return {
    Field(node: FieldNode) {
      if (node.alias?.value.startsWith(PARTIAL_CACHE_ALIASPREFIX)) {
        context.reportError(
          new GraphQLError(
            `Field aliases can't start with ${PARTIAL_CACHE_ALIASPREFIX}`,
            { nodes: [node] },
          ),
        );
      }
    },
  };
};
