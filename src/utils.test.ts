import { gql, indexWiseDeepMerge, memoInlineFragments } from "./utils.js";
import { parse, print } from "graphql";

describe("inlineFragments", () => {
  test("correctly inlines all fragments", () => {
    const originalDocument = parse(gql`
      fragment A on A {
        b {
          ...B
        }
      }

      fragment B on B {
        c {
          ... on D {
            e
          }
        }
      }

      query Q {
        a {
          ...A
        }
        f {
          ... on F {
            g
          }
        }
      }
    `);

    const result = memoInlineFragments(originalDocument);

    const printedResult = print(result);

    if (!printedResult) {
      throw new Error("Couldn't print resulting document");
    }

    // prettier-ignore
    expect(printedResult).toBe(gql`query Q {
  a {
    ... on A {
      b {
        ... on B {
          c {
            ... on D {
              e
            }
          }
        }
      }
    }
  }
  f {
    ... on F {
      g
    }
  }
}`);
  });
});

describe("indexWiseDeepMerge", () => {
  test("empties item array when merged with non-partial source", () => {
    const source = { items: <string[]>[] };
    source.items[2] = "Foo";

    const target = { items: <string[]>["A", "B", "C", "D"] };

    indexWiseDeepMerge(target, source);

    expect(target.items[0]).toBe(undefined);
    expect(target.items[1]).toBe(undefined);
    expect(target.items[2]).toBe("Foo");
    expect(target.items[3]).toBe(undefined);
  });
});
