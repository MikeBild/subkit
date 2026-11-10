import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createIntakeItem } from "../../apps/engine/src/knowledge/index.ts";
import { createDeterministicUuidFactory } from "../../apps/engine/src/test-helpers/determinism/ids.ts";
import { ptyFailureDiagnostic, runPtyScenario, SKIP_PTY } from "./_helpers/pty.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv | null = null;
const nextRequestId = createDeterministicUuidFactory(0x1a7e);

beforeAll(async () => {
  if (SKIP_PTY) return;
  env = await boot("repl-pending-intake-first-paint", { llm: "mock" });
  for (let i = 0; i < 2; i++) {
    await createIntakeItem(
      {
        tenant_id: env.tenantId,
        actor: { kind: "user", id: env.personas.admin.userId },
        client_request_id: nextRequestId(),
        category: "inbox",
        title: `Collected item ${i}`,
        source_url: `https://example.test/repl-first-paint/${i}`,
        captured_at: "2026-01-01T00:00:00.000Z",
        body: `Collected body ${i}`,
      },
      env.db,
    );
  }
}, 90_000);

afterAll(async () => {
  await shutdown(env ?? undefined);
}, 30_000);

describe("e2e: sk REPL pending intake first paint", () => {
  test.skipIf(SKIP_PTY)(
    "the flushed welcome banner already shows the category-aware review row on first paint",
    async () => {
      if (!env) throw new Error("env not booted");
      const REVIEW_ROW = "Review 2 collected items in “inbox”";
      const r = await runPtyScenario(
        [
          { kind: "wait", pattern: REVIEW_ROW, label: "intake-review-row" },
          { kind: "ready" },
          { kind: "send", text: "\x04" },
        ],
        { persona: env.personas.admin, engineUrl: env.baseUrl },
      );
      expect(r.exitCode, ptyFailureDiagnostic(r)).toBe(0);
      expect(r.visible).toContain(REVIEW_ROW);
    },
    20_000,
  );
});
