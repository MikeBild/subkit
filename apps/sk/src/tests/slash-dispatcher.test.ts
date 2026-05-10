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

  // R1-S2 / R2-W4 regression: the dispatcher must classify by the
  // command's `routing` field, not by raw name. If a future writer
  // adds a slash named e.g. `/audit` with `routing: "local"` the
  // engine-side audit row goes missing — this test pins that the
  // *registry* is the source, so any such mistake shows up here as
  // well as in code review.
  test("derives local routing from each command's `routing` field, not a name list", () => {
    const snap = _localOnlySnapshot();
    // Engine-routed commands must NOT appear in the local snapshot.
    for (const eng of ["audit", "connectors", "workflows", "approve", "reject"]) {
      expect(snap).not.toContain(eng);
    }
  });

  // R6-W2 review fix: every `routing: "local"` slash MUST either have
  // a `case "<name>":` branch in `apps/sk/src/repl/slash/handler.ts`
  // OR be on the `INK_INTERCEPTED_LOCAL_SLASHES` allow-list (because
  // the Ink host intercepts it before dispatch). Without this contract,
  // a future `routing: "local"` slash with no handler case falls
  // through to the generic "not wired" banner in the readline REPL.
  test("every routing:'local' command has a handler case OR is Ink-intercepted", () => {
    const handlerSrc = readFileSync("apps/sk/src/repl/slash/handler.ts", "utf8");
    const intercepted = new Set<string>(INK_INTERCEPTED_LOCAL_SLASHES);
    const violations: string[] = [];
    for (const name of _localOnlySnapshot()) {
      if (intercepted.has(name)) continue;
      const re = new RegExp(`case\\s+"${name}"\\s*:`);
      if (!re.test(handlerSrc)) {
        violations.push(`/${name}: no handler case AND not in INK_INTERCEPTED_LOCAL_SLASHES`);
      }
    }
    expect(violations).toEqual([]);
  });

  // R11-S1 review fix: mirror of the routing:"local" contract for
  // routing:"engine". Every engine-routed slash MUST be reachable
  // via one of:
  //   1. a `case "<name>":` branch in `handler.ts`
  //   2. a per-category sub-dispatcher (admin-lists / inspect /
  //      install-wizards / auth-redirects)
  //   3. the `INK_INTERCEPTED_ENGINE_SLASHES` allow-list (the Ink
  //      host short-circuits before dispatch — /approve, /yolo, etc.)
  // Without this contract a future engine-routed slash would
  // silently fall through to the "not wired — try /help" banner
  // when the readline REPL receives it.
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
      // Sub-dispatchers using a `Record<string, string>` lookup
      // (install-wizards, auth-redirects) declare the name as a
      // property key (`login: "..."`) — match any word-boundary
      // occurrence of the bare identifier. False-positive risk is
      // low because slash names are 4-20 chars of letters/dashes.
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
