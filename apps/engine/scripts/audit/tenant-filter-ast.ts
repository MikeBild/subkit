//   2. The `.from(...)` call has a `// tenant-filter:exempt — <reason>`
//      comment in its leading trivia or trailing comment. Reason must be
//      non-empty; intentionally cross-tenant call sites (slug-based webhook
//      routing, prefix-based API key lookup, pre-tenant onboarding) carry
//      this annotation.
//   3. The chained `.where(...)` / `.having(...)` argument tree references
//      `tenant_id` / `tenantId` (literal predicate or nested through a
//      helper whose argument tree contains the identifier).
//   4. The chained `.where(...)` / `.having(...)` argument tree contains a
//      call to a function whose name matches /tenant/i (helper convention
//      — e.g. `buildTenantWhere(...)` or `withTenantScope(...)`).
//
// Anything else is flagged. The script reads as a library so unit tests
// can drive it with synthetic source text.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type CallExpression, Node, Project, type SourceFile } from "ts-morph";

export interface TenantFilterViolation {
  file: string;
  line: number;
  table: string;
}

export interface AuditOpts {
  repoRoot: string;
  engineSrc: string;
  tableAllowlist: ReadonlySet<string>;
}

const QUERY_STARTERS = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "update",
  "delete",
  "insert",
  "with",
  "$with",
]);

// Reason is mandatory: a `// tenant-filter:exempt` with no explanation
// silently disables the audit at the call site, which is exactly the
// failure mode the gate exists to prevent. The non-greedy `\S` after
// the separator forces at least one non-space character.
const EXEMPT_RE = /\btenant-filter:\s*exempt\b\s*[-—:]\s*\S/;

const MAX_CHAIN_SCAN_LINES = 12;
const TODO_REASON_RE = /\b(?:TODO|FIXME|XXX|HACK)\b/;
const TENANT_ID_NAMES = new Set(["tenant_id", "tenantId"]);

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (
          name === "node_modules" ||
          name === "dist" ||
          name === ".turbo" ||
          name === "tests" ||
          name === "test-helpers" ||
          name === "__tests__"
        )
          continue;
        stack.push(p);
      } else if (
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".d.ts") &&
        !p.split("/").includes("scripts")
      ) {
        out.push(p);
      }
    }
  }
  return out;
}

function isQueryStarter(node: Node | undefined): boolean {
  let cur = node;
  while (cur) {
    if (Node.isCallExpression(cur)) {
      const e = cur.getExpression();
      if (Node.isPropertyAccessExpression(e)) {
        if (QUERY_STARTERS.has(e.getName())) return true;
        cur = e.getExpression();
        continue;
      }
      if (Node.isIdentifier(e)) {
        return QUERY_STARTERS.has(e.getText());
      }
      return false;
    }
    if (Node.isPropertyAccessExpression(cur)) {
      cur = cur.getExpression();
      continue;
    }
    if (Node.isParenthesizedExpression(cur)) {
      cur = cur.getExpression();
      continue;
    }
    if (Node.isAwaitExpression(cur)) {
      cur = cur.getExpression();
      continue;
    }
    return false;
  }
  return false;
}

function resolveTableArg(arg: Node): string | undefined {
  if (Node.isIdentifier(arg)) return arg.getText();
  if (Node.isPropertyAccessExpression(arg)) return arg.getName();
  if (Node.isParenthesizedExpression(arg)) return resolveTableArg(arg.getExpression());
  if (Node.isAsExpression(arg)) return resolveTableArg(arg.getExpression());
  return undefined;
}

function exemptMatches(text: string): boolean {
  return EXEMPT_RE.test(text) && !TODO_REASON_RE.test(text);
}

function hasExemptComment(call: CallExpression, sourceText: string): boolean {
  const start = call.getStart();
  const end = call.getEnd();
  const lineEnd = sourceText.indexOf("\n", end);
  const after = sourceText.substring(end, lineEnd === -1 ? sourceText.length : lineEnd);
  if (exemptMatches(after)) return true;
  let cur: Node | undefined = call;
  while (cur) {
    if (Node.isStatement(cur) || Node.isVariableStatement(cur)) {
      const leading = sourceText.substring(cur.getFullStart(), cur.getStart());
      if (exemptMatches(leading)) return true;
      break;
    }
    cur = cur.getParent();
  }
  let scanFrom = start;
  for (let i = 0; i < MAX_CHAIN_SCAN_LINES; i++) {
    const prevNewline = sourceText.lastIndexOf("\n", scanFrom - 1);
    if (prevNewline === -1) break;
    const lineStartPos = sourceText.lastIndexOf("\n", prevNewline - 1) + 1;
    const lineSlice = sourceText.substring(lineStartPos, prevNewline);
    if (exemptMatches(lineSlice)) return true;
    const trimmed = lineSlice.trim();
    const isContinuation =
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith(".") ||
      trimmed.startsWith("await ") ||
      trimmed.endsWith("(") ||
      trimmed.endsWith(",") ||
      trimmed.endsWith("&&") ||
      trimmed.endsWith("||") ||
      trimmed.endsWith("??") ||
      trimmed === "(" ||
      trimmed === ")";
    if (!isContinuation) break;
    scanFrom = lineStartPos;
  }
  return false;
}

const TENANT_NAMED_RE = /tenant/i;

