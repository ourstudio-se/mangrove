# Mangrove

![Thanks, Dall-E, very cool](./assets/treeoflife2.jpg)

Mangrove is a POC of an adaptive entity tree cache for GraphQL and Javascript. It allows you to invalidate individual type+id combinations (called Entities), and intelligently remodels your clients queries to only request data that has become stale, in the most efficient way possible.

## Why Mangrove?
Let's say we have a simple schema that can return a list of "Items". Each item has an animal name associated to it via the `data` field. This field is quite costly to resolve - each resolution takes 500ms - so naturally, we want to avoid triggering this resolution as much as possible.

```typescript
const items = [{ id: "1" }, { id: "2" }];

const schema = makeExecutableSchema({
  resolvers: {
    Item: {
      data: () => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              uniqueNamesGenerator({
                dictionaries: [animals],
                style: "capital",
              }),
            );
          }, 500);
        });
      },
    },
    Query: {
      item: (_: any, { id }: { id: string }) => {
        return items.find((item) => item.id === id);
      },
	  items: () => items,
    },
  },
  typeDefs: gql`
    schema {
      query: Query
    }

    type Query {
      items: [Item!]!
      item(id: ID!): Item 
    }

    type Item {
      id: ID!
      data: String!
    }
  `,
});
```

For demonstration purposes, let's let `data` always resolve to a unique animal name using our `uniqueNamesGenerator`. This will be useful for tracking whether or not the resolver has run again.

### Executing a simple query
Let's run a simple query against this schema:

```graphql
query BigItemQuery {
  items {
	id
	data
  }
}
```

As expected, every time we execute this query, we receive new animal names for the field `data` for both of our items. Because this field is costly to resolve, we also experience a bit of lag.

```jsonc
/* T1 */ [
  { "id": "1", "data": "Rattlesnake" }, 
  { "id": "2", "data": "Crayfish" }
]
/* T2 */ [ 
  { "id": "1", "data": "Viper" },
  { "id": "2", "data": "Magpie" }
]
/* T3 */ [ 
  { "id": "1", "data": "Jaguar" }, 
  { "id": "2", "data": "Manatee" } 
]
```
| | | |
|:-------------------------:|:-------------------------:|:-------------------------:|
|T1|![Rattlesnake](./assets/rattlesnake.jpg)<br>ID=1 |![Crayfish](./assets/crayfish.jpg)<br>ID=2|
|T2|![Viper](./assets/viper.jpg)<br>ID=1 |![Magpie](./assets/magpie.jpg)<br>ID=2|
|T3|![Jaguar](./assets/jaguar.jpg)<br>ID=1 |![Manatee](./assets/manatee.jpg)<br>ID=2|

### Response caching
Using Mangrove, the first execution goes exactly as before. Our query is a bit slow, because everything has to be resolved at least once. 

```jsonc
/* T1 */ [ { "id": "1", "data": "Whale" }, { "id": "2", "data": "Guanaco" } ]
```

| | | |
|:-------------------------:|:-------------------------:|:-------------------------:|
|T1|![Whale](./assets/whale.jpg)<br>ID=1 |![Guanaco](./assets/guanaco.jpg)<br>ID=2|

But once the first execution has happened, subsequent resolutions keep returning the same answer. This is because our response has been cached.

```jsonc
/* T2 */ [ { "id": "1", "data": "Whale" }, { "id": "2", "data": "Guanaco" } ]
```
| | | |
|:-------------------------:|:-------------------------:|:-------------------------:|
|T2|![Whale](./assets/whale.jpg)<br>ID=1 |![Guanaco](./assets/guanaco.jpg)<br>ID=2|

### Adaptive entity invalidations
That's pretty neat, but so far not at all different from a normal GraphQL Response cache. What sets Mangrove apart is what happens when we invalidate one of the entities included in the response.

