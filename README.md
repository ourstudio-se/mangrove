# Mangrove

![Thanks, Dall-E, very cool](./assets/treeoflife2.jpg)

Mangrove is a POC of an adaptive entity tree cache for GraphQL and Javascript. It allows you to invalidate individual type+id combinations (called Entities), and intelligently remodels your clients queries to only request data that has become stale, in the most efficient way possible.

## Installation

```bash
$ npm install mangrove-graphql
```

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

> Invalidation is handled by an invalidation strategy on top of the cache. Mangrove's strategy is called `lazyInvalidationStrategy`, because it keeps the adaptive logic as part of the GraphQL execution rather than the invalidation: invalidating an entity is cheap, and each request works out what it needs to refetch. This also lets invalidations come from outside, for instance by letting keys expire in a Redis store.

Let's say we want to invalidate our friend the whale (i.e. the `Item` with id `"1"`):

```typescript
await strategy.invalidateEntities([{ typename: "Item", id: "1" }]);
```

In a pinch, deleting the entity's key directly in Redis (`DEL Item:1`) has the same effect on subsequent requests, but `invalidateEntities` should be preferred: it also protects against requests that were already running when the data changed (see [Consistency](#consistency)).

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
  _ENTITY_guanaco__tortoise_i0: tortoise(id: "1") {
    data
  }
}
```

Note the alias of the `tortoise` query field - it encodes the coordinates (`guanaco.tortoise`) the result belongs to, which tells Mangrove's result processor where to merge the data back in to the cached result. Mangrove will look for all places at that coordinate in the existing data where there exists a `Tortoise` with the ID `1`, and merge the result of this query into them.

Cache resolvers also work for entities deeper down: if a `Goose` reached through the tortoise is invalidated, and `Goose` has no cache resolver of its own, the tortoise is re-resolved through its shortcut with a selection set narrowed down to the path leading to the goose.

### Breaking the tree apart

Mangrove looks at the last store execution result of the query and analyzes it in order to create an entity tree. An entity, from the perspective of Mangrove, is simply an object with an ID, that can be individually invalidated. By making this determination, we can also consider each coordinate where an entity exists a "link point". This means that Mangrove presumes that any data beyond that point would have been explicitly invalidated if it had changed, and we can safely prune it away if its not required for us to get to some data further along the branch that *has* been invalidated.

Starting from the leaves, Mangrove breaks the original client document AST into segments, where each segment is connected to a specific Entity resolver (note that this does not mean that there is necessarily only one type of entity per segment - entities do not necessarily have resolvers). It then (again, starting from the leaves) prunes fields on all selection sets included in that segment that are not required to reach an entity within that segment that has been invalidated. When it encounters a node with a coordinate that has an associated resolver, it breaks off a new segment by mapping the entire node (and all subnodes) to a separate root field on the query operation, and replacing it in the existing AST with a so called "link" node only requesting the typename and ID of the entity. Finally, it stores the selection set of the node in a separate map that it uses to create subsequent link queries, see below.

### Cache resolutions vs Linking

Cache resolution and linking are two related, but somewhat different concepts in Mangrove. 

Cache resolution simply means employing a shortcut to reach a segment of the original AST. It is the means by which we prevent the query from requesting data *closer to the root of the AST* than the fields that we know we are interested in.

Linking has the opposite purpose, it allows us to prevent the query from requesting data *closer to the leaves of the AST* than we are interested in. Of course, this requires some amount of future sight. If we invalidate a Tortoise that is connected to a Goose through its `goose` field, we can't really know whether or not we need to also load the entire selection set of the goose field, because we can't be sure that it is the same goose.

The way Mangrove solves this is by doing a layered cache resolution, where each segment in the processed AST potentially can lead to a pass of execution against the schema. The layered cache executor runs the partial query generated by Mangrove and executes it, then looks through the response data for any instances of link nodes - the ID/typename seletions left when severing a segment off from the main AST when generating the partial query. If we encounter an entity that the cached result doesn't hold at that same position in the document, we can deduce that we need to load this data in the next pass of execution; entities that it does hold are filled in from the cache. Looking at the results of that execution, we then do the same thing again, and so on, until we've reached the leaves of the original document AST.

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
			// Partitions the cache: results are only shared between requests
			// with the same session id. `null` means "shared by everyone".
			session: (ctx) => ctx.userId ?? null,
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

Any query executed with the resulting executor should be passed through the `parseClientQuery` utility. The `@idField` directive can be used to teach Mangrove to use a specific field as the ID field of an entity object. Without a schema, `parseClientQuery` can't tell the types of id fields apart: if members of a union or implementations of an interface have id fields of different types (e.g. `ID!` and `ID`), mark only one of them with `@idField`, or use `getParserFromSchema` with the server's schema.

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

Mangrove can embed any pattern for execution, given that it can supply Mangrove with some basic execution context. `makeQueryRunner` returns a function taking two arguments: a `RunQuery` function that executes a given document (Mangrove calls it for the partial query and for every round of link queries), and the request's `RunQueryArgs`:

```typescript
const runQuery = makeQueryRunner({
  cacheResolvers,
  getPartialExecutionOpts,
  processResult,
  session,
});