function nodeIsTenantSignal(n: Node, fileTenantHelpers: ReadonlySet<string>): boolean {
  if (Node.isIdentifier(n)) {
    const name = n.getText();
    if (TENANT_ID_NAMES.has(name)) return true;
    if (TENANT_NAMED_RE.test(name)) return true;
  }
  if (Node.isPropertyAccessExpression(n)) {
    const name = n.getName();
    if (TENANT_ID_NAMES.has(name)) return true;
    if (TENANT_NAMED_RE.test(name)) return true;
  }
  if (Node.isCallExpression(n)) {
    const e = n.getExpression();
    const callName = Node.isPropertyAccessExpression(e)
      ? e.getName()
      : Node.isIdentifier(e)
        ? e.getText()
        : "";
    if (callName && TENANT_NAMED_RE.test(callName)) return true;
    if (callName && fileTenantHelpers.has(callName)) return true;
  }
  return false;
}

function whereArgRefsTenant(node: Node, fileTenantHelpers: ReadonlySet<string>): boolean {
  if (nodeIsTenantSignal(node, fileTenantHelpers)) return true;
  let found = false;
  node.forEachDescendant((d, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    if (nodeIsTenantSignal(d, fileTenantHelpers)) found = true;
  });
  return found;
}

// match /tenant/i or carry a `// tenant-filter:exempt` annotation at
// each call site.
function collectTenantHelperNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    if (functionBodyMentionsTenant(fn)) names.add(name);
  }
  for (const v of sourceFile.getVariableDeclarations()) {
    const init = v.getInitializer();
    if (!init) continue;
    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      if (functionBodyMentionsTenant(init)) names.add(v.getName());
    }
  }
  return names;
}

function functionBodyMentionsTenant(fn: Node): boolean {
  let found = false;
  fn.forEachDescendant((d, traversal) => {
    if (found) {
      traversal.stop();
      return;
    }
    if (Node.isIdentifier(d) && TENANT_ID_NAMES.has(d.getText())) {
      found = true;
      return;
    }
    if (Node.isPropertyAccessExpression(d) && TENANT_ID_NAMES.has(d.getName())) {
      found = true;
    }
  });
  return found;
}

function chainHasTenantWhere(
  fromCall: CallExpression,
  fileTenantHelpers: ReadonlySet<string>,
): boolean {
  let cur: Node = fromCall;
  for (;;) {
    const parent = cur.getParent();
    if (!parent) return false;
    if (!Node.isPropertyAccessExpression(parent)) return false;
    if (parent.getExpression() !== cur) return false;
    const grand = parent.getParent();
    if (!grand || !Node.isCallExpression(grand)) return false;
    if (grand.getExpression() !== parent) return false;
    const name = parent.getName();
    if (name === "where" || name === "having") {
      for (const arg of grand.getArguments()) {
        if (whereArgRefsTenant(arg, fileTenantHelpers)) return true;
      }
    }
    cur = grand;
  }
}

export function auditTenantFilter(opts: AuditOpts): TenantFilterViolation[] {
  const { repoRoot, engineSrc, tableAllowlist } = opts;
  const files = listSourceFiles(engineSrc);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  for (const f of files) project.addSourceFileAtPath(f);

  const violations: TenantFilterViolation[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const rel = relative(repoRoot, sourceFile.getFilePath());
    const sourceText = sourceFile.getFullText();
    const fileTenantHelpers = collectTenantHelperNames(sourceFile);
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      const v = inspectQueryNode(node, {
        rel,
        sourceText,
        sourceFile,
        tableAllowlist,
        fileTenantHelpers,
      });
      if (v) violations.push(v);
    });
  }
  return violations;
}

interface InspectOpts {
  rel: string;
  sourceText: string;
  sourceFile: SourceFile;
  tableAllowlist: ReadonlySet<string>;
  fileTenantHelpers: ReadonlySet<string>;
}

function inspectQueryNode(node: CallExpression, opts: InspectOpts): TenantFilterViolation | null {
  const expr = node.getExpression();
  if (Node.isPropertyAccessExpression(expr)) {
    if (expr.getName() === "from" && isQueryStarter(expr.getExpression())) {
      return reportIfMissing(node, node.getArguments(), opts);
    }
  }
  return null;
}

function reportIfMissing(
  node: CallExpression,
  args: Node[],
  opts: InspectOpts,
): TenantFilterViolation | null {
  if (args.length !== 1) return null;
  const table = resolveTableArg(args[0]!);
  if (!table) return null;
  if (opts.tableAllowlist.has(table)) return null;
  if (hasExemptComment(node, opts.sourceText)) return null;
  if (chainHasTenantWhere(node, opts.fileTenantHelpers)) return null;
  const lineCol = opts.sourceFile.getLineAndColumnAtPos(node.getStart());
  return { file: opts.rel, line: lineCol.line, table };
}

export function auditTenantFilterFromText(
  text: string,
  opts: { tableAllowlist?: ReadonlySet<string>; fileName?: string } = {},
): TenantFilterViolation[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  const fileName = opts.fileName ?? "in-memory.ts";
  const sourceFile = project.createSourceFile(fileName, text);
  const allow = opts.tableAllowlist ?? new Set<string>();
  const violations: TenantFilterViolation[] = [];
  const sourceText = sourceFile.getFullText();
  const fileTenantHelpers = collectTenantHelperNames(sourceFile);
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const v = inspectQueryNode(node, {
      rel: fileName,
      sourceText,
      sourceFile,
      tableAllowlist: allow,
      fileTenantHelpers,
    });
    if (v) violations.push(v);
  });
  return violations;
}
