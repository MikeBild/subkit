import ts from "typescript";
import type { RuleHit } from "./rules.ts";

type RequestPart = "params" | "query" | "body";

const VALID_TARGET: Readonly<Record<string, RequestPart>> = {
  param: "params",
  query: "query",
  json: "body",
  form: "body",
};

const RAW_ACCESS: Readonly<Record<string, RequestPart>> = {
  param: "params",
  query: "query",
  queries: "query",
  json: "body",
  formData: "body",
  parseBody: "body",
  text: "body",
  arrayBuffer: "body",
  blob: "body",
};

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function unwrap(node: ts.Expression): ts.Expression {
  let out = node;
  while (
    ts.isParenthesizedExpression(out) ||
    ts.isAsExpression(out) ||
    ts.isSatisfiesExpression(out) ||
    ts.isNonNullExpression(out)
  ) {
    out = out.expression;
  }
  return out;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function isCreateRouteCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "createRoute"
  );
}

function declaredParts(call: ts.CallExpression): Set<RequestPart> {
  const out = new Set<RequestPart>();
  const config = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!config || !ts.isObjectLiteralExpression(config))
    return out.add("params").add("query").add("body");
  for (const prop of config.properties) {
    if (ts.isSpreadAssignment(prop)) {
      out.add("params").add("query").add("body");
      continue;
    }
    if (!prop.name || propertyNameText(prop.name) !== "request") continue;
    if (!ts.isPropertyAssignment(prop)) {
      out.add("params").add("query").add("body");
      continue;
    }
    const request = unwrap(prop.initializer);
    if (!ts.isObjectLiteralExpression(request)) {
      out.add("params").add("query").add("body");
      continue;
    }
    for (const part of request.properties) {
      if (ts.isSpreadAssignment(part)) {
        out.add("params").add("query").add("body");
        continue;
      }
      const name = part.name ? propertyNameText(part.name) : null;
      if (name === "params" || name === "query" || name === "body") out.add(name);
    }
  }
  return out;
}

function returnedCreateRoute(body: ts.Node): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const value = unwrap(node.expression);
      if (isCreateRouteCall(value)) found = value;
      return;
    }
    if (ts.isFunctionLike(node) && node !== body) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  if (found) return found;
  if (ts.isArrowFunction(body)) {
    const value = ts.isExpression(body.body) ? unwrap(body.body) : null;
    if (value && isCreateRouteCall(value)) return value;
  }
  return null;
}

interface RouteIndex {
  byName: Map<string, Set<RequestPart>>;
  all: Set<RequestPart>;
}

function indexRoutes(sf: ts.SourceFile): RouteIndex {
  const factories = new Map<string, Set<RequestPart>>();
  const byName = new Map<string, Set<RequestPart>>();
  const all = new Set<RequestPart>();
  const collectFactories = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const call = returnedCreateRoute(node);
      if (call) factories.set(node.name.text, declaredParts(call));
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const call = returnedCreateRoute(node.initializer);
      if (call) factories.set(node.name.text, declaredParts(call));
    }
    if (isCreateRouteCall(node)) for (const part of declaredParts(node)) all.add(part);
    ts.forEachChild(node, collectFactories);
  };
  collectFactories(sf);
  const collectRoutes = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (isCreateRouteCall(value)) byName.set(node.name.text, declaredParts(value));
      else if (
        ts.isCallExpression(value) &&
        ts.isIdentifier(value.expression) &&
        factories.has(value.expression.text)
      ) {
        byName.set(node.name.text, factories.get(value.expression.text) as Set<RequestPart>);
      }
    }
    ts.forEachChild(node, collectRoutes);
  };
  collectRoutes(sf);
  return { byName, all };
}

function routeParts(arg: ts.Expression, index: RouteIndex): Set<RequestPart> {
  const value = unwrap(arg);
  if (isCreateRouteCall(value)) return declaredParts(value);
  if (ts.isIdentifier(value)) return index.byName.get(value.text) ?? index.all;
  return index.all;
}