const result = await runQuery(
  (document, operationName) =>
    myClient.execute({ document, operationName, variables }),
  { context, document, operationName, variables },
);
```

`makeExecuteWrapper` (for `graphql-js` `execute`) and `makeExecutorWrapper` (for `graphql-tools` executors) are thin wrappers around this.

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
Every entity of a type can be given a shorter time to live than the result it is part of. When it runs out, only that entity is refetched. This needs a cache that supports per-member expiry, which the Redis cache does unless `allowDistinctMemberTTLs` is turned off.

Either use the builtin `@cacheEntity` directive, or pass an `entityTtls` parameter to the plugin opts:

```graphql
directive @cacheEntity(ttl: Int) on OBJECT

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

### Caches

```typescript
const cache = createRedisCache({
  client: new Redis(),
  // Prefix for every key written by Mangrove.
  keyPrefix: "mangrove:",
  // How long invalidations are remembered, to reject results of requests that
  // started before them. Must exceed your longest request. Default: 10 minutes.
  invalidationWindow: 10 * 60 * 1000,
  // Optional compression of stored results.
  compression: (data) => deflate(data),
  decompression: (data) => inflate(data),
});
```

`createMemoryCache()` has the same semantics, in process memory. It's useful for tests and single process deployments.

The Redis cache uses Lua scripts that touch several keys at once, so it doesn't support Redis Cluster. Expiry times are computed from the application servers' clocks, so keep them in sync with each other.

Internal keys start with `:` (after the `keyPrefix`), which no GraphQL type name can start with, so they never collide with entity keys such as `Item:1`.

### Invalidation

```typescript
// A single entity
await strategy.invalidateEntities([{ typename: "Item", id: "1" }]);
// Every entity of a type (and the type itself)
await strategy.invalidateEntities([{ typename: "Item" }]);
// The root of every query, e.g. when a root list changes
await strategy.invalidateEntities([{ typename: "Query" }]);
```

Invalidate an entity whenever one of its fields changes, including fields that refer to other entities or lists of them. Changes to fields of the root `Query` type invalidate `Query`.

## Consistency

Mangrove assumes that every change is announced by invalidating the entity whose fields changed, after the change has been committed. Under that assumption, a result served by Mangrove reflects every invalidation that completed before the request started (provided requests take less than `invalidationWindow`), and no part of it is older than `ttl`. In more detail:

- **Invalidations during a request.** Every invalidation bumps an epoch. A request reads the epoch before it reads anything else, and when it stores its result it doesn't mark any entity as valid that has been invalidated since. The next request refetches it.
- **Concurrent requests.** A request never overwrites a result stored by a request that started after it.
- **Versioned results.** Entity sets vouch for a specific stored version of a result. A request that keeps cached data for an entity can only carry that entity's validity over from the version it read, if it is still valid, and never beyond its original expiry. Expiring entities, keys deleted directly, and concurrent writers therefore can't make stale data look valid.
- **Expiry.** A result keeps the expiry it was first stored with, even when parts of it are refreshed, so `ttl` bounds how old any part of a result can be. Cache hits never write to the cache.
- **When in doubt, execute.** If a partial execution returns errors, a cache resolver doesn't return every entity it was asked for, a link can't be resolved, or the cached data turns out to be inconsistent with the fresh data, Mangrove executes the original query instead. Errors are therefore always reported against the client's query.
- **Entity TTLs.** Refreshing part of a result never extends how long the entities that weren't refetched are considered valid.

### Caveats

- **Cache resolvers bypass parent resolvers.** An entity reached through a cache resolver (e.g. `item(id:)`) is fetched without going through the path in the original query. Any authorization or filtering done by parent resolvers on that path is skipped; make sure cache resolvers apply the same rules.
- **Only queries are cached.** Mutations and subscriptions are executed as usual. Documents that contain a mutation or subscription are not decorated at all.
- **Sessions.** Anything that changes the result of a query besides its document and variables (the user, their roles, the locale, ...) must be part of the session id.

## Performance

`scripts/bench.mjs` runs a query for 200 items (each with an owner and three tags, with cache resolvers for items and owners) against a local Redis. Median latencies on a laptop, with the result written before responding (`awaitWriteBeforeResponse`):

| | 0.1.5 | 0.2.0 |
|---|---|---|
| Plain execution, no cache | 1.3 ms | 1.3 ms |
| Cache miss | 52 ms | 18 ms |
| Cache hit | 53 ms | 7 ms |
| Partial refresh (one item, one owner, or list reordered) | 53–54 ms | 18–19 ms |

```bash
yarn build && nice node scripts/bench.mjs lib/cjs
```

## Upgrading from 0.1

- The storage format changed: start with an empty cache (or a new `keyPrefix`).
- The eager invalidation strategy was removed; use `lazyInvalidationStrategy`.
- Custom `Cache` implementations need `getEpoch`, `invalidate`, `isSetMember` and conditional pipes (`getPipe(condition)`); `getKeysStartingWith` is no longer used. See `createMemoryCache` for a reference implementation.
- `makeResultProcessor` no longer caches results with errors by default.
- Cache resolver aliases changed format (`_ENTITY_dashboard__latestUpdates_i0`).

## Development

```bash
yarn test            # unit, regression, and differential tests
yarn typecheck
yarn lint
yarn build && yarn smoke
```

The tests run against both the memory cache and a real Redis: either `REDIS_URL`, or a `redis-server` binary on the `PATH` (started on a random port). The differential tests compare random sequences of changes against direct execution; scale them up with `FUZZ_SEEDS=500 FUZZ_STEPS=250 yarn test differential`.

## Maintainer
- Max Bolotin max@ourstudio.se

## License
MIT
