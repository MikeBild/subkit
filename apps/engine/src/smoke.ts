import { readEnv } from "./env.ts";
import { logger } from "./logging/logger.ts";

export async function runSmoke(): Promise<void> {
  const node_env = readEnv("NODE_ENV") ?? "development";
  const port = Number(readEnv("PORT") ?? "3000");
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
    limits: { wall_ms: 10_000 },
    clock: null,
  });
  if (js.output !== 42 || !js.stats.worker_pid || js.stats.worker_pid === process.pid) {
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

  const helpers = await runJs({
    code: 'return sk.money.add("0.1", "0.2");',
    input: null,
    clock: null,
  });
  if (helpers.output !== "0.3") throw new Error("Embedded sandbox helpers failed");
  const { evaluate } = await import("./execution/jsonata-engine.ts");
  if ((await evaluate("$sum($input)", null, { input: [20, 22] })) !== 42)
    throw new Error("JSONata worker smoke failed");
  const { utils, write } = await import("xlsx");
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([["amount"], [42]]), "Smoke");
  const { parseBinaryFile } = await import("./docs-ingestion/parsers/index.ts");
  const parsed = await parseBinaryFile(
    Buffer.from(write(workbook, { type: "buffer", bookType: "xlsx" })),
    "xlsx",
  );
  if (parsed.sheets.Smoke?.[0]?.amount !== 42) throw new Error("Parser worker smoke failed");

  logger.info({
    module: "engine",
    action: "smoke.completed",
    msg: "smoke mode: exit 0",
  });
}
