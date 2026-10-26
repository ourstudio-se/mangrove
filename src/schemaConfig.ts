import {
  CacheResolver,
  CacheResolverMap,
  ConfigureFromSchema,
  Logger,
  MakeBySchemaConfigGeneratorParameter,
} from "./typings.js";
import {
  DIRECTIVE_NAME_CACHEENTITY,
  DIRECTIVE_NAME_CACHERESOLVER,
} from "./constants.js";
import {
  GraphQLField,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLType,
  getNamedType,
  getNullableType,
  isAbstractType,
  isLeafType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isUnionType,
} from "graphql";
import { getDirective } from "@graphql-tools/utils";
import { getParserFromSchema } from "./parser.js";

function isBatchType(type: GraphQLType) {
  while (isNonNullType(type)) {
    type = type.ofType;
  }

  return isListType(type);
}

function entityTtlFromObjectType(
  type: GraphQLObjectType,
  schema: GraphQLSchema,
): Record<string, number> {
  const annotation = getDirective(
    schema,
    type,
    DIRECTIVE_NAME_CACHEENTITY,
  )?.[0];

  if (typeof annotation?.ttl !== "number") {
    return {};
  }

  return {
    [type.name]: annotation.ttl,
  };
}

function keyTypeOf(type: GraphQLType): CacheResolver["type"] | undefined {
  switch (getNamedType(type)) {
    case GraphQLInt:
      return "int";
    case GraphQLFloat:
      return "float";
    case GraphQLString:
    case GraphQLID:
      return "string";
    default:
      return undefined;
  }
}

function cacheResolversFromQueryRootField(
  field: GraphQLField<unknown, unknown>,
  schema: GraphQLSchema,
  logger: Logger,
): CacheResolverMap {
  const annotation = getDirective(
    schema,
    field,
    DIRECTIVE_NAME_CACHERESOLVER,
  )?.[0];

  if (!annotation) {
    return {};
  }

  const skip = (reason: string) => {
    logger.warn(
      `[Mangrove] Ignoring @${DIRECTIVE_NAME_CACHERESOLVER} on Query.${field.name}: ${reason}`,
    );
    return {};
  };

  let keyArg = field.args.find((arg) => arg.name === annotation.keyArg);

  if (annotation.keyArg !== undefined && annotation.keyArg !== null) {
    if (!keyArg) {
      return skip(`argument "${annotation.keyArg}" does not exist`);
    }
  } else {
    const required = field.args.filter(
      (arg) => isNonNullType(arg.type) && arg.defaultValue === undefined,
    );
    if (field.args.length === 1) {
      keyArg = field.args[0];
    } else if (required.length === 1) {
      keyArg = required[0];
    } else {
      return skip(
        "the field must have exactly one (required) argument, or specify keyArg",
      );
    }
  }

  const otherRequiredArg = field.args.find(
    (arg) =>
      arg !== keyArg &&
      isNonNullType(arg.type) &&
      arg.defaultValue === undefined,
  );

  if (otherRequiredArg) {
    return skip(`argument "${otherRequiredArg.name}" is also required`);
  }

  const type = keyTypeOf(keyArg!.type);

  if (!type) {
    return skip(
      `key argument type ${getNamedType(keyArg!.type).name} is not supported (use ID, String, Int or Float)`,
    );
  }

  const batch = isBatchType(field.type) && isBatchType(keyArg!.type);

  const resolver: CacheResolver = {
    batch,
    idArg: keyArg!.name,
    rootField: field.name,
    type,
  };

  const namedType = getNamedType(field.type);

  if (isObjectType(namedType)) {
    return { [namedType.name]: resolver };
  }

  if (isAbstractType(namedType)) {
    // e.g. `node(id: ID!): Node`: resolves every possible type.
    return Object.fromEntries(
      schema.getPossibleTypes(namedType).map((type) => [type.name, resolver]),
    );
  }

  return skip("the field must return an object, interface or union type");
}

/**
 * Adds the type conditions that apply to each resolver's type (its
 * interfaces and the unions it is a member of), leaving resolvers that
 * already declare them alone.
 */
export function withTypeConditions(
  schema: GraphQLSchema,
  resolvers: CacheResolverMap,
): CacheResolverMap {
  const unions = Object.values(schema.getTypeMap()).filter(isUnionType);

  return Object.fromEntries(
    Object.entries(resolvers).map(([typename, resolver]) => {
      const type = schema.getType(typename);
      if (resolver.typeConditions || !isObjectType(type)) {
        return [typename, resolver];
      }
      const typeConditions = [
        ...type.getInterfaces().map((iface) => iface.name),
        ...unions
          .filter((union) => union.getTypes().includes(type))
          .map((union) => union.name),
      ];
      return [typename, { ...resolver, typeConditions }];
    }),
  );
}

export function makeBySchemaConfigGenerator({
  idFields,
  logger = console,
}: MakeBySchemaConfigGeneratorParameter): ConfigureFromSchema {
  return (schema: GraphQLSchema) => {
    const cacheResolverDirective = schema.getDirective(
      DIRECTIVE_NAME_CACHERESOLVER,
    );
    const cacheEntityDirective = schema.getDirective(
      DIRECTIVE_NAME_CACHEENTITY,
    );

    const entityTtls: Record<string, number> = {};
    const idFieldByTypeName = new Map<string, string>();

    const typeMap = schema.getTypeMap();

    for (const typename of Object.keys(typeMap)) {
      const type = typeMap[typename];

      if (typename.startsWith("__")) {
        continue;
      }

      if (!isObjectType(type) && !isInterfaceType(type)) {
        continue;
      }

      if (cacheEntityDirective && isObjectType(type)) {
        Object.assign(entityTtls, entityTtlFromObjectType(type, schema));
      }

      const fieldMap = type.getFields();

      for (const idField of idFields) {
        const field = fieldMap[idField];
        // Ids must be plain scalars that can be selected without arguments.
        if (
          field &&
          isLeafType(getNullableType(field.type)) &&
          field.args.every(
            (arg) => !isNonNullType(arg.type) || arg.defaultValue !== undefined,
          )
        ) {
          idFieldByTypeName.set(typename, idField);
          break;
        }
      }
    }

    const abstractResolvers: CacheResolverMap = {};
    const objectResolvers: CacheResolverMap = {};

    if (cacheResolverDirective) {
      const queryFields = schema.getQueryType()?.getFields() ?? {};

      for (const fieldname of Object.keys(queryFields)) {
        const field = queryFields[fieldname];
        const target = isObjectType(getNamedType(field.type))
          ? objectResolvers
          : abstractResolvers;
        Object.assign(
          target,
          cacheResolversFromQueryRootField(field, schema, logger),
        );
      }
    }

    return {
      // Resolvers declared for a concrete type take precedence.
      cacheResolvers: withTypeConditions(schema, {
        ...abstractResolvers,
        ...objectResolvers,
      }),
      entityTtls,
      idFieldByTypeName,
      parser: getParserFromSchema(schema, idFieldByTypeName),
    };
  };
}
