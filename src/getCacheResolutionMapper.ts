import { CacheResolver, Id } from "./typings";
import { FieldNode, Kind, SelectionSetNode, parseValue } from "graphql";
import { getCacheResolverAlias } from "./alias";
import { memoize1 } from "./borrowedTools/memoize";

export const getCacheResolutionMapper = memoize1(
  function getCacheResolutionMapper(resolver: CacheResolver) {
    function mapSingleCacheResolution(
      id: string | number,
      coordinates: string,
      selectionSet: SelectionSetNode,
      index: number,
    ): FieldNode {
      return {
        alias: {
          kind: Kind.NAME,
          value: getCacheResolverAlias(coordinates, index),
        },
        arguments: [
          {
            kind: Kind.ARGUMENT,
            name: {
              kind: Kind.NAME,
              value: resolver.idArg,
            },
            value: parseValue(resolver.type === "string" ? `"${id}"` : `${id}`),
          },
        ],
        kind: Kind.FIELD,
        name: {
          kind: Kind.NAME,
          value: resolver.rootField,
        },
        selectionSet,
      };
    }

    function mapBatchCacheResolution(
      ids: readonly Id[],
      coordinates: string,
      selectionSet: SelectionSetNode,
    ): FieldNode {
      return {
        alias: {
          kind: Kind.NAME,
          value: getCacheResolverAlias(coordinates),
        },
        arguments: [
          {
            kind: Kind.ARGUMENT,
            name: {
              kind: Kind.NAME,
              value: resolver.idArg,
            },
            value: {
              kind: Kind.LIST,
              values: ids.map((id) =>
                parseValue(resolver.type === "string" ? `"${id}"` : `${id}`),
              ),
            },
          },
        ],
        kind: Kind.FIELD,
        name: {
          kind: Kind.NAME,
          value: resolver.rootField,
        },
        selectionSet,
      };
    }

    return function mapCacheResolution(
      ids: readonly Id[],
      coordinates: string,
      selectionSet: SelectionSetNode,
    ) {
      switch (resolver.batch) {
        case true:
          return [mapBatchCacheResolution(ids, coordinates, selectionSet)];
        case false:
        default:
          return ids.map((id, index) =>
            mapSingleCacheResolution(id, coordinates, selectionSet, index),
          );
      }
    };
  },
);
