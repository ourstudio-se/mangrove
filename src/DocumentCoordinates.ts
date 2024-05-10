import { ASTNode, ASTVisitor, Kind, getEnterLeaveForKind } from "graphql";
import { CoordinateRoot } from "./constants";
import { isNode } from "graphql/language/ast";

export class DocumentCoordinates {
  private _currentCoordinates: string = "";

  private _pathCache: Record<string, readonly string[]> = {};

  enter(node: ASTNode) {
    switch (node.kind) {
      case Kind.OPERATION_DEFINITION: {
        this._currentCoordinates = CoordinateRoot[node.operation];
        return;
      }
      case Kind.FRAGMENT_DEFINITION: {
        this._currentCoordinates = node.name.value;
        return;
      }
      case Kind.FIELD: {
        this._currentCoordinates = `${this._currentCoordinates}.${
          node.alias?.value ?? node.name.value
        }`;
        return;
      }
    }
  }

  getCoordinates(): string {
    return this._currentCoordinates;
  }

  getPath(): readonly string[] {
    if (this._pathCache[this._currentCoordinates]) {
      return this._pathCache[this._currentCoordinates];
    }

    const path = this._currentCoordinates.split(".");

    this._pathCache[this._currentCoordinates] = path;
    return path;
  }

  leave(node: ASTNode) {
    switch (node.kind) {
      case Kind.OPERATION_DEFINITION:
      case Kind.FRAGMENT_DEFINITION: {
        this._currentCoordinates = "";
        return;
      }
      case Kind.FIELD: {
        this._currentCoordinates = this._currentCoordinates.slice(
          0,
          this._currentCoordinates.lastIndexOf("."),
        );
      }
    }
  }
}

export function visitWithDocumentCoordinates(
  schemaCoordinates: DocumentCoordinates,
  visitor: ASTVisitor,
): ASTVisitor {
  return {
    enter(...args) {
      const node = args[0];
      schemaCoordinates.enter(node);
      const fn = getEnterLeaveForKind(visitor, node.kind).enter;
      if (fn) {
        const result = fn.apply(visitor, args);
        if (result !== undefined) {
          schemaCoordinates.leave(node);
          if (isNode(result)) {
            schemaCoordinates.enter(result);
          }
        }
        return result;
      }
    },
    leave(...args) {
      const node = args[0];
      const fn = getEnterLeaveForKind(visitor, node.kind).leave;
      let result: any;
      if (fn) {
        result = fn.apply(visitor, args);
      }
      schemaCoordinates.leave(node);
      return result;
    },
  };
}
