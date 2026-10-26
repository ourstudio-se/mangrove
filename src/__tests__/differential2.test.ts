/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Aggressive differential test: Int ids, ids with special characters, batch
 * and abstract cache resolvers, interfaces/unions, deep chains, value
 * objects, nested lists, aliases/args, @include/@skip, multi-operation
 * documents, entity TTLs, type-wide invalidation and concurrency.
 *
 * Env: FUZZ_SEEDS, FUZZ_STEPS, FUZZ_SEED_OFFSET, FUZZ_BACKENDS=memory,redis,
 * FUZZ_MODES=seq,conc,ttl, FUZZ_VARIANTS=0,1,2,3
 */
import {
  CacheFactory,
  createHarness,
  memoryCacheFactory,
  redisCacheFactory,
  startRedis,
  stopRedis,
} from "./harness.js";
import { EntityRecord } from "../typings.js";
import { execute, parse, validate } from "graphql";
import { appendFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const redisAvailable =
  !!process.env.REDIS_URL ||
  spawnSync("redis-server", ["--version"]).status === 0;

let redisUrl: string | undefined;

beforeAll(async () => {
  if (redisAvailable) redisUrl = await startRedis();
});

afterAll(async () => {
  await stopRedis();
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- schema

/**
 * Variants:
 * 0: node(id) abstract single, books(ids) batch for Book, library(id) Int
 * 1: nodes(ids) abstract batch, book(id) single for Book, library(id)
 * 2: no cache resolvers
 * 3: node(id) only (Book + Author via abstract), no library resolver
 */
export const typeDefs = (variant: number) => {
  const d = (on: boolean, arg = "") =>
    on ? `@cacheResolver${arg ? `(keyArg: "${arg}")` : ""}` : "";
  return `
  interface Node { id: ID! }
  interface Named { name: String! }
  union Media = Book | Magazine

  type Query {
    library(id: Int!, verbose: Boolean): Library ${d(variant === 0 || variant === 1, "id")}
    libraries: [Library!]!
    node(id: ID!): Node ${d(variant === 0 || variant === 3)}
    nodes(ids: [ID!]!): [Node]! ${d(variant === 1)}
    book(id: ID!): Book ${d(variant === 1)}
    books(ids: [ID!]!): [Book]! ${d(variant === 0)}
    author(id: ID!): Author
    featured: Media
    search(term: String): [Media]
    grid: [[Book]]
    named: [Named!]!
    viewer: Viewer!
  }
  type Viewer { favorites: [Book]! home: Library }
  type Library { id: Int! name: String! shelves: [Shelf!]! topAuthor: Author stats: Stats! }
  type Stats { count: Int! best: Book }
  type Shelf implements Named { id: ID! name: String! books: [Book]! grid: [[Book]]! library: Library }
  type Book implements Node & Named {
    id: ID! name: String! title(upper: Boolean): String! author: Author sequel: Book
    edition: Edition related(limit: Int): [Book!]!
  }
  type Edition { year: Int! publisher: Publisher }
  type Publisher { id: ID! name: String! }
  type Author implements Node & Named { id: ID! name: String! books(limit: Int): [Book!]! mentor: Author }
  type Magazine implements Named { id: ${process.env.FUZZ_MAG_ID ?? "Int!"} name: String! issue: Int! cover: Book }
`;
};

// ---------------------------------------------------------------- state

type Ref = [string, string | number];

interface State {
  authors: Record<string, { mentor: string | null; name: string }>;
  bookOrder: string[];
  books: Record<
    string,
    {
      author: string | null;
      edition: { publisher: string | null; year: number } | null;
      name: string;
      related: string[];
      sequel: string | null;
      title: string;
    }
  >;
  featured: Ref | null;
  grid: (string | null)[][] | null;
  libraries: Record<
    number,
    {
      best: string | null;
      count: number;
      name: string;
      shelves: string[];
      topAuthor: string | null;
    }
  >;
  libraryOrder: number[];
  magazines: Record<
    number,
    { cover: string | null; issue: number; name: string }
  >;
  named: Ref[];
  publishers: Record<string, { name: string }>;
  search: (Ref | null)[] | null;
  shelves: Record<
    string,
    {
      books: (string | null)[];
      grid: (string | null)[][];
      library: number | null;
      name: string;
    }
  >;
  viewer: { favorites: (string | null)[]; home: number | null };
}

const BOOK_IDS = [
  "b1",
  "b.2",
  "b:3",
  'b"4',
  "b@5",
  "b#6",
  "b>7",
  "bé8",
  "b💥9",
  "b 10",
  "b\\11",
  "b/12",
  "b{13}",
  "b$14",
  "b%15",
  "b'16",
  "b,17",
  "b`18",
  "7",
  "0",
];
const AUTHOR_IDS = ["a1", "a.2", "a:3", 'a"4', "a@#>5", "aü6", "a\n7"];
const SHELF_IDS = ["b1", "s:1", "s.2", "s'3", "", "0", "a1"];
const PUBLISHER_IDS = ["p1", "b1", "p:2", "1"];
const LIBRARY_IDS = [0, 1, 2, -5];
const MAGAZINE_IDS = [0, 1, 7];

let counter = 1000;
const word = (p: string) => `${p}${counter++}`;

function initialState(rand: () => number): State {
  const pickN = <T>(list: T[], p: number) => list.filter(() => rand() < p);
  const pickOne = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const pickOrNull = <T>(list: T[], p = 0.2) =>
    rand() < p ? null : pickOne(list);
  const s: State = {
    authors: {},
    bookOrder: [...BOOK_IDS],
    books: {},
    featured: ["Book", "b1"],
    grid: null,
    libraries: {},
    libraryOrder: [...LIBRARY_IDS],
    magazines: {},
    named: [],
    publishers: {},
    search: null,
    shelves: {},
    viewer: { favorites: [], home: 1 },
  };
  for (const id of AUTHOR_IDS)
    s.authors[id] = { mentor: null, name: word("auth") };
  for (const id of AUTHOR_IDS)
    s.authors[id].mentor = pickOrNull(AUTHOR_IDS, 0.3);
  for (const id of PUBLISHER_IDS) s.publishers[id] = { name: word("pub") };
  for (const id of BOOK_IDS) {
    s.books[id] = {
      author: pickOrNull(AUTHOR_IDS),
      edition:
        rand() < 0.2
          ? null
          : { publisher: pickOrNull(PUBLISHER_IDS), year: 1900 + counter++ },
      name: word("book"),
      related: pickN(BOOK_IDS, 0.15),
      sequel: pickOrNull(BOOK_IDS, 0.5),
      title: word("title"),
    };
  }
  for (const id of SHELF_IDS) {
    s.shelves[id] = {
      books: pickN([...BOOK_IDS, null], 0.25),
      grid: [pickN([...BOOK_IDS, null], 0.15), [], pickN(BOOK_IDS, 0.1)],
      library: pickOrNull(LIBRARY_IDS),
      name: word("shelf"),
    };
  }
  for (const id of LIBRARY_IDS) {
    s.libraries[id] = {
      best: pickOrNull(BOOK_IDS),
      count: counter++,
      name: word("lib"),
      shelves: pickN(SHELF_IDS, 0.4),
      topAuthor: pickOrNull(AUTHOR_IDS),
    };
  }
  for (const id of MAGAZINE_IDS) {
    s.magazines[id] = {
      cover: pickOrNull(BOOK_IDS),
      issue: counter++,
      name: word("mag"),
    };
  }
  s.grid = [pickN([...BOOK_IDS, null], 0.2), pickN(BOOK_IDS, 0.2)];
  s.search = [
    ["Book", "b.2"],
    null,
    ["Magazine", 0],
    ["Book", "gone"],
    ["Magazine", 7],
  ];
  s.named = [
    ["Book", "b:3"],
    ["Author", "a.2"],
    ["Magazine", 1],
    ["Shelf", "s:1"],
    ["Shelf", ""],
  ];
  s.viewer.favorites = pickN([...BOOK_IDS, null], 0.3);
  return s;
}

// ---------------------------------------------------------------- resolvers

function makeResolvers(holder: { s: State }) {
  const book = (id: string | null) =>
    id !== null && holder.s.books[id]
      ? { __typename: "Book", id, ...holder.s.books[id] }
      : null;
  const author = (id: string | null) =>
    id !== null && holder.s.authors[id]
      ? { __typename: "Author", id, ...holder.s.authors[id] }
      : null;
  const library = (id: number | null) =>
    id !== null && holder.s.libraries[id]
      ? { __typename: "Library", id, ...holder.s.libraries[id] }
      : null;
  const shelf = (id: string) =>
    holder.s.shelves[id]
      ? { __typename: "Shelf", id, ...holder.s.shelves[id] }
      : null;
  const magazine = (id: number) =>
    holder.s.magazines[id]
      ? { __typename: "Magazine", id, ...holder.s.magazines[id] }
      : null;
  const byRef = (ref: Ref | null): any => {
    if (!ref) return null;
    const [t, id] = ref;
    if (t === "Book") return book(id as string);
    if (t === "Author") return author(id as string);
    if (t === "Magazine") return magazine(id as number);
    if (t === "Shelf") return shelf(id as string);
    return null;
  };
  const node = (id: string) => book(id) ?? author(id);
  const nonNull = <T>(l: (T | null)[]) => l.filter((x): x is T => x !== null);
  const limit = <T>(l: T[], n: number | null | undefined) =>
    n === null || n === undefined ? l : l.slice(0, Math.max(0, n));

  return {
    Author: {
      books: (a: any, { limit: n }: any) =>
        limit(
          nonNull(
            holder.s.bookOrder
              .filter((b) => holder.s.books[b]?.author === a.id)
              .map(book),
          ),
          n,
        ),
      mentor: (a: any) => author(a.mentor),
    },
    Book: {
      author: (b: any) => author(b.author),
      edition: (b: any) => b.edition,
      related: (b: any, { limit: n }: any) =>
        limit(nonNull(b.related.map(book)), n),
      sequel: (b: any) => book(b.sequel),
      title: (b: any, { upper }: any) =>
        upper ? b.title.toUpperCase() : b.title,
    },
    Edition: {
      publisher: (e: any) =>
        e.publisher !== null && holder.s.publishers[e.publisher]
          ? { id: e.publisher, ...holder.s.publishers[e.publisher] }
          : null,
    },
    Library: {
      shelves: (l: any) => nonNull(l.shelves.map(shelf)),
      stats: (l: any) => ({ best: l.best, count: l.count }),
      topAuthor: (l: any) => author(l.topAuthor),
    },
    Magazine: { cover: (m: any) => book(m.cover) },
    Query: {
      author: (_: unknown, { id }: any) => author(id),
      book: (_: unknown, { id }: any) => book(id),
      books: (_: unknown, { ids }: any) => ids.map(book),
      featured: () => byRef(holder.s.featured),
      grid: () => holder.s.grid?.map((row) => row.map(book)) ?? null,
      libraries: () => nonNull(holder.s.libraryOrder.map(library)),
      library: (_: unknown, { id }: any) => library(id),
      named: () => nonNull(holder.s.named.map(byRef)),
      node: (_: unknown, { id }: any) => node(id),
      nodes: (_: unknown, { ids }: any) => ids.map(node),
      search: () => holder.s.search?.map(byRef) ?? null,
      viewer: () => holder.s.viewer,
    },
    Shelf: {
      books: (s: any) => s.books.map(book),
      grid: (s: any) => s.grid.map((row: any[]) => row.map(book)),
      library: (s: any) => library(s.library),
    },
    Stats: { best: (st: any) => book(st.best) },
    Viewer: {
      favorites: (v: any) => v.favorites.map(book),
      home: (v: any) => library(v.home),
    },
  };
}

// ---------------------------------------------------------------- queries

type Vars = (
  rand: () => number,
  s: State,
) => Record<string, unknown> | undefined;
interface Q {
  ops?: string[];
  query: string;
  vars?: Vars;
}

const pickR = <T>(rand: () => number, list: T[]): T =>
  list[Math.floor(rand() * list.length)];

const QUERIES: Q[] = [
  {
    // Int ids, chains, value objects in between
    query: `{ libraries { id name stats { count best { id title author { id name } } }
      shelves { id name books { id name author { id name mentor { id name } }
      edition { year publisher { id name } } } } } }`,
  },
  {
    // nested lists
    query: `{ grid { id name sequel { id name } } libraries { id shelves { id grid { id title(upper: true) } } } }`,
  },
  {
    // unions, union members without resolvers, nullable list with nulls
    query: `{ featured { __typename ... on Book { id name author { name } } ... on Magazine { mid: id issue cover { id name } } }
      search(term: "x") { ... on Book { id title } ... on Magazine { mid: id name cover { id title } } } }`,
  },
  {
    // fragments on interfaces
    query: `fragment N on Named { name }
      fragment NodeF on Node { id ... on Author { mentor { id ...N } } ... on Book { author { id ...N } } }
      { named { __typename ...N ... on Node { ...NodeF } ... on Magazine { mid: id issue } ... on Shelf { id books { ...NodeF ...N } } } }`,
  },
  {
    // same field, different aliases and args
    query: `query Q5($u: Boolean, $l: Int) { libraries { id a: shelves { id books { id t1: title t2: title(upper: true) t3: title(upper: $u) } }
      b: shelves { id name } } x: featured { ... on Book { id r1: related(limit: 1) { id name } r2: related(limit: $l) { id title } related { id } } } }`,
    vars: (r) => ({
      l: pickR(r, [0, 1, 2, null, -1]),
      u: pickR(r, [true, false, null]),
    }),
  },
  {
    // @include / @skip
    query: `fragment L on Library { name stats { count best { id ... on Book @skip(if: $a) { title } } } }
      query Q6($a: Boolean!, $b: Boolean!) { viewer { favorites { id name @include(if: $a) author @skip(if: $b) { id name } }
      home { id ...L @include(if: $b) name shelves @include(if: $b) { id books { id name } } } } }`,
    vars: (r) => ({ a: r() < 0.5, b: r() < 0.5 }),
  },
  {
    // multiple operations
    ops: ["A", "B", "C"],
    query: `query A { libraries { id topAuthor { id name books { id name } } } }
      query B { viewer { home { id stats { best { id sequel { id sequel { id name } } } } } } }
      query C($id: Int!) { library(id: $id) { id name shelves { id library { id name } } } }`,
    vars: (r) => ({ id: pickR(r, [...LIBRARY_IDS, 99]) }),
  },
  {
    // resolver root fields queried directly
    query: `query Q8($ids: [ID!]!, $nid: ID!) { books(ids: $ids) { id name author { id name } }
      node(id: $nid) { id ... on Author { name books(limit: 2) { id title } } ... on Book { name } }
      nodes(ids: $ids) { id ... on Book { sequel { id name } } } book(id: $nid) { id name } }`,
    vars: (r, s) => ({
      ids: Object.keys(s.books)
        .filter(() => r() < 0.2)
        .concat(r() < 0.2 ? ["missing"] : [], r() < 0.3 ? ["b1", "b1"] : []),
      nid: pickR(r, [...BOOK_IDS, ...AUTHOR_IDS, "zz"]),
    }),
  },
  {
    // deep chains
    query: `{ libraries { id shelves { id books { id sequel { id author { id mentor { id mentor { id name } } } } } } } }`,
  },
  {
    // the same entities at several places
    query: `{ a: libraries { id name } b: libraries { id shelves { id library { id name shelves { id name } } } }
      viewer { home { id name } } }`,
  },
  {
    // author entity in many forms, args on entity list fields
    query: `query Q11($l: Int) { libraries { id topAuthor { id name x: books(limit: $l) { id name } y: books { id author { id name } } } } }`,
    vars: (r) => ({ l: pickR(r, [0, 1, 3, null]) }),
  },
  {
    // shelves via named, nested grid and edition publisher chain
    query: `{ named { ... on Shelf { id name grid { id edition { year publisher { id name } } } library { id stats { count } } } } }`,
  },
  {
    // Without ids in some selections (entities selected without id by the client)
    query: `{ libraries { name shelves { name books { name author { name } } } } featured { ... on Book { title } } }`,
  },
];

// ---------------------------------------------------------------- mutations

type Inv = EntityRecord[];

/** All entities / Query whose stored fields mention the given book. */
function bookReferrers(s: State, id: string): Inv {
  const out: Inv = [];
  for (const [b, v] of Object.entries(s.books)) {
    if (v.sequel === id || v.related.includes(id))
      out.push({ id: b, typename: "Book" });
  }
  for (const [sh, v] of Object.entries(s.shelves)) {
    if (v.books.includes(id) || v.grid.some((row) => row.includes(id)))
      out.push({ id: sh, typename: "Shelf" });
  }
  for (const [l, v] of Object.entries(s.libraries)) {
    if (v.best === id) out.push({ id: Number(l), typename: "Library" });
  }
  for (const [m, v] of Object.entries(s.magazines)) {
    if (v.cover === id) out.push({ id: Number(m), typename: "Magazine" });
  }
  const a = s.books[id]?.author;
  if (a) out.push({ id: a, typename: "Author" }); // Author.books
  out.push({ typename: "Query" }); // root lists may mention it; be generous
  return out;
}

function authorReferrers(s: State, id: string): Inv {
  const out: Inv = [];
  for (const [b, v] of Object.entries(s.books))
    if (v.author === id) out.push({ id: b, typename: "Book" });
  for (const [a, v] of Object.entries(s.authors))
    if (v.mentor === id) out.push({ id: a, typename: "Author" });
  for (const [l, v] of Object.entries(s.libraries))
    if (v.topAuthor === id) out.push({ id: Number(l), typename: "Library" });
  out.push({ typename: "Query" });
  return out;
}

function libraryReferrers(s: State, id: number): Inv {
  const out: Inv = [{ typename: "Query" }];
  for (const [sh, v] of Object.entries(s.shelves))
    if (v.library === id) out.push({ id: sh, typename: "Shelf" });
  return out;
}

type Mutation = (s: State, r: () => number) => Inv | null;

const deleted: {
  authors: Record<string, any>;
  books: Record<string, any>;
  libraries: Record<number, any>;
} = {
  authors: {},
  books: {},
  libraries: {},
};

const someBook = (s: State, r: () => number) => pickR(r, Object.keys(s.books));
const someAuthor = (s: State, r: () => number) =>
  pickR(r, Object.keys(s.authors));
const anyBookOrNull = (r: () => number) =>
  r() < 0.2 ? null : pickR(r, [...BOOK_IDS, "b:new.x"]);

const MUTATIONS: [string, Mutation, number][] = [
  [
    "rename book",
    (s, r) => {
      const id = someBook(s, r);
      if (!id) return null;
      s.books[id].name = word("book");
      return [{ id, typename: "Book" }];
    },
    3,
  ],
  [
    "retitle book",
    (s, r) => {
      const id = someBook(s, r);
      if (!id) return null;
      s.books[id].title = word("title");
      return [{ id, typename: "Book" }];
    },
    2,
  ],
  [
    "rename author",
    (s, r) => {
      const id = someAuthor(s, r);
      if (!id) return null;
      s.authors[id].name = word("auth");
      return [{ id, typename: "Author" }];
    },
    3,
  ],
  [
    "rename publisher",
    (s, r) => {
      const id = pickR(r, PUBLISHER_IDS);
      s.publishers[id].name = word("pub");
      return [{ id, typename: "Publisher" }];
    },
    2,
  ],
  [
    "rename shelf",
    (s, r) => {
      const id = pickR(r, SHELF_IDS);
      s.shelves[id].name = word("shelf");
      return [{ id, typename: "Shelf" }];
    },
    2,
  ],
  [
    "rename library",
    (s, r) => {
      const id = pickR(r, Object.keys(s.libraries));
      if (id === undefined) return null;
      s.libraries[Number(id)].name = word("lib");
      return [{ id: Number(id), typename: "Library" }];
    },
    2,
  ],
  [
    "library count",
    (s, r) => {
      const id = pickR(r, Object.keys(s.libraries));
      if (id === undefined) return null;
      s.libraries[Number(id)].count = counter++;
      return [{ id: Number(id), typename: "Library" }];
    },
    1,
  ],
  [
    "library best",
    (s, r) => {
      const id = pickR(r, Object.keys(s.libraries));
      if (id === undefined) return null;
      s.libraries[Number(id)].best = anyBookOrNull(r);
      return [{ id: Number(id), typename: "Library" }];
    },
    2,
  ],
  [
    "library topAuthor",
    (s, r) => {
      const id = pickR(r, Object.keys(s.libraries));
      if (id === undefined) return null;
      s.libraries[Number(id)].topAuthor =
        r() < 0.2 ? null : pickR(r, AUTHOR_IDS);
      return [{ id: Number(id), typename: "Library" }];
    },
    2,
  ],
  [
    "library shelves",
    (s, r) => {
      const id = pickR(r, Object.keys(s.libraries));
      if (id === undefined) return null;
      s.libraries[Number(id)].shelves = SHELF_IDS.filter(() => r() < 0.4).sort(
        () => r() - 0.5,
      );
      return [{ id: Number(id), typename: "Library" }];
    },
    2,
  ],
  [
    "magazine",
    (s, r) => {
      const id = pickR(r, MAGAZINE_IDS);
      const m = s.magazines[id];
      if (r() < 0.5) m.issue = counter++;
      else m.cover = anyBookOrNull(r);
      return [{ id, typename: "Magazine" }];
    },
    2,
  ],
  [
    "book author",
    (s, r) => {
      const id = someBook(s, r);
      if (!id) return null;
      const from = s.books[id].author;
      const to = r() < 0.2 ? null : pickR(r, AUTHOR_IDS);
      s.books[id].author = to;
      const inv: Inv = [{ id, typename: "Book" }];
      if (from) inv.push({ id: from, typename: "Author" });
      if (to) inv.push({ id: to, typename: "Author" });
      return inv;
    },
    3,
  ],
  [
    "book sequel",
    (s, r) => {
      const id = someBook(s, r);
      if (!id) return null;
      s.books[id].sequel = anyBookOrNull(r);
      return [{ id, typename: "Book" }];
    },
    2,
  ],
  [
    "book edition",
    (s, r) => {
      const id = someBook(s, r);
      if (!id) return null;
      const e = s.books[id].edition;
      const x = r();
      if (x < 0.25) s.books[id].edition = null;
      else if (x < 0.5 || !e)
        s.books[id].edition = {
          publisher: r() < 0.2 ? null : pickR(r, PUBLISHER_IDS),
          year: counter++,
        };
      else if (x < 0.75) e.year = counter++;
      else e.publisher = r() < 0.3 ? null : pickR(r, PUBLISHER_IDS);
      return [{ id, typename: "Book" }];
    },
    3,
  ],
  [
    "book related",
    (s, r) => {
      const id = someBook(s, r);
      if (!id) return null;
      s.books[id].related = BOOK_IDS.filter(() => r() < 0.2).sort(
        () => r() - 0.5,
      );
      return [{ id, typename: "Book" }];
    },
    2,
  ],
  [
    "author mentor",
    (s, r) => {
      const id = someAuthor(s, r);
      if (!id) return null;
      s.authors[id].mentor = r() < 0.3 ? null : pickR(r, AUTHOR_IDS);
      return [{ id, typename: "Author" }];
    },
    2,
  ],
  [
    "shelf books",
    (s, r) => {
      const id = pickR(r, SHELF_IDS);
      s.shelves[id].books = [...BOOK_IDS, null, null]
        .filter(() => r() < 0.25)
        .sort(() => r() - 0.5);
      if (r() < 0.3 && s.shelves[id].books.length)
        s.shelves[id].books.push(s.shelves[id].books[0]);
      return [{ id, typename: "Shelf" }];
    },
    2,
  ],
  [
    "shelf grid",
    (s, r) => {
      const id = pickR(r, SHELF_IDS);
      const rows = Math.floor(r() * 4);
      s.shelves[id].grid = Array.from({ length: rows }, () =>
        [...BOOK_IDS, null].filter(() => r() < 0.15),
      );
      return [{ id, typename: "Shelf" }];
    },
    2,
  ],
  [
    "shelf library",
    (s, r) => {
      const id = pickR(r, SHELF_IDS);
      s.shelves[id].library = r() < 0.2 ? null : pickR(r, LIBRARY_IDS);
      return [{ id, typename: "Shelf" }];
    },
    1,
  ],
  [
    "root featured",
    (s, r) => {
      const x = r();
      s.featured =
        x < 0.15
          ? null
          : x < 0.6
            ? ["Book", pickR(r, BOOK_IDS)]
            : ["Magazine", pickR(r, MAGAZINE_IDS)];
      return [{ typename: "Query" }];
    },
    2,
  ],
  [
    "root search",
    (s, r) => {
      if (r() < 0.1) {
        s.search = null;
        return [{ typename: "Query" }];
      }
      const all: (Ref | null)[] = [
        ...BOOK_IDS.map((b): Ref => ["Book", b]),
        ...MAGAZINE_IDS.map((m): Ref => ["Magazine", m]),
        null,
        null,
      ];
      s.search = all.filter(() => r() < 0.2).sort(() => r() - 0.5);
      return [{ typename: "Query" }];
    },
    2,
  ],
  [
    "root grid",
    (s, r) => {
      s.grid =
        r() < 0.1
          ? null
          : Array.from({ length: Math.floor(r() * 4) }, () =>
              [...BOOK_IDS, null].filter(() => r() < 0.2),
            );
      return [{ typename: "Query" }];
    },
    2,
  ],
  [
    "root named",
    (s, r) => {
      const all: Ref[] = [
        ...BOOK_IDS.map((b): Ref => ["Book", b]),
        ...AUTHOR_IDS.map((a): Ref => ["Author", a]),
        ...MAGAZINE_IDS.map((m): Ref => ["Magazine", m]),
        ...SHELF_IDS.map((sh): Ref => ["Shelf", sh]),
      ];
      s.named = all.filter(() => r() < 0.15).sort(() => r() - 0.5);
      return [{ typename: "Query" }];
    },
    2,
  ],
  [
    "root viewer",
    (s, r) => {
      if (r() < 0.5) {
        s.viewer.favorites = [...BOOK_IDS, null]
          .filter(() => r() < 0.25)
          .sort(() => r() - 0.5);
        if (r() < 0.4)
          s.viewer.favorites.push(...s.viewer.favorites.slice(0, 2));
      } else s.viewer.home = r() < 0.2 ? null : pickR(r, LIBRARY_IDS);
      return [{ typename: "Query" }];
    },
    2,
  ],
  [
    "root libraryOrder",
    (s, r) => {
      s.libraryOrder = LIBRARY_IDS.filter(() => r() < 0.8).sort(
        () => r() - 0.5,
      );
      return [{ typename: "Query" }];
    },
    1,
  ],
  [
    "book order",
    (s, r) => {
      s.bookOrder.sort(() => r() - 0.5);
      return [{ typename: "Author" }];
    },
    1,
  ],
  [
    "delete book",
    (s, r) => {
      const id = someBook(s, r);
      if (!id) return null;
      const inv = [...bookReferrers(s, id), { id, typename: "Book" }];
      deleted.books[id] = s.books[id];
      delete s.books[id];
      return inv;
    },
    1,
  ],
  [
    "restore book",
    (s, r) => {
      const id = pickR(r, Object.keys(deleted.books));
      if (!id) return null;
      s.books[id] = deleted.books[id];
      delete deleted.books[id];
      return [...bookReferrers(s, id), { id, typename: "Book" }];
    },
    1,
  ],
  [
    "delete author",
    (s, r) => {
      const id = someAuthor(s, r);
      if (!id) return null;
      const inv = [...authorReferrers(s, id), { id, typename: "Author" }];
      deleted.authors[id] = s.authors[id];
      delete s.authors[id];
      return inv;
    },
    1,
  ],
  [
    "restore author",
    (s, r) => {
      const id = pickR(r, Object.keys(deleted.authors));
      if (!id) return null;
      s.authors[id] = deleted.authors[id];
      delete deleted.authors[id];
      return [...authorReferrers(s, id), { id, typename: "Author" }];
    },
    1,
  ],
  [
    "delete library",
    (s, r) => {
      const id = pickR(r, Object.keys(s.libraries));
      if (id === undefined) return null;
      const n = Number(id);
      const inv = [...libraryReferrers(s, n), { id: n, typename: "Library" }];
      deleted.libraries[n] = s.libraries[n];
      delete s.libraries[n];
      return inv;
    },
    1,
  ],
  [
    "restore library",
    (s, r) => {
      const id = pickR(r, Object.keys(deleted.libraries));
      if (id === undefined) return null;
      const n = Number(id);
      s.libraries[n] = deleted.libraries[n];
      delete deleted.libraries[n];
      return [...libraryReferrers(s, n), { id: n, typename: "Library" }];
    },
    1,
  ],
  ["nothing", () => [], 1],
];

const WEIGHTED: [string, Mutation][] = MUTATIONS.filter(
  ([n]) => !process.env.FUZZ_NO_DELETE || !/delete|restore/.test(n),
).flatMap(([n, m, w]) =>
  Array.from({ length: w }, () => [n, m] as [string, Mutation]),
);

/** Sometimes widen an entity invalidation to the whole type (always allowed). */
function widen(inv: Inv, r: () => number): Inv {
  if (r() < 0.12) {
    return inv.map((e) =>
      e.id !== undefined && r() < 0.6 ? { typename: e.typename } : e,
    );
  }
  return inv;
}

// ---------------------------------------------------------------- runner

const stringify = (x: unknown) => JSON.stringify(x);

function expectedFor(
  h: ReturnType<typeof createHarness>,
  holder: { s: State },
  snapshot: State,
  q: Q,
  operationName: string | undefined,
  variables: any,
) {
  const prev = holder.s;
  holder.s = snapshot;
  try {
    const res = execute({
      document: parse(q.query),
      operationName,
      schema: h.schema,
      variableValues: variables,
    });
    if (res instanceof Promise) throw new Error("expected sync execution");
    return stringify(res);
  } finally {
    holder.s = prev;
  }
}

function fakeDate() {
  const start = Date.now();
  jest.useFakeTimers({
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "queueMicrotask",
    ],
    now: start,
  });
  let offset = 0;
  return (delta: number) => {
    offset += delta;
    jest.setSystemTime(start + offset);
  };
}

const tick = (r: () => number) =>
  new Promise<void>((resolve) => {
    const n = Math.floor(r() * 4);
    let i = 0;
    const go = (): void => {
      if (i++ >= n) resolve();
      else setImmediate(go);
    };
    go();
  });

const envList = (name: string, def: string) =>
  (process.env[name] ?? def).split(",").filter(Boolean);

const backends: [string, () => CacheFactory, boolean][] = [
  ["memory", () => memoryCacheFactory, true],
  ["redis", () => redisCacheFactory(redisUrl!), redisAvailable],
];
const BACKENDS = envList("FUZZ_BACKENDS", "memory,redis");
const MODES = envList("FUZZ_MODES", "seq,conc,ttl");
const VARIANTS = envList("FUZZ_VARIANTS", "0,1,2,3").map(Number);
const OFFSET = Number(process.env.FUZZ_SEED_OFFSET ?? 0);
const SEEDS = Array.from(
  { length: Number(process.env.FUZZ_SEEDS ?? 3) },
  (_, i) => i + 1 + OFFSET,
);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
const TTL_ENTITY = 100;

afterEach(() => {
  jest.useRealTimers();
});

const TORN_EXAMPLE: string[] = [];
const STATS = {
  torn: 0,
  fallback: 0,
  fullHit: 0,
  linkQueries: 0,
  miss: 0,
  partial: 0,
  requests: 0,
  concReq: 0,
};
const WARNINGS = new Map<string, number>();
const EXAMPLES = new Map<string, string>();
afterAll(() => {
  if (process.env.FUZZ_STATS)
    appendFileSync(
      process.env.FUZZ_STATS,
      JSON.stringify({ STATS, TORN_EXAMPLE, WARNINGS: [...WARNINGS] }) + "\n",
    );
  else if (process.env.FUZZ_VERBOSE)
    console.log(JSON.stringify(STATS), JSON.stringify([...WARNINGS]));
  if (process.env.FUZZ_EXAMPLES)
    writeFileSync(
      process.env.FUZZ_EXAMPLES,
      [...EXAMPLES.entries()].map(([k, v]) => `### ${k}\n${v}`).join("\n\n"),
    );
});

for (const [backend, getFactory, available] of backends) {
  if (!BACKENDS.includes(backend)) continue;
  (available ? describe : describe.skip)(`${backend} cache`, () => {
    for (const mode of MODES) {
      for (const variant of VARIANTS) {
        for (const seed of SEEDS) {
          test(`mode ${mode}, variant ${variant}, seed ${seed}`, async () => {
            await runSeed(getFactory, mode, variant, seed);
          }, 600_000);
        }
      }
    }
  });
}

async function runSeed(
  getFactory: () => CacheFactory,
  mode: string,
  variant: number,
  seed: number,
) {
  const rand = mulberry32(
    seed * 7919 + variant * 31 + (mode === "conc" ? 1 : mode === "ttl" ? 2 : 0),
  );
  deleted.authors = {};
  deleted.books = {};
  deleted.libraries = {};
  const holder = { s: initialState(rand) };
  const advance = mode === "ttl" ? fakeDate() : undefined;
  const h = createHarness({
    cache: await getFactory()(),
    entityTtls:
      mode === "ttl" ? { Author: TTL_ENTITY, Magazine: TTL_ENTITY * 3 } : {},
    resolvers: makeResolvers(holder),
    ttl: mode === "ttl" ? 5_000 : 60_000,
    typeDefs: typeDefs(variant),
  });
  const history: string[] = [];
  const trace: any[] = [];
  for (const q of QUERIES) {
    const errs = validate(h.schema, parse(q.query));
    if (errs.length)
      throw new Error(
        `invalid test query ${q.query}: ${errs.map((e: any) => e.message).join("; ")}`,
      );
  }

  const fail = (msg: string[]) => {
    if (process.env.FUZZ_TRACE) {
      const last = trace[trace.length - 1];
      const rel = trace.filter(
        (t) =>
          t.q === last.q &&
          t.opName === last.opName &&
          stringify(t.variables) === stringify(last.variables),
      );
      writeFileSync(
        process.env.FUZZ_TRACE,
        rel
          .map(
            (t) =>
              `== step ${t.step} t=${t.t} ${t.ext}\nexpected ${t.expected}\nreceived ${t.received}\n${t.executed.join("\n---\n")}`,
          )
          .join("\n") +
          "\n\nHISTORY\n" +
          history.join("\n") +
          "\n\nSTATE\n" +
          JSON.stringify(holder.s, null, 1),
      );
    }
    throw new Error(
      [...msg, "history (last 30):", ...history.slice(-30)].join("\n"),
    );
  };

  const pickQuery = () => {
    const q = pickR(rand, QUERIES);
    const operationName = q.ops ? pickR(rand, q.ops) : undefined;
    let variables = q.vars?.(rand, holder.s);
    if (q.ops && operationName !== "C") variables = undefined;
    return { operationName, q, variables };
  };

  const runSequential = async (step: number) => {
    for (let i = 0; i < 6; i++) {
      const { q, operationName, variables } = pickQuery();
      const expected = expectedFor(
        h,
        holder,
        holder.s,
        q,
        operationName,
        variables,
      );
      const { result, executed } = await h.run(q.query, {
        operationName,
        variables: variables as any,
      });
      const { extensions: _e, ...actual } = result;
      trace.push({
        ext: stringify({
          hit: (_e as any)?.cache?.hit,
          partial: (_e as any)?.cache?.partial,
          pq: (_e as any)?.cache?.partialQuery?.length,
        }),
        executed,
        expected,
        opName: operationName,
        q: q.query,
        received: stringify(actual),
        step,
        t: Date.now(),
        variables,
      });
      STATS.requests++;
      const c = (_e as any)?.cache;
      if (!c?.hit) STATS.miss++;
      else if (executed.length === 0) STATS.fullHit++;
      else STATS.partial++;
      STATS.linkQueries += c?.linkQueries?.length ?? 0;
      if (stringify(actual) !== expected) {
        fail([
          `Mismatch (variant ${variant}, mode ${mode}, seed ${seed}, step ${step})`,
          `query: ${q.query}`,
          `operationName: ${operationName} variables: ${stringify(variables)}`,
          `expected ${expected}`,
          `received ${stringify(actual)}`,
          "executed:",
          ...executed,
        ]);
      }
    }
  };

  const applyMutation = (): { inv: Inv; name: string } | null => {
    const [name, mutate] = pickR(rand, WEIGHTED);
    const inv = mutate(holder.s, rand);
    if (inv === null) return null;
    return { inv: widen(inv, rand), name };
  };

  for (let step = 0; step < STEPS; step++) {
    if (mode === "conc" && rand() < 0.3) {
      // Concurrent batch: mutations run sequentially with each other, but
      // concurrently with requests.
      const snapshots: State[] = [structuredClone(holder.s)];
      let completed = 0;
      const nMut = 1 + Math.floor(rand() * 2);
      const mutator = (async () => {
        for (let i = 0; i < nMut; i++) {
          await tick(rand);
          const m = applyMutation();
          if (!m) continue;
          snapshots.push(structuredClone(holder.s));
          const v = snapshots.length - 1;
          history.push(
            `[conc ${step}] ${m.name} -> ${stringify(m.inv)} (v${v})`,
          );
          await tick(rand);
          if (m.inv.length) await h.strategy.invalidateEntities(m.inv);
          completed = v;
        }
      })();
      const nReq = 2 + Math.floor(rand() * 4);
      const reqs = Array.from({ length: nReq }, async () => {
        const { q, operationName, variables } = pickQuery();
        await tick(rand);
        const lo = completed;
        // run() resets the shared `executed` buffer; we don't use it here.
        const { result } = await h.run(q.query, {
          operationName,
          variables: variables as any,
        });
        const hi = snapshots.length - 1;
        const actual = { ...result };
        delete actual.extensions;
        STATS.concReq++;
        const got = stringify(actual);
        const candidates: number[] = [];
        for (let v = lo; v <= hi; v++) {
          if (
            expectedFor(
              h,
              holder,
              snapshots[v],
              q,
              operationName,
              variables,
            ) === got
          )
            candidates.push(v);
        }
        if (candidates.length === 0) {
          const any = snapshots.findIndex(
            (sn) =>
              expectedFor(h, holder, sn, q, operationName, variables) === got,
          );
          if (lo < hi && any === -1) {
            // Torn read: mixes states while a change was in flight.
            STATS.torn++;
            if (!TORN_EXAMPLE.length)
              TORN_EXAMPLE.push(
                `[variant ${variant} seed ${seed} step ${step}] ${q.query}\nreceived ${got}`,
              );
            return;
          }
          fail([
            `Concurrent mismatch (variant ${variant}, seed ${seed}, step ${step}) window v${lo}..v${hi}; matches snapshot ${any}`,
            `query: ${q.query}`,
            `operationName: ${operationName} variables: ${stringify(variables)}`,
            ...Array.from(
              { length: hi - lo + 1 },
              (_, k) =>
                `expected(v${lo + k}) ${expectedFor(h, holder, snapshots[lo + k], q, operationName, variables)}`,
            ),
            `received ${got}`,
          ]);
        }
      });
      await Promise.all([mutator, ...reqs]);
      // After everything settled, the cache must be consistent again.
      await runSequential(step);
      continue;
    }

    if (mode === "ttl" && rand() < 0.25) {
      // Silent change to a TTL'd entity (no invalidation), then wait out TTL.
      const id = pickR(rand, Object.keys(holder.s.authors));
      if (id !== undefined) {
        holder.s.authors[id].name = word("silent");
        history.push(
          `silent rename author ${stringify(id)}; advance ${TTL_ENTITY + 1}`,
        );
        advance!(TTL_ENTITY + 1);
        // Magazine has 3x TTL: only change it when also waiting 3x.
        if (rand() < 0.3) {
          const m = pickR(rand, MAGAZINE_IDS);
          holder.s.magazines[m].issue = counter++;
          history.push(`silent magazine issue ${m}; advance ${TTL_ENTITY * 3}`);
          advance!(TTL_ENTITY * 3);
        }
      }
    } else {
      const m = applyMutation();
      if (m === null) continue;
      history.push(`[${step}] ${m.name} -> ${stringify(m.inv)}`);
      if (m.inv.length) await h.strategy.invalidateEntities(m.inv);
    }
    if (advance) advance(Math.floor(rand() * 60));

    await runSequential(step);
  }

  for (const w of h.logger.warnings) {
    const k = String(w[0]).replace(/at .*/, "").slice(0, 120);
    if (k.startsWith("Partial execution could not")) STATS.fallback++;
    WARNINGS.set(k, (WARNINGS.get(k) ?? 0) + 1);
    const full = String(w[0]);
    const sig = full
      .split("\n")
      .filter(
        (l) =>
          !l.startsWith(" ") &&
          !l.startsWith("{") &&
          !l.startsWith("}") &&
          !l.startsWith("query") &&
          !l.startsWith("fragment"),
      )
      .join(" | ")
      .slice(0, 300);
    if (!EXAMPLES.has(sig))
      EXAMPLES.set(
        sig,
        `[variant ${variant} mode ${mode} seed ${seed}] ` + full,
      );
  }
  expect(h.logger.errors).toEqual([]);
}
