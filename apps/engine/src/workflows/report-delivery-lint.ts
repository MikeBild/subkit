import type { ts as TsApi } from "ts-morph";
import { isAbsoluteUrl, resolveUrl } from "../connectors/drivers/resolve-url.ts";
import { loadTs } from "./js-body-lint.ts";
import {
  hasRuntimeValue,
  inspectReportMessage,
  REPORT_ENVELOPE_HEADERS,
  REPORT_RECIPIENT_HEADERS_REFUSED,
  type ReportMessageRefusal,
  supportsReportDelivery,
} from "./report-delivery-boundary.ts";
import type { RequestStep, StepDef } from "./types.ts";

interface ReportDeliveryLintError {
  path: string;
  message: string;
}

interface MessageFinding {
  rule: ReportMessageRefusal;
  detail: string;
}

const REFUSED_HEADER_BY_KEY = new Map<string, string>(
  REPORT_RECIPIENT_HEADERS_REFUSED.map((name) => [name.toLowerCase(), name]),
);
const BUILDER_RECIPIENT_OPTIONS: Readonly<Record<string, string>> = {
  cc: "Cc",
  bcc: "Bcc",
  replyTo: "Reply-To",
};
const ALLOWED_HEADER_KEYS = new Set(REPORT_ENVELOPE_HEADERS.map((name) => name.toLowerCase()));
const HEADER_LINE = new RegExp(
  `(?:^|\\n)(${REPORT_RECIPIENT_HEADERS_REFUSED.map((name) => name.replace("-", "\\-")).join("|")})[ \\t]*:`,
  "gi",
);
const SCOPE_PLACEHOLDER = /\$\{\s*scope\.([A-Za-z0-9_-]+)[.}\s]/g;
const SCOPE_READ = /\binput\.scope\.([A-Za-z_][A-Za-z0-9_]*)/g;

function sendTargets(step: RequestStep, baseUrls: ReadonlyArray<string>): string[] {
  const pathOrUrl = step.connector_id ? (step.path ?? step.url) : step.url;
  if (!pathOrUrl) return [];
  const bases: Array<string | null> = isAbsoluteUrl(pathOrUrl) ? [null] : [...baseUrls];
  return bases.flatMap((base) => {
    try {
      const url = resolveUrl(base, pathOrUrl);
      return [`${url.origin}${url.pathname}`];
    } catch {
      return [];
    }
  });
}

function isGovernedReportDelivery(step: RequestStep, baseUrls: ReadonlyArray<string>): boolean {
  if ((step.transactional_delivery || step.outbox_delivery) && !step.report_delivery) return false;
  if (step.report_delivery) return true;
  return sendTargets(step, baseUrls).some((target) => supportsReportDelivery(step, target));
}

function propertyName(ts: typeof TsApi, name: TsApi.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return null;
}

function isAbsent(ts: typeof TsApi, node: TsApi.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === "undefined")
  );
}

function builderFindings(
  ts: typeof TsApi,
  options: TsApi.ObjectLiteralExpression,
  out: MessageFinding[],
): void {
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const key = propertyName(ts, property.name);
    if (key === null) continue;
    const value = ts.isPropertyAssignment(property) ? property.initializer : null;
    const header = BUILDER_RECIPIENT_OPTIONS[key];
    if (header && !(value && isAbsent(ts, value))) {
      out.push({ rule: "header_not_allowed", detail: `sets ${header} via sk.buildMimeMessage` });
      continue;
    }
    if (key === "to" && value && ts.isArrayLiteralExpression(value) && value.elements.length > 1) {
      out.push({ rule: "extra_recipients", detail: "passes more than one To recipient" });
      continue;
    }
    if (key === "headers" && value && ts.isObjectLiteralExpression(value)) {
      for (const extra of value.properties) {
        if (!ts.isPropertyAssignment(extra) && !ts.isShorthandPropertyAssignment(extra)) continue;
        const name = propertyName(ts, extra.name);
        if (name === null) continue;
        out.push(
          ALLOWED_HEADER_KEYS.has(name.toLowerCase())
            ? { rule: "header_duplicate", detail: `repeats the ${name} header` }
            : {
                rule: "header_not_allowed",
                detail: `adds the ${REFUSED_HEADER_BY_KEY.get(name.toLowerCase()) ?? name} header`,
              },
        );
      }
    }
  }
}

function literalFindings(text: string, out: MessageFinding[]): void {
  for (const match of text.matchAll(HEADER_LINE)) {
    const header = REFUSED_HEADER_BY_KEY.get(match[1]!.toLowerCase()) ?? match[1]!;
    out.push({ rule: "header_not_allowed", detail: `writes a ${header}: header line` });
  }
}

function transformFindings(code: string): MessageFinding[] {
  const ts = loadTs();
  const sourceFile = ts.createSourceFile(
    "transform.js",
    `function __sk_transform__(input) {\n${code}\n}`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const out: MessageFinding[] = [];
  const visit = (node: TsApi.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const options = node.arguments[0];
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "buildMimeMessage" &&
        options &&
        ts.isObjectLiteralExpression(options)
      )
        builderFindings(ts, options, out);
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      literalFindings(node.text, out);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function upstreamTransforms(
  raw: string,
  steps: ReadonlyMap<string, StepDef>,
): Array<{ id: string; expression: string }> {
  const pending = [...raw.matchAll(SCOPE_PLACEHOLDER)].map((match) => match[1]!);
  const seen = new Set<string>();
  const out: Array<{ id: string; expression: string }> = [];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = steps.get(id);
    if (step?.kind !== "transform" || (step.language ?? "javascript") !== "javascript") continue;
    if (typeof step.expression !== "string" || step.expression.length === 0) continue;
    out.push({ id, expression: step.expression });
    for (const match of step.expression.matchAll(SCOPE_READ)) pending.push(match[1]!);
  }
  return out;
}

function errorMessage(finding: MessageFinding, source: string): string {
  return `governed report delivery refuses this message (rule ${finding.rule}): ${source} ${finding.detail}. Only the headers ${REPORT_ENVELOPE_HEADERS.join(", ")} and exactly one To recipient are allowed — drop ${REPORT_RECIPIENT_HEADERS_REFUSED.join("/")} and send one message per recipient.`;
}

export function reportDeliveryLintErrors(
  steps: ReadonlyArray<StepDef>,
  connectorBaseUrls: ReadonlyMap<string, ReadonlyArray<string>> | undefined,
): ReportDeliveryLintError[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const errors: ReportDeliveryLintError[] = [];
  for (const step of steps) {
    if (step.kind !== "request") continue;
    const body = step.body as { raw?: unknown } | null | undefined;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.raw !== "string")
      continue;
    const raw = body.raw;
    if (!isGovernedReportDelivery(step, connectorBaseUrls?.get(step.connector_id ?? "") ?? []))
      continue;
    const path = `steps.${step.id}.body.raw`;
    if (!hasRuntimeValue(raw)) {
      const inspection = inspectReportMessage({ raw });
      if (!inspection.ok)
        errors.push({
          path,
          message: errorMessage(
            { rule: inspection.reason, detail: "is not an accepted report message" },
            "the literal raw message",
          ),
        });
      continue;
    }
    const seen = new Set<string>();
    for (const transform of upstreamTransforms(raw, byId)) {
      for (const finding of transformFindings(transform.expression)) {
        const key = `${finding.rule}\u0000${finding.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        errors.push({ path, message: errorMessage(finding, `transform "${transform.id}"`) });
      }
    }
  }
  return errors;
}
