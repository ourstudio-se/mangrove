import { CacheResolutionError, getCacheResolverAlias } from "./alias.js";
import { CacheResolver, ResolutionExpectations } from "./typings.js";
import { FieldNode, Kind, SelectionSetNode, ValueNode } from "graphql";

const INT_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const FLOAT_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Builds the literal for an entity id. Values are never interpolated into
 * GraphQL source text.
 */
export function idToValueNode(resolver: CacheResolver, id: string): ValueNode {
  switch (resolver.type) {
    case "int":
      if (!INT_PATTERN.test(id)) {
        throw new CacheResolutionError(
          `Id ${JSON.stringify(id)} is not a valid Int for ${resolver.rootField}(${resolver.idArg}:)`,
        );
      }
      return { kind: Kind.INT, value: id };
    case "float":
      if (!FLOAT_PATTERN.test(id)) {
        throw new CacheResolutionError(
          `Id ${JSON.stringify(id)} is not a valid Float for ${resolver.rootField}(${resolver.idArg}:)`,
        );
      }
      return { kind: Kind.FLOAT, value: id };
    case "string":
    default:
      return { kind: Kind.STRING, value: id };
  }
}

/**
 * Hands out aliases that are unique within one generated document.
 */
export class ResolutionAliases {
  /** What each alias requested, to verify the response against. */
  readonly expectations: ResolutionExpectations = {};

  private next = 0;

  alias(coordinates: string, typename: string, ids: string[]) {
    const alias = getCacheResolverAlias(coordinates, this.next++);
    this.expectations[alias] = { ids, typename };
    return alias;
  }
}

export function mapCacheResolutions(
  resolver: CacheResolver,
  typename: string,
  ids: Iterable<string>,
  coordinates: string,
  selectionSet: SelectionSetNode,
  aliases: ResolutionAliases,
): FieldNode[] {
  const idList = Array.from(ids);

  if (idList.length === 0) {
    return [];
  }

  const field = (value: ValueNode, requested: string[]): FieldNode => ({
    alias: {
      kind: Kind.NAME,
      value: aliases.alias(coordinates, typename, requested),
    },
    arguments: [
      {
        kind: Kind.ARGUMENT,
        name: { kind: Kind.NAME, value: resolver.idArg },
        value,
      },
    ],
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: resolver.rootField },
    selectionSet,
  });

  if (resolver.batch) {
    return [
      field(
        {
          kind: Kind.LIST,
          values: idList.map((id) => idToValueNode(resolver, id)),
        },
        idList,
      ),
    ];
  }

  return idList.map((id) => field(idToValueNode(resolver, id), [id]));
}
