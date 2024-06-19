import {
  CacheResolverMap,
  ConfigureFromSchema,
  MakeBySchemaConfigGeneratorParameter,
} from "./typings.js";
import {
  DIRECTIVE_NAME_CACHEENTITY,
  DIRECTIVE_NAME_CACHERESOLVER,
} from "./constants.js";
import {
  GraphQLFieldConfig,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLType,
  getNamedType,
  isListType,
  isNonNullType,
  isObjectType,
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
  const cacheEntityAnnotations = getDirective(
    schema,
    type,
    DIRECTIVE_NAME_CACHEENTITY,
  );

  if (!cacheEntityAnnotations || cacheEntityAnnotations.length === 0) {
    return {};
  }

  const annotation = cacheEntityAnnotations[0];

  return {
    [type.name]: annotation.ttl,
  };
}

function cacheResolverFromQueryRootField(
  fieldConfig: GraphQLFieldConfig<unknown, unknown>,
  fieldName: string,
  schema: GraphQLSchema,
): CacheResolverMap {
  const cacheResolverAnnotations = getDirective(
    schema,
    fieldConfig,
    DIRECTIVE_NAME_CACHERESOLVER,
  );

  if (!cacheResolverAnnotations || cacheResolverAnnotations.length === 0) {
    return {};
  }

  const args = fieldConfig.args;

  if (!args) {
    return {};
  }

  const annotation = cacheResolverAnnotations[0];

  let keyArgName: string | undefined = undefined;

  const argKeys = Object.keys(args);

  if (annotation.keyArg && argKeys.includes(annotation.keyArg)) {
    keyArgName = annotation.keyArg;
  } else if (argKeys.length === 1) {
    keyArgName = argKeys[0];
  }

  if (!keyArgName) {
    return {};
  }

  const keyArg = args[keyArgName];

  const fieldTypeIsBatch = isBatchType(fieldConfig.type);
  const argTypeIsBatch = isBatchType(keyArg.type);

  const batch = fieldTypeIsBatch && argTypeIsBatch;

  const namedType = getNamedType(fieldConfig.type);

  if (!isObjectType(namedType)) {
    return {};
  }

  let type: "string" | "int" | undefined;

  switch (getNamedType(keyArg.type)) {
    case GraphQLInt:
      type = "int";
      break;
    case GraphQLString:
    default:
      type = "string";
      break;
  }

  if (!type) {
    return {};
  }

  return {
    [namedType.name]: {
      batch,
      idArg: keyArgName,
      rootField: fieldName,
      type,
    },
  };
}

export function makeBySchemaConfigGenerator({
  idFields,
}: MakeBySchemaConfigGeneratorParameter): ConfigureFromSchema {
  return (schema: GraphQLSchema) => {
    const cacheResolverDirective = schema.getDirective(
      DIRECTIVE_NAME_CACHERESOLVER,
    );
    const cacheEntityDirective = schema.getDirective(
      DIRECTIVE_NAME_CACHEENTITY,
    );

    let entityTtls: Record<string, number> = {};
    let cacheResolvers: CacheResolverMap = {};
    const idFieldByTypeName = new Map<string, string>();

    const typeMap = schema.getTypeMap();

    for (const typename of Object.keys(typeMap)) {
      const type = typeMap[typename];

      if (!isObjectType(type)) {
        continue;
      }

      if (cacheEntityDirective) {
        entityTtls = {
          ...entityTtls,
          ...entityTtlFromObjectType(type, schema),
        };
      }

      const fieldMap = type.getFields();

      for (const fieldname of Object.keys(fieldMap)) {
        if (idFields.has(fieldname) && !idFieldByTypeName.has(typename)) {
          idFieldByTypeName.set(typename, fieldname);
        }
      }
    }

    if (cacheResolverDirective) {
      const queryFieldMap = schema.getQueryType()?.toConfig().fields ?? {};

      for (const fieldname of Object.keys(queryFieldMap)) {
        const fieldConfig = queryFieldMap[fieldname];
        cacheResolvers = {
          ...cacheResolvers,
          ...cacheResolverFromQueryRootField(fieldConfig, fieldname, schema),
        };
      }
    }

    return {
      cacheResolvers,
      entityTtls,
      idFieldByTypeName,
      parser: getParserFromSchema(schema, idFieldByTypeName),
    };
  };
}
