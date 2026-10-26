import {
  dataPathToStr,
  gql,
  memoInlineFragments,
  pruneUnusedVariables,
  strToDataPath,
} from "./utils.js";
import { OperationDefinitionNode, parse, print } from "graphql";

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

describe("inlineFragments with directives", () => {
  test("keeps directives of fragment spreads", () => {
    const result = memoInlineFragments(
      parse(gql`
        fragment D on Dashboard {
          top {
            id
          }
        }
        query Q($x: Boolean!) {
          dashboard {
            ...D @include(if: $x)
          }
        }
      `),
    );

    expect(print(result)).toContain("... on Dashboard @include(if: $x)");
  });

  test("rejects cyclic fragments", () => {
    expect(() =>
      memoInlineFragments(
        parse(gql`
          fragment A on T {
            ...B
          }
          fragment B on T {
            ...A
          }
          query {
            t {
              ...A
            }
          }
        `),
      ),
    ).toThrow(/Cyclic/);
  });
});

describe("pruneUnusedVariables", () => {
  test("drops definitions of variables no longer used", () => {
    const document = parse(gql`
      query Q($a: Int, $b: Int, $c: Boolean!) {
        x(a: $a) @include(if: $c)
      }
    `);
    const operation = document.definitions[0] as OperationDefinitionNode;
    const pruned = pruneUnusedVariables(operation);

    expect(
      pruned.variableDefinitions?.map((d) => d.variable.name.value),
    ).toEqual(["a", "c"]);
  });
});

describe("data path notation", () => {
  test.each([
    'Query.items@0#"a.b@c#d"',
    'Query.items~Item@0#"1".owner~Owner#"5"',
    'Query.x#"say \\"hi\\""',
  ])("round-trips %s", (str) => {
    expect(dataPathToStr(strToDataPath(str))).toBe(str);
  });

  test("parses typenames, indices and ids", () => {
    expect(strToDataPath('Query.items~Item@2#"a.b"')).toEqual([
      { field: "Query" },
      { field: "items", id: "a.b", index: 2, typename: "Item" },
    ]);
  });
});
