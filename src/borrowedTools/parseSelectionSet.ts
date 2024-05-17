/* eslint-disable @typescript-eslint/no-explicit-any */
import { ParseOptions, parse } from "graphql";
import { SelectionSetNode } from "graphql";

export function parseSelectionSet(
  selectionSet: string,
  options?: ParseOptions,
): SelectionSetNode {
  const query = parse(selectionSet, options).definitions[0];
  return (query as any).selectionSet;
}
