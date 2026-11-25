import { describe, expect, test } from "bun:test";
import {
  backoffHelperHits,
  canonicalHashHelperHits,
  emptyCatchHits,
  httpErrorThrowHits,
  isApiInternalImport,
  statusWriterHits,
  thenWithAwaitHits,
} from "../audit/code-shape.ts";
import { parseSource } from "../audit/imports.ts";

const src = (text: string) => parseSource("apps/engine/src/sample.ts", text);
const whats = (hits: Array<{ what: string }>) => hits.map((hit) => hit.what);

describe("statusWriterHits", () => {
  const file = "apps/engine/src/elsewhere.ts";

  test("flags a status write outside the table's writer", () => {
    const sf = src(`
      await db.update(patchCandidates).set({ status: "rejected", updated_at: now }).where(x);
      await tx.update(intakeItems).set({ state: "reviewing" });
      await tx.update(conversations).set({ ...(open ? { status: "active" } : {}) });
    `);
    expect(whats(statusWriterHits(file, sf))).toEqual([
      "patchCandidates.status",
      "intakeItems.state",
      "conversations.status",
    ]);
  });

  test("ignores other columns, other tables and the writer itself", () => {
    const sf = src(`
      await db.update(patchCandidates).set({ updated_at: now });
      await db.update(workflows).set({ status: "active" });
    `);
    expect(statusWriterHits(file, sf)).toEqual([]);
    const writer = src(`await db.update(executions).set({ status: "queued" });`);
    expect(whats(statusWriterHits(file, writer))).toEqual(["executions.status"]);
    expect(statusWriterHits("apps/engine/src/execution/state.ts", writer)).toEqual([]);
  });
});

describe("emptyCatchHits", () => {
  test("flags empty catch blocks and empty catch handlers", () => {
    const sf = src(`
      try { a(); } catch {}
      try { b(); } catch (err) {}
      p.catch(() => {});
      q.catch(() => undefined);
    `);
    expect(whats(emptyCatchHits(sf))).toEqual([
      "catch {}",
      "catch {}",
      ".catch(() => {})",
      ".catch(() => {})",
    ]);
  });

  test("accepts catches that log, return or rethrow", () => {
    const sf = src(`
      try { a(); } catch { return false; }
      try { b(); } catch (err) { logger.warn({ err }); }
      p.catch((err) => logger.warn({ err }));
    `);
    expect(emptyCatchHits(sf)).toEqual([]);
  });
});

describe("thenWithAwaitHits", () => {
  test("flags .then only when the file also awaits", () => {
    expect(whats(thenWithAwaitHits(src("async function f() { await a(); b().then(c); }")))).toEqual(
      [".then("],
    );
    expect(thenWithAwaitHits(src("function f() { return b().then(c); }"))).toEqual([]);
  });
});

describe("canonicalHashHelperHits", () => {
  test("flags key-sorting JSON serializers and sha256 helpers", () => {
    const sf = src(`
      function stableStringify(v) {
        return JSON.stringify(v, Object.keys(v).sort());
      }
      const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
      function digest(s) { return createHash("md5").update(s).digest("hex"); }
      function render(v) { return JSON.stringify(v); }
    `);
    expect(whats(canonicalHashHelperHits(sf))).toEqual([
      "canonical JSON stableStringify",
      "sha256 sha256Hex",
    ]);
  });
});

describe("backoffHelperHits", () => {
  test("flags backoff and Retry-After helpers by name", () => {
    const sf = src(`
      function backoffMs(n) { return n * 2; }
      const parseRetryAfter = (h) => Number(h);
      const BACKOFF_MAX_MS = 10;
      function retry() {}
    `);
    expect(whats(backoffHelperHits(sf))).toEqual(["backoff backoffMs", "backoff parseRetryAfter"]);
  });
});

describe("httpErrorThrowHits", () => {
  test("counts every HttpError construction", () => {
    const sf = src(`throw new HttpError(404, "x"); const e = new Error("y");`);
    expect(whats(httpErrorThrowHits(sf))).toEqual(["new HttpError"]);
  });
});

describe("isApiInternalImport", () => {
  test("accepts only the api entry point", () => {
    expect(isApiInternalImport("apps/engine/src/api/index.ts")).toBe(false);
    expect(isApiInternalImport("apps/engine/src/api/operations/hono.ts")).toBe(true);
    expect(isApiInternalImport("apps/engine/src/auth/index.ts")).toBe(false);
  });
});
