import { CacheResolver, Id } from "./typings.js";
import {
  FieldNode,
  Kind,
  SelectionSetNode,
  ValueNode,
  parseValue,
} from "graphql";
import { getCacheResolverAlias } from "./alias.js";
import { memoize1 } from "./borrowedTools/memoize.js";

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
      ids: Iterable<Id>,
      coordinates: string,
      selectionSet: SelectionSetNode,
    ): FieldNode {
      const idValues: ValueNode[] = [];

      for (const id of ids) {
        idValues.push(
          parseValue(resolver.type === "string" ? `"${id}"` : `${id}`),
        );
      }

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
              values: idValues,
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
      ids: Iterable<Id>,
      coordinates: string,
      selectionSet: SelectionSetNode,
    ) {
      switch (resolver.batch) {
        case true:
          return [mapBatchCacheResolution(ids, coordinates, selectionSet)];
        case false:
        default: {
          const resolutions: FieldNode[] = [];

          for (const id of ids) {
            resolutions.push(
              mapSingleCacheResolution(
                id,
                coordinates,
                selectionSet,
                resolutions.length,
              ),
            );
          }

          return resolutions;
        }
      }
    };
  },
);