function contextName(handler: ts.SignatureDeclaration): string | null {
  const first = handler.parameters[0];
  return first && ts.isIdentifier(first.name) ? first.name.text : null;
}

function usedParts(sf: ts.SourceFile, handler: ts.Node, ctx: string) {
  const out: Array<{ part: RequestPart; line: number; what: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "req" &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === ctx
    ) {
      const method = node.expression.name.text;
      const first = node.arguments[0];
      if (method === "valid") {
        const target = first && ts.isStringLiteralLike(first) ? first.text : "";
        const part = VALID_TARGET[target];
        if (part) out.push({ part, line: lineOf(sf, node), what: `${ctx}.req.valid("${target}")` });
      } else {
        const part = RAW_ACCESS[method];
        if (part) out.push({ part, line: lineOf(sf, node), what: `${ctx}.req.${method}()` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handler);
  return out;
}

export function routeSchemaHits(sf: ts.SourceFile): RuleHit[] {
  const index = indexRoutes(sf);
  const hits: RuleHit[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "openapi" &&
      node.arguments.length >= 2
    ) {
      const [route, ...rest] = node.arguments;
      const handler = rest.find(
        (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
      );
      const ctx = handler ? contextName(handler) : null;
      if (route && handler && ctx) {
        const declared = routeParts(route, index);
        for (const use of usedParts(sf, handler, ctx)) {
          if (!declared.has(use.part)) {
            hits.push({ line: use.line, what: `${use.what} without request.${use.part}` });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function isConversationToolType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName;
    if (ts.isIdentifier(name) && name.text === "ConversationTool") return true;
    if (ts.isQualifiedName(name) && name.right.text === "ConversationTool") return true;
    if (ts.isIdentifier(name) && name.text === "Readonly" && type.typeArguments?.[0]) {
      return isConversationToolType(type.typeArguments[0]);
    }
    return false;
  }
  if (ts.isImportTypeNode(type)) {
    const q = type.qualifier;
    return !!q && (ts.isIdentifier(q) ? q.text : q.right.text) === "ConversationTool";
  }
  return false;
}

function isConversationToolArrayType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isArrayTypeNode(type)) return isConversationToolType(type.elementType);
  if (ts.isTypeOperatorNode(type)) return isConversationToolArrayType(type.type);
  if (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    (type.typeName.text === "Array" || type.typeName.text === "ReadonlyArray") &&
    type.typeArguments?.[0]
  ) {
    return isConversationToolType(type.typeArguments[0]);
  }
  return false;
}

function hasInputSchema(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (prop) =>
      ts.isSpreadAssignment(prop) ||
      (prop.name !== undefined && propertyNameText(prop.name) === "inputSchema"),
  );
}

export function toolSchemaHits(sf: ts.SourceFile): RuleHit[] {
  const literals: ts.ObjectLiteralExpression[] = [];
  const asLiteral = (expr: ts.Expression | undefined) => {
    if (!expr) return;
    const value = unwrap(expr);
    if (ts.isObjectLiteralExpression(value)) literals.push(value);
  };
  const returnsOf = (fn: ts.SignatureDeclaration & { body?: ts.Node | undefined }) => {
    const body = fn.body;
    if (!body) return;
    if (ts.isArrowFunction(fn) && ts.isExpression(body)) {
      asLiteral(body);
      return;
    }
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node)) asLiteral(node.expression);
      if (ts.isFunctionLike(node)) return;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (isConversationToolType(node.type)) asLiteral(node.initializer);
      else if (isConversationToolArrayType(node.type)) {
        const value = unwrap(node.initializer);
        if (ts.isArrayLiteralExpression(value)) for (const el of value.elements) asLiteral(el);
      }
    } else if (ts.isSatisfiesExpression(node) && isConversationToolType(node.type)) {
      asLiteral(node.expression);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) &&
      isConversationToolType(node.type)
    ) {
      returnsOf(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(literals)]
    .filter((literal) => !hasInputSchema(literal))
    .map((literal) => ({
      line: lineOf(sf, literal),
      what: "ConversationTool without inputSchema",
    }));
}
