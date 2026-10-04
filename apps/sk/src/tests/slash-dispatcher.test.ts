import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  _localOnlySnapshot,
  classifySlash,
  INK_INTERCEPTED_LOCAL_SLASHES,
} from "../repl/slash/dispatcher.ts";

describe("classifySlash", () => {
  test("/help routes locally", () => {
    expect(classifySlash("help").routing).toBe("local");
  });

  test("/clear routes locally", () => {
    expect(classifySlash("clear").routing).toBe("local");
  });

  test("/audit routes through the engine (audit row required)", () => {
    expect(classifySlash("audit").routing).toBe("engine");
  });

  test("/connector routes through the engine (state-mutating)", () => {
    expect(classifySlash("connector").routing).toBe("engine");
  });

  test("unknown commands resolve to `unknown`", () => {
    expect(classifySlash("definitely-not-a-cmd").routing).toBe("unknown");
  });

  test("local-only set is non-empty and includes the canonical reads", () => {
    const snap = _localOnlySnapshot();
    expect(snap.length).toBeGreaterThan(0);
    expect(snap).toContain("help");
    expect(snap).toContain("clear");
  });

  test("derives local routing from each command's `routing` field, not a name list", () => {
    const snap = _localOnlySnapshot();
    for (const eng of ["audit", "connectors", "workflows", "approve", "reject"]) {
      expect(snap).not.toContain(eng);
    }
  });

  test("every routing:'local' command has a handler case OR sub-dispatcher entry OR is Ink-intercepted", () => {
    const handlerSrc = readFileSync("apps/sk/src/repl/slash/handler.ts", "utf8");
    const subDispatcherSrcs: string[] = [
      readFileSync("apps/sk/src/repl/slash/handlers/admin-lists.ts", "utf8"),
      readFileSync("apps/sk/src/repl/slash/handlers/inspect.ts", "utf8"),
      readFileSync("apps/sk/src/repl/slash/handlers/auth-redirects.ts", "utf8"),
    ];
    const intercepted = new Set<string>(INK_INTERCEPTED_LOCAL_SLASHES);
    const violations: string[] = [];
    for (const name of _localOnlySnapshot()) {
      if (intercepted.has(name)) continue;
      const caseRe = new RegExp(`case\\s+"${name}"\\s*:`);
      const inHandler = caseRe.test(handlerSrc);
      const inSubDispatcher = subDispatcherSrcs.some((src) => caseRe.test(src));
      if (!inHandler && !inSubDispatcher) {
        violations.push(
          `/${name}: no handler case, no sub-dispatcher entry, not in INK_INTERCEPTED_LOCAL_SLASHES`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test("every routing:'engine' command is reachable via handler / sub-dispatcher / Ink intercept", async () => {
    const { SLASH_COMMANDS, INK_INTERCEPTED_ENGINE_SLASHES } = await import("../slash.ts");
    const handlerSrc = readFileSync("apps/sk/src/repl/slash/handler.ts", "utf8");
    const subDispatcherSrcs: string[] = [
      readFileSync("apps/sk/src/repl/slash/handlers/admin-lists.ts", "utf8"),
      readFileSync("apps/sk/src/repl/slash/handlers/inspect.ts", "utf8"),
      readFileSync("apps/sk/src/repl/slash/handlers/auth-redirects.ts", "utf8"),
    ];
    const inkIntercepted = new Set<string>(INK_INTERCEPTED_ENGINE_SLASHES);
    const violations: string[] = [];
    for (const cmd of SLASH_COMMANDS) {
      const routing = cmd.routing ?? "engine";
      if (routing !== "engine") continue;
      if (inkIntercepted.has(cmd.name)) continue;
      const caseRe = new RegExp(`case\\s+"${cmd.name}"\\s*:`);
      const wordRe = new RegExp(`\\b${cmd.name.replace(/-/g, "\\-")}\\b`);
      const inHandler = caseRe.test(handlerSrc);
      const inSubDispatcher = subDispatcherSrcs.some((src) => caseRe.test(src) || wordRe.test(src));
      if (!inHandler && !inSubDispatcher) {
        violations.push(
          `/${cmd.name}: no handler case, no sub-dispatcher entry, not in INK_INTERCEPTED_ENGINE_SLASHES`,
        );
      }
    }
    expect(violations).toEqual([]);
  });
});