> Mangrove comes with a set of adaptive `invalidationStrategies`. These are abstracted patterns on top of the cache implementation that lets us navigate invalidating and adapting to changes in different ways. The standard invalidation strategy in Mangrove is called `lazyInvalidationStrategy`. It's called that because it keeps the adaptive logic of Mangrove as part of the GraphQL execution, rather than as part of the invalidation process. Doing so is slightly less performant in execution time, but allows cache invalidations to happen based on the logic of some external service - for instance by letting keys expire in a redis store.

Let's say we want to invalidate our friend the whale (i.e. the `Item` with id `"1"`). To do so, we can either use tools supplied by Mangrove, or simply delete the corresponding key in our cache. Using a redis cache, this could be done by running:

```
DEL Item:1
```

Now, when running the same query again, we get a new answer:

```jsonc
/* T3 */ [ { "id": "1", "data": "Tortoise" }, { "id": "2", "data": "Guanaco" } ]
```
| | | |
|:-------------------------:|:-------------------------:|:-------------------------:|
|T3|![Tortoise](./assets/tortoise.jpg)<br>ID=1 |![Guanaco](./assets/guanaco.jpg)<br>ID=2|

We can see that the whale has turned into a tortoise, while the guanaco remains cached!

### Linking
This is cool and all, but what if we want to invalidate the query itself? Surely at some point, a new Item might be added, and then we would need to get all of that data again, right?

Not at all! By using some clever tricks, Mangrove can optimize out the need to call the data field for already-cached members of the list.

Let's first add a new item to our list of items.

```typescript
items.push({
  id: "3"
})
```

Then, let's invalidate our "Query" entity:

```
DEL Query
```

Re-executing our query, we can see that the `data` field has ONLY been resolved for the new item:

```jsonc
/* T4 */ [
  { "id": "1", "data": "Tortoise" },
  { "id": "2", "data": "Guanaco" },
  { "id": "3", "data": "Goose" }
]
```

| | | | |
|:-------------------------:|:-------------------------:|:-------------------------:|:-------------------------:|
|T4|![Tortoise](./assets/tortoise.jpg)<br>ID=1 |![Guanaco](./assets/guanaco.jpg)<br>ID=2|![Goose](./assets/goose.jpg)<br>ID=3|

Brilliant. Let's quickly shuffle our items around and invalidate again.

```typescript
items.push(items.shift()!)
```

```
DEL Query
```

And, when executing, we now get:

```jsonc
/* T5 */ [
  { "id": "2", "data": "Guanaco" },
  { "id": "3", "data": "Goose" },
  { "id": "1", "data": "Tortoise" }
]
```
| | | | |
|:-------------------------:|:-------------------------:|:-------------------------:|:-------------------------:|
|T5|![Guanaco](./assets/guanaco.jpg)<br>ID=2|![Goose](./assets/goose.jpg)<br>ID=3|![Tortoise](./assets/tortoise.jpg)<br>ID=1 |

It just works! No need for the data field resolver to run at all. 

## But *how* does it work?

Simply put, Mangrove is a simple response cache in that it never caches anything but an entire GraphQL response, atomically. This means that any change to our query whatsoever (at least one that results in a modified cache key) will put us in an entirely different cache case. Mangrove does not interfere on the schema level, it does not wrap resolvers, it does not individually cache field results.

What Mangrove *does*, is rewrite your GraphQL query based on the state of the cache. In its simplest form, this means that a simple query document like this can be pruned to only include branches that lead to an entity that has been invalidated (in this case, that entity is Tortoise:1)

*Original query*
```graphql
query MyQuery {
  guanaco {
    whale {
      data
    }
    tortoise {
      data
    }
    goose {
      data
    }
    data
  }
}
```

*Rewritten query*
```graphql
query MyQuery {
  guanaco {
    tortoise {
      data
    }
  }
}
```

### Taking shortcuts

We can also teach Mangrove to take shortcuts through the schema, and thus skip out on ever resolving the field `guanaco` in our example. By adding a so called "cache resolver" for our `Tortoise` entity, either in manual configuration, or through schema directives, our schema gets rewritten to the following instead:

```graphql
query MyQuery {
  __ENTITY_guanaco_tortoise_0: tortoise(id: "1") {
    data
  }
}
```

