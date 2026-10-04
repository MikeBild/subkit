import { logger } from "./logging/logger.ts";

export async function runSmoke(): Promise<void> {
  const node_env = process.env.NODE_ENV ?? "development";
  const port = Number(process.env.PORT ?? "3000");
  logger.info({
    module: "engine",
    action: "smoke.started",
    msg: "smoke mode: validating logger + audit + redaction",
    node_env,
    port,
  });

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

  const { runJs } = await import("./sandboxes/quickjs/runtime.ts");
  const js = await runJs({
    code: "return input.scope.v.data * 2;",
    input: { scope: { v: { data: 21 } }, input: null },
    limits: { wall_ms: 1000 },
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
