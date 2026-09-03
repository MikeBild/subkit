// `engine --smoke`: validate logger, audit redaction and the QuickJS embed
// on a binary that has not been configured yet.
//
// Extracted from `index.ts` because that file sits at its 1000-LOC invariant
// ceiling (`file_size` in `apps/engine/scripts/audit-invariants.ts`), and a
// self-contained one-shot mode is the easiest 80 lines for an entrypoint to
// stop carrying. Behaviour is unchanged; the operator contract is still
// `engine --smoke` exiting 0 on success and 1 on the QuickJS check.

import { logger } from "./logging/logger.ts";

export async function runSmoke(): Promise<void> {
  // Read raw process.env. Importing `./env.ts` would trigger the lazy
  // EnvSchema parse on first property access — and the smoke binary
  // must run without DATABASE_URL/MASTER_KEY (matrix smoke step in
  // release.yml only sets the bare minimum, and operators sanity-check
  // a fresh download with `engine --smoke` before configuring anything).
  const node_env = process.env.NODE_ENV ?? "development";
  const port = Number(process.env.PORT ?? "3000");
  logger.info({
    module: "engine",
    action: "smoke.started",
    msg: "smoke mode: validating logger + audit + redaction",
    node_env,
    port,
  });

  // System-level startup: logger.info is the durable record.
  // `audit_log.tenant_id` is a NOT NULL uuid FK, so a synthetic
  // "system" value would fail the insert. If we ever need a real
  // audit row for startup, a dedicated `system_audit_log` without
  // a tenant column is the right shape — tracked separately.

  logger.info({
    module: "engine",
    action: "redaction.test",
    msg: "this line contains a secret that must be redacted",
    headers: {
      authorization: "Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      cookie: "session=abc123",
    },
    body_preview: "token=wf_live_abcdef1234567890",
    note: "Bearer should be stripped inside this free-form string too",
  });

  logger.info({
    module: "engine",
    action: "redaction.test.done",
    msg: "redaction smoke line emitted",
  });

  // QuickJS WASM embed check — the load-bearing guard. JS transforms run
  // in a QuickJS sandbox whose WASM must be INLINED into the compiled
  // binary (single-file variant); the separate-.wasm variant silently
  // survives `bun test` but throws ENOENT on the compiled binary,
  // breaking every JS-authored workflow at runtime in prod. Exercising
  // one JS transform here fails the release BEFORE deploy if the embed
  // ever regresses.
  const { runJs } = await import("./sandboxes/quickjs/runtime.ts");
  const js = await runJs({
    code: "return input.scope.v.data * 2;",
    input: { scope: { v: { data: 21 } }, input: null },
    limits: { wall_ms: 1000 },
    // Smoke check with no execution context — intentionally-constant clock.
    clock: null,
  });
  if (js.output !== 42) {
    logger.error({
      module: "engine",
      action: "smoke.quickjs_failed",
      msg: "QuickJS JS-transform sandbox did not execute in the compiled binary — WASM embed regressed",
      output: js.output,
    });
    process.exit(1);
  }
  logger.info({
    module: "engine",
    action: "smoke.quickjs_ok",
    msg: "QuickJS JS-transform sandbox executed in the compiled binary",
  });

  logger.info({
    module: "engine",
    action: "smoke.completed",
    msg: "smoke mode: exit 0",
  });
}