Note the alias of the `tortoise` query field - this tells Mangrove's result processor where to merge the data back in to the cached result. Mangrove will look for all places at that coordinate in the existing data where there exists a `Tortoise` with the ID `1`, and replace them with the result of this query.

### Breaking the tree apart

Mangrove looks at the last store execution result of the query and analyzes it in order to create an entity tree. An entity, from the perspective of Mangrove, is simply an object with an ID, that can be individually invalidated. By making this determination, we can also consider each coordinate where an entity exists a "link point". This means that Mangrove presumes that any data beyond that point would have been explicitly invalidated if it had changed, and we can safely prune it away if its not required for us to get to some data further along the branch that *has* been invalidated.

Starting from the leaves, Mangrove breaks the original client document AST into segments, where each segment is connected to a specific Entity resolver (note that this does not mean that there is necessarily only one type of entity per segment - entities do not necessarily have resolvers). It then (again, starting from the leaves) prunes fields on all selection sets included in that segment that are not required to reach an entity within that segment that has been invalidated. When it encounters a node with a coordinate that has an associated resolver, it breaks off a new segment by mapping the entire node (and all subnodes) to a separate root field on the query operation, and replacing it in the existing AST with a so called "link" node only requesting the typename and ID of the entity. Finally, it stores the selection set of the node in a separate map that it uses to create subsequent link queries, see below.

### Cache resolutions vs Linking

Cache resolution and linking are two related, but somewhat different concepts in Mangrove. 

Cache resolution simply means employing a shortcut to reach a segment of the original AST. It is the means by which we prevent the query from requesting data *closer to the root of the AST* than the fields that we know we are interested in.

Linking has the opposite purpose, it allows us to prevent the query from requesting data *closer to the leaves of the AST* than we are interested in. Of course, this requires some amount of future sight. If we invalidate a Tortoise that is connected to a Goose through its `goose` field, we can't really know whether or not we need to also load the entire selection set of the goose field, because we can't be sure that it is the same goose.

The way Mangrove solves this is by doing a layered cache resolution, where each segment in the processed AST potentially can lead to a pass of execution against the schema. The layered cache executor runs the partial query generated by Mangrove and executes it, then looks through the response data for any instances of link nodes - the ID/typename seletions left when severing a segment off from the main AST when generating the partial query. If we encounter any instances of a specific type where the ID is not known to us since earlier, we can deduce that we need to load this data in the next pass of execution. Looking at the results of that execution, we then do the same thing again, and so on, until we've reached the leaves of the original document AST.

## Usage

### On the server
To use Mangrove with GraphQL Yoga or another Envelop-compatible server, install this package and import the included `useMangrove()` plugin. You will also need to import and instantiate a cache and an invalidationStrategy.

```typescript
const client = new Redis();

const cache = createRedisCache({ client });

const strategy = lazyInvalidationStrategy({ cache });

const yoga = createYoga({
	plugins: [
		useMangrove({
			invalidationStrategy: strategy,
			ttl: 5 * 60 * 1000,
			session: (ctx) => ctx.user,
			idFields: ["id"],
		})
	]
})
```

To programatically invalidate something we can then use `strategy.invalidateEntities`:

```typescript
await strategy.invalidateEntities([
	{
		id: "1",
		typename: "Item"	
	}
])
```

### On the client
Mangrove has no runtime dependencies of the GraphQL schema, so it might just as easily be run on the client, in a gateway, or wherever it fits.

#### Using executors from graphql-tools

We can wrap any executor in a mangrove cache using the exported `makeExecutorWrapper` utility.

