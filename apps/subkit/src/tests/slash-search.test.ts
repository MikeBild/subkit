import { describe, expect, test } from "bun:test";
import { type PersonaProbe, searchSlashCommands } from "../slash.ts";

const adminPersona: PersonaProbe = { allows: () => true };
const enduserPersona: PersonaProbe = {
  allows: (p) =>
    new Set([
      "conversation:read",
      "conversation:write",
      "conversation:cancel",
      "conversation:list",
    ]).has(p),
};

describe("subkit slash search", () => {
  test("empty query returns the full persona-visible catalog up to the limit", () => {
    const all = searchSlashCommands("", adminPersona, 3);
    expect(all.length).toBe(3);
    expect(all[0]?.name).toBeDefined();
  });

  test("prefix match ranks an exact name at the top", () => {
    const hits = searchSlashCommands("mem", adminPersona);
    expect(hits[0]?.name).toBe("memory");
  });

  test("alias match still resolves (`quit` → `exit`)", () => {
    const hits = searchSlashCommands("qui", adminPersona);
    expect(hits.find((h) => h.name === "exit")).toBeDefined();
  });

  test("persona filter hides commands the enduser cannot run", () => {
    const hits = searchSlashCommands("audit", enduserPersona);
    expect(hits.find((h) => h.name === "audit")).toBeUndefined();
  });

  test("typos do not match prefix-only search", () => {
    const hits = searchSlashCommands("compct", adminPersona);
    expect(hits.find((h) => h.name === "compact")).toBeUndefined();
  });

  test("leading slash is stripped before searching", () => {
    const withSlash = searchSlashCommands("/memo", adminPersona);
    const noSlash = searchSlashCommands("memo", adminPersona);
    expect(withSlash.map((c) => c.name)).toEqual(noSlash.map((c) => c.name));
  });
});
