import {
  ALIAS_ENTITYCACHE_ID,
  ALIAS_ENTITYCACHE_TYPENAME,
  DIRECTIVE_NAME_IDFIELD,
} from "./constants.js";
import {
  DocumentNode,
  FieldNode,
  GraphQLCompositeType,
  GraphQLSchema,
  InlineFragmentNode,
  Kind,
  OperationTypeNode,
  SelectionNode,
  TypeInfo,
  isAbstractType,
  isInterfaceType,
  isObjectType,
  visit,
  visitWithTypeInfo,
} from "graphql";
import { idMarkerAlias } from "./markers.js";
import { memoize1 } from "./borrowedTools/memoize.js";

function typenameSelection(): FieldNode {
  return {
    alias: { kind: Kind.NAME, value: ALIAS_ENTITYCACHE_TYPENAME },
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: "__typename" },
  };
}

function idSelection(idField: string, alias = ALIAS_ENTITYCACHE_ID): FieldNode {
  return {
    alias: { kind: Kind.NAME, value: alias },
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: idField },
  };
}

/** The id marker for `idField` of a type, typed after the field's type. */
function schemaIdSelection(
  schema: GraphQLSchema,
  typename: string,
  idField: string,
): FieldNode {
  const type = schema.getType(typename);
  const fieldType =
    isObjectType(type) || isInterfaceType(type)
      ? type.getFields()[idField]?.type.toString()
      : undefined;
  return idSelection(idField, idMarkerAlias(fieldType));
}

function idOnTypeSelection(
  schema: GraphQLSchema,
  typename: string,
  idField: string,
): InlineFragmentNode {
  return {
    kind: Kind.INLINE_FRAGMENT,
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections: [schemaIdSelection(schema, typename, idField)],
    },
    typeCondition: {
      kind: Kind.NAMED_TYPE,
      name: { kind: Kind.NAME, value: typename },
    },
  };
}

/**
 * Documents produced by the parsers. Servers may cache parsed documents and
 * feed them through the parser again (e.g. GraphQL Yoga's parser cache), so
 * decorating must be idempotent.
 */
const decoratedDocuments = new WeakSet<DocumentNode>();

function markDecorated(document: DocumentNode) {
  decoratedDocuments.add(document);
  return document;
}

/**
 * Only documents consisting of queries are decorated: anything else is
 * executed without the cache, and fragments shared with mutations or
 * subscriptions would otherwise leak marker fields into their results.
 */
function isQueryOnlyDocument(document: DocumentNode) {
  return document.definitions.every(
    (definition) =>
      definition.kind !== Kind.OPERATION_DEFINITION ||
      definition.operation === OperationTypeNode.QUERY,
  );
}

/**
 * Decorates a client document with the marker fields Mangrove needs to
 * identify entities. Use `@idField` to mark the id field of an entity.
 */
export const parseClientQuery = memoize1((documentNode: DocumentNode) => {
  if (decoratedDocuments.has(documentNode)) {
    return documentNode;
  }

  const decorate = isQueryOnlyDocument(documentNode);

  return markDecorated(
    visit(documentNode, {
      Directive: {
        leave: (directiveNode) => {
          if (directiveNode.name.value === DIRECTIVE_NAME_IDFIELD) {
            return null;
          }
          return;
        },
      },
      SelectionSet: (selectionSet) => {
        if (!decorate) {
          return;
        }

        const selections = selectionSet.selections;
        let idField: string | undefined;

        for (const sel of selections) {
          if (
            sel.kind === Kind.FIELD &&
            sel.directives?.some(
              (dir) => dir.name.value === DIRECTIVE_NAME_IDFIELD,
            )
          ) {
            idField = sel.name.value;
            break;
          }
        }

        return {
          ...selectionSet,
          selections: [
            ...selections,
            typenameSelection(),
            ...(idField ? [idSelection(idField)] : []),
          ],
        };
      },
    }),
  );
});

function getMarkerSelections(
  schema: GraphQLSchema,
  parentType: GraphQLCompositeType | null | undefined,
  idFieldByTypeName: Map<string, string>,
): SelectionNode[] {
  const selections: SelectionNode[] = [typenameSelection()];

  if (!parentType) {
    return selections;
  }

  const idField = idFieldByTypeName.get(parentType.name);

  if (idField) {
    selections.push(schemaIdSelection(schema, parentType.name, idField));
  } else if (isAbstractType(parentType)) {
    for (const possibleType of schema.getPossibleTypes(parentType)) {
      const possibleIdField = idFieldByTypeName.get(possibleType.name);
      if (possibleIdField) {
        selections.push(
          idOnTypeSelection(schema, possibleType.name, possibleIdField),
        );
      }
    }
  }

  return selections;
}

export function getParserFromSchema(
  schema: GraphQLSchema,
  idFieldByTypeName: Map<string, string>,
) {
  return memoize1((document: DocumentNode) => {
    if (decoratedDocuments.has(document) || !isQueryOnlyDocument(document)) {
      return document;
    }

    const typeInfo = new TypeInfo(schema);

    return markDecorated(
      visit(
        document,
        visitWithTypeInfo(typeInfo, {
          SelectionSet(node) {
            return {
              ...node,
              selections: [
                ...node.selections,
                ...getMarkerSelections(
                  schema,
                  typeInfo.getParentType(),
                  idFieldByTypeName,
                ),
              ],
            };
          },
        }),
      ),
    );
  });
}