```typescript
const cacheResolvers: CacheResolverMap = {
  Launch: {
    batch: false,
    idArg: "id",
    rootField: "launch",
    type: "string",
  },
  Rocket: {
    batch: false,
    idArg: "id",
    rootField: "rocket",
    type: "string",
  },
};

const { getPartialExecutionOpts, invalidateEntities, storeExecutionResult } =
  lazyInvalidationStrategy({
    cache: createRedisCache({ client: new Redis() }),
  });

const processResult = makeResultProcessor({
  storeExecutionResult,
  ttl,
});

const wrapExecutor = makeExecutorWrapper({
  cacheResolvers,
  getPartialExecutionOpts,
  processResult,
  session: () => null,
});

const executor = pipe(
  buildHTTPExecutor({
    endpoint: "https://spacex-production.up.railway.app/",
  }),
  wrapExecutor,
);
```

Any query executed with the resulting executor should be passed through the `parseClientQuery` utility. The `@idField` directive can be used to teach Mangrove to use a specific field as the ID field of an entity object.

```typescript
const document = parseClientQuery(
  parse(gql`
    fragment Launch on Launch {
      id @idField
      details
      is_tentative
      launch_date_local
      launch_date_unix
      launch_date_utc
      launch_success
      rocket {
        rocket {
          id @idField
          active
          boosters
          company
          cost_per_launch
          country
          description
          first_flight
          name
          stages
          success_rate_pct
          type
          wikipedia
        }
      }
      mission_id
      mission_name
      static_fire_date_unix
      static_fire_date_utc
      tentative_max_precision
      upcoming
    }
  `),
);

const result = await executor({ document });
```

#### Using some other framework/library

Mangrove can embed any pattern for execution, given that the embedded pattern can supply Mangrove with some basic execution context. 

To setup our execution, we must bind our execution interface into a simple function takes the query document as its only argument and returns a promise of an ExecutionResult. We can achieve this through some clever currying. See below example of how this method is implemented for executors:

```typescript
function bindExecutor(executor: Executor): BindExecutorRequest {
  return (request) => {
    return (document) => {
      const resultOrPromise = executor({ ...request, document });

      if (isPromise(resultOrPromise)) {
        return resultOrPromise.then(ensureNonIterableResult);
      }

      return ensureNonIterableResult(resultOrPromise);
    };
  };
}

function getArgsFromExecutorRequest(
  request: ExecutionRequest,
): ExecuteQueryArgs {
  return {
    context: request.context,
    document: request.document,
    operationName: request.operationName,
    variables: request.variables,
  };
}

export function makeExecutorWrapper(parameter: MakeExecuteParameter) {
  const runQuery = makeQueryRunner(parameter);
  function wrapExecutor(executor: Executor): Executor {
    const bindExecuteQuery = bindExecutor(executor);

    return async function executor<TReturn>(request: ExecutionRequest) {
      const executeQuery = bindExecuteQuery(request);
      return runQuery(
        executeQuery,
        getArgsFromExecutorRequest(request),
      ) as TReturn;
    };
  }

  return wrapExecutor;
}
```

### Configuration
#### Cache resolvers
In order for our example above to work as expected, we need to tell Mangrove to use a shortcut to get the `Item` entity. This is called a "cache resolver".

Setting up a cache resolver can either be done by using the included `@cacheResolver` directive in your schema, or by manually specifying it in the `useMangrove()` constructor:

```graphql
directive @cacheResolver on FIELD_DEFINITION

type Query {
  ...
  item(id: ID!): Item @cacheResolver
}
```

is equal to:

```typescript
useMangrove({
  ...
  cacheResolvers: {
    Item: {
      batch: false,
      idArg: "id",
      rootField: "item",
      type: "string" 
    }
  }
})
```

### Entity TTLs
To configure per-entity TTLs, first make sure that your cache supports it. It can be enabled/disabled in the builtin cache by using the `allowDistinctMemberTTLs`  parameter:

```typescript
const cache = createRedisCache({ allowDistinctMemberTTLs: false }); // Enabled by default
```

Then, either use the builtin `@cacheEntity` directive, or pass an `entityTtls` parameter to the plugin opts:

```graphql
type Item @cacheEntity(ttl: 300000) {
  ...
}
```

is equal to:

```typescript
useMangrove({
  entityTtls: {
    Item: 300_000
  }
})
```

## Maintainer
- Max Bolotin max@ourstudio.se

## License
MIT
