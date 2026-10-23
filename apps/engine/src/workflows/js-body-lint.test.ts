import { describe, expect, test } from "bun:test";
import { lintJsBody } from "./js-body-lint.ts";

const codes = (code: string) => lintJsBody(code).map((f) => `${f.code}:${f.identifier}`);

describe("lintJsBody", () => {
  test("flags an undeclared identifier and names it", () => {
    const findings = lintJsBody(
      "const rows = input.scope.list.data;\nreturn actionData.map((r) => r.id);",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("free_identifier");
    expect(findings[0]?.identifier).toBe("actionData");
    expect(findings[0]?.message).toContain("'actionData' is not defined");
  });

  test("flags Intl and every toLocale* call with the sk alternative", () => {
    const findings = lintJsBody(
      [
        "const d = new Date(input.input.at);",
        "const a = d.toLocaleDateString('de-DE');",
        "const b = d.toLocaleTimeString();",
        "const c = (1234.5).toLocaleString('de-DE');",
        "const e = d['toLocaleString']();",
        "return [a, b, c, e, new Intl.NumberFormat('de').format(1)];",
      ].join("\n"),
    );
    expect(findings.map((f) => `${f.code}:${f.identifier}`)).toEqual([
      "locale_api:toLocaleDateString",
      "locale_api:toLocaleTimeString",
      "locale_api:toLocaleString",
      "locale_api:Intl",
    ]);
    for (const f of findings) expect(f.message).toContain("sk.fmt.number");
    expect(findings[0]?.message).toMatch(/sk\.(fmt|date)\.(date|format)/);
  });

  test("flags Date.now, Math.random and host APIs", () => {
    expect(
      codes(
        "const t = Date.now(); const r = Math.random(); fetch('x'); const m = require('m'); console.log(process.env); return import('y');",
      ),
    ).toEqual([
      "nondeterministic_api:Date.now",
      "nondeterministic_api:Math.random",
      "host_api:fetch",
      "host_api:require",
      "host_api:console",
      "host_api:process",
      "host_api:import",
    ]);
  });

  test("accepts sk helpers, locals, destructuring, params and the loop item", () => {
    const body = [
      "const { data: rows = [], meta } = input.scope.list_items;",
      "const [first, , ...rest] = rows;",
      "const item = input.scope.$item;",
      "const idx = input.scope.$loop_index;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the authored body is a template literal
      "function label(row, { prefix } = {}) { return `${prefix ?? ''}${row.name}`; }",
      "const byKey = sk.groupBy(rows, (r) => r.kind);",
      "const total = sk.fmt.number(rows.length, { locale: 'de', digits: 0 });",
      "const day = sk.date.format(item.at, 'dd.MM.yyyy', { zone: 'Europe/Berlin' });",
      "outer: for (const r of rest) { if (!r) continue outer; }",
      "try { JSON.parse('{}'); } catch (err) { return { error: String(err) }; }",
      "const obj = { label, total, nested: { key: 1 }, method(a) { return a; }, [idx]: first };",
      "if (typeof undeclaredGuard === 'undefined') { return { obj, byKey, day, meta, now: sk.now(), id: sk.uuid(), b: btoa('x'), args: arguments.length }; }",
      "return Object.entries(byKey).map(([k, v]) => ({ k, n: v.length, s: label(v[0]) }));",
    ].join("\n");
    expect(lintJsBody(body)).toEqual([]);
  });

  test("flags an sk member that does not exist", () => {
    expect(codes("return sk.formatDate(input.input.at);")).toEqual([
      "unknown_sk_member:sk.formatDate",
    ]);
    expect(codes("return sk.fmt.currency(1);")).toEqual(["unknown_sk_member:sk.fmt.currency"]);
  });

  test("a local shadowing a global is not a finding", () => {
    expect(
      codes(
        "const Date = { now: () => 1 }; const sk = { anything: 1 }; return [Date.now(), sk.anything];",
      ),
    ).toEqual([]);
  });

  test("leaves syntax errors to the syntax check", () => {
    expect(lintJsBody("return {")).toEqual([]);
  });
});
