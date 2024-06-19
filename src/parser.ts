import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  DIRECTIVE_NAME_IDFIELD,
} from "./constants.js";
import {
  DocumentNode,
  GraphQLSchema,
  Kind,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from "graphql";
import { memoize1 } from "./borrowedTools/memoize.js";

function getCacheSelections(idField?: string) {
  return [
    {
      alias: {
        kind: Kind.NAME,
        value: ALIAS_ENTITYCACHE_TYPENAME,
      },
      kind: Kind.FIELD,
      name: {
        kind: Kind.NAME,
        value: "__typename",
      },
    },
    ...(idField
      ? [
          {
            alias: { kind: Kind.NAME, value: ALIAS_ENTITYCACHE_ID },
            kind: Kind.FIELD,
            name: { kind: Kind.NAME, value: idField },
          },
        ]
      : []),
  ];
}

export const parseClientQuery = memoize1((documentNode: DocumentNode) => {
  return visit(documentNode, {
    Directive: {
      leave: (directiveNode) => {
        if (directiveNode.name.value === DIRECTIVE_NAME_IDFIELD) {
          return null;
        }
        return;
      },
    },
    SelectionSet: (selectionSet) => {
      const selections = selectionSet.selections;
      let idField: string | undefined;

      for (const sel of selections) {
        if (sel.kind === Kind.FIELD && sel.directives) {
          const index = sel.directives.findIndex(
            (dir) => dir.name.value === DIRECTIVE_NAME_IDFIELD,
          );

          if (index !== -1) {
            idField = sel.name.value;
            break;
          }
        }
      }

      return {
        ...selectionSet,
        selections: [...selections, ...getCacheSelections(idField)],
      };
    },
  });
});

export function getParserFromSchema(
  schema: GraphQLSchema,
  idFieldByTypeName: Map<string, string>,
) {
  return memoize1((document: DocumentNode) => {
    const typeInfo = new TypeInfo(schema);
    return visit(
      document,
      visitWithTypeInfo(typeInfo, {
        OperationDefinition: {
          enter(node): void | false {
            if (node.operation !== "query") {
              return false;
            }
          },
        },
        SelectionSet(node) {
          const parentType = typeInfo.getParentType();
          const idField =
            (parentType && idFieldByTypeName.get(parentType.name)) ?? undefined;
          return {
            ...node,
            selections: [...node.selections, ...getCacheSelections(idField)],
          };
        },
      }),
    );
  });
}
