import {
  DIRECTIVE_NAME_CACHEENTITY,
  DIRECTIVE_NAME_CACHERESOLVER,
} from "./constants";
import {
  DirectiveLocation,
  GraphQLDirective,
  GraphQLInt,
  GraphQLString,
} from "graphql";

export const CacheResolverDirective = new GraphQLDirective({
  args: {
    keyArg: {
      type: GraphQLString,
    },
  },
  locations: [DirectiveLocation.FIELD],
  name: DIRECTIVE_NAME_CACHERESOLVER,
});

export const CacheEntityDirective = new GraphQLDirective({
  args: {
    ttl: {
      type: GraphQLInt,
    },
  },
  locations: [DirectiveLocation.OBJECT],
  name: DIRECTIVE_NAME_CACHEENTITY,
});
