import type { ts as TsApi } from "ts-morph";
import {
  SANDBOX_GLOBAL_NAMES,
  SANDBOX_SK_FMT_MEMBERS,
  SANDBOX_SK_MEMBERS,
  sandboxDateFormatHint,
  sandboxNumberFormatHint,
} from "../sandboxes/quickjs/stdlib/sandbox-globals.ts";
import { suggestClosest } from "./levenshtein.ts";

type Node = TsApi.Node;

let tsModule: typeof TsApi | undefined;

export function loadTs(): typeof TsApi {
  tsModule ??= (require("ts-morph") as typeof import("ts-morph")).ts;
  return tsModule;
}

export type JsLintCode =
  | "free_identifier"
  | "locale_api"
  | "nondeterministic_api"
  | "host_api"
  | "unknown_sk_member";

export interface JsLintFinding {
  code: JsLintCode;
  identifier: string;
  message: string;
}

const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);

const HOST_API_MESSAGES: Readonly<Record<string, string>> = {
  fetch:
    "there is no network inside a transform. Add a request step and read its result from input.scope.<step_id>.data",
  XMLHttpRequest:
    "there is no network inside a transform. Add a request step and read its result from input.scope.<step_id>.data",
  require: "there are no modules inside a transform. Use the sk.* helpers instead",
  process: "there is no host environment inside a transform. Read workflow input from input.input",
  console:
    "there is no console inside a transform. Return the value (or add it to the returned object) instead of logging it",
  setTimeout: "there are no timers inside a transform. Transforms run synchronously",
  setInterval: "there are no timers inside a transform. Transforms run synchronously",
  queueMicrotask: "there are no timers inside a transform. Transforms run synchronously",
};

function localeMessage(method: string): string {
  return `.${method}() is not available in the transform sandbox: there is no Intl/ECMA-402, so the locale is ignored and the output is wrong. Format numbers with ${sandboxNumberFormatHint()} and dates with ${sandboxDateFormatHint()}.`;
}

function bindingNames(name: TsApi.BindingName, out: Set<string>): void {
  const ts = loadTs();
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingNames(element.name, out);
  }
}

function collectDeclarations(root: Node): Set<string> {
  const ts = loadTs();
  const declared = new Set<string>();
  const visit = (node: Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      bindingNames(node.name, declared);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name
    ) {
      declared.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return declared;
}

function isReferencePosition(node: TsApi.Identifier): boolean {
  const ts = loadTs();
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node)) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) {
    return false;
  }
  if (ts.isMetaProperty(parent)) return false;
  if (ts.isTypeOfExpression(parent)) return false;
  return true;
}

function freeIdentifierMessage(name: string, candidates: ReadonlyArray<string>): string {
  const hint = suggestClosest(name, candidates, 1)[0];
  return `'${name}' is not defined in the transform sandbox${hint ? ` (did you mean '${hint}'?)` : ""}. A transform only receives \`input\` (input.scope.<step_id>.data, input.input, input.scope.$item inside a loop body) plus the sandbox globals and sk.*; declare '${name}' with const/let or read it from input.`;
}

function hasSyntaxErrors(sourceFile: TsApi.SourceFile): boolean {
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ReadonlyArray<unknown> })
    .parseDiagnostics;
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}

export function lintJsBody(code: string): JsLintFinding[] {
  const ts = loadTs();
  const sourceFile = ts.createSourceFile(
    "transform.js",
    `function __sk_transform__(input) {\n${code}\n}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (hasSyntaxErrors(sourceFile)) return [];
  const declared = collectDeclarations(sourceFile);
  declared.delete("__sk_transform__");
  const isGlobal = (name: string): boolean => !declared.has(name) && SANDBOX_GLOBAL_NAMES.has(name);
  const isFree = (name: string): boolean =>
    !declared.has(name) && !SANDBOX_GLOBAL_NAMES.has(name) && name !== "__sk_transform__";
  const candidates = [...declared, ...SANDBOX_GLOBAL_NAMES].filter((n) => n !== "__sk_transform__");
  const findings: JsLintFinding[] = [];
  const seen = new Set<string>();
  const report = (finding: JsLintFinding): void => {
    const key = `${finding.code}:${finding.identifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  const visit = (node: Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      const target = node.expression;
      if (member !== null && LOCALE_METHODS.has(member)) {
        report({ code: "locale_api", identifier: member, message: localeMessage(member) });
      }
      if (member !== null && ts.isIdentifier(target) && isGlobal(target.text)) {
        if (target.text === "Date" && member === "now") {
          report({
            code: "nondeterministic_api",
            identifier: "Date.now",
            message:
              "Date.now() is not deterministic in a transform. Use sk.now() (epoch ms) or sk.nowIso(), the fixed execution timestamp.",
          });
        }
        if (target.text === "Math" && member === "random") {
          report({
            code: "nondeterministic_api",
            identifier: "Math.random",
            message:
              "Math.random() throws in the deterministic sandbox. Use sk.uuid() for ids or derive the value from the input.",
          });
        }
        if (target.text === "sk" && !SANDBOX_SK_MEMBERS.includes(member)) {
          const hint = suggestClosest(member, SANDBOX_SK_MEMBERS, 1)[0];
          report({
            code: "unknown_sk_member",
            identifier: `sk.${member}`,
            message: `sk.${member} is not part of the sandbox stdlib${hint ? ` (did you mean sk.${hint}?)` : ""}. Available: ${SANDBOX_SK_MEMBERS.map((m) => `sk.${m}`).join(", ")}.`,
          });
        }
      }
      if (
        member !== null &&
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === "sk" &&
        isGlobal("sk") &&
        target.name.text === "fmt" &&
        !SANDBOX_SK_FMT_MEMBERS.includes(member)
      ) {
        const alternative = /date|time/i.test(member)
          ? ` Format dates with ${sandboxDateFormatHint()}.`
          : "";
        report({
          code: "unknown_sk_member",
          identifier: `sk.fmt.${member}`,
          message: `sk.fmt.${member} is not part of the sandbox stdlib. Available: ${SANDBOX_SK_FMT_MEMBERS.map((m) => `sk.fmt.${m}`).join(", ")}.${alternative}`,
        });
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report({
        code: "host_api",
        identifier: "import",
        message:
          "import() is not available inside a transform: there are no modules. Use the sk.* helpers instead.",
      });
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      report({
        code: "host_api",
        identifier: "import.meta",
        message: "import.meta is not available inside a transform: there are no modules.",
      });
    }
    if (ts.isIdentifier(node) && isReferencePosition(node) && isFree(node.text)) {
      const name = node.text;
      const host = HOST_API_MESSAGES[name];
      if (name === "Intl") {
        report({
          code: "locale_api",
          identifier: "Intl",
          message: `Intl is not available in the transform sandbox (no ECMA-402). Format numbers with ${sandboxNumberFormatHint()} and dates with ${sandboxDateFormatHint()}.`,
        });
      } else if (host) {
        report({
          code: "host_api",
          identifier: name,
          message: `'${name}' is not available inside a transform: ${host}.`,
        });
      } else {
        report({
          code: "free_identifier",
          identifier: name,
          message: freeIdentifierMessage(name, candidates),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}
