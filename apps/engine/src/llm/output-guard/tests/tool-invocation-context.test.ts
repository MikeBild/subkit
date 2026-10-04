import { describe, expect, it } from "bun:test";
import { runOutputGuard } from "../index.ts";
import { toolScanner } from "../scanners/tool.ts";

const ctx = {};

describe("toolScanner — invocation-context gate (RC1)", () => {
  it("does NOT flag a bare backticked step id with no invocation verb", () => {
    const vs = toolScanner.scan(
      "the step `fetch_confluence_page` returned data successfully.",
      ctx,
    );
    expect(vs).toEqual([]);
  });

  it("does NOT flag an audit-reason token with no invocation verb", () => {
    const vs = toolScanner.scan(
      "audit reason `auto_persist_on_green_dry_run` recorded for this action.",
      ctx,
    );
    expect(vs).toEqual([]);
  });

  it("does NOT flag an error-code reference with no invocation verb", () => {
    const vs = toolScanner.scan(
      "The request failed with error code `slug_conflict_with_live_workflow`.",
      ctx,
    );
    expect(vs).toEqual([]);
  });

  it("does NOT flag a field-name reference with no invocation verb", () => {
    const vs = toolScanner.scan(
      "Check the `output_preview` field for upstream shape evidence.",
      ctx,
    );
    expect(vs).toEqual([]);
  });

  it("flags a phantom tool when preceded by 'call'", () => {
    const vs = toolScanner.scan("I'll call `create_oauth_app` now.", ctx);
    expect(vs.map((v) => v.kind)).toContain("tool.phantom_reference");
    expect(vs[0]?.details?.invented_tool).toBe("create_oauth_app");
  });

  it("flags a phantom tool when preceded by 'running'", () => {
    const vs = toolScanner.scan("running `phantom_step_runner` to validate the config.", ctx);
    expect(vs.map((v) => v.kind)).toContain("tool.phantom_reference");
    expect(vs[0]?.details?.invented_tool).toBe("phantom_step_runner");
  });

  it("flags a phantom tool when preceded by 'invoke'", () => {
    const vs = toolScanner.scan("I will invoke `send_slack_message_to_channel` next.", ctx);
    expect(vs.map((v) => v.kind)).toContain("tool.phantom_reference");
  });

  it("flags a phantom tool when preceded by 'dispatch'", () => {
    const vs = toolScanner.scan("I'll dispatch `trigger_email_notification` for you.", ctx);
    expect(vs.map((v) => v.kind)).toContain("tool.phantom_reference");
  });

  it("flags a phantom tool when preceded by 'trigger'", () => {
    const vs = toolScanner.scan("triggering `run_async_job_queue` now.", ctx);
    expect(vs.map((v) => v.kind)).toContain("tool.phantom_reference");
  });

  it("flags a phantom tool when preceded by 'prompting'", () => {
    const vs = toolScanner.scan("prompting `phantom_form_tool` to collect details.", ctx);
    expect(vs.map((v) => v.kind)).toContain("tool.phantom_reference");
    expect(vs[0]?.details?.invented_tool).toBe("phantom_form_tool");
  });

  it("does NOT flag when the token IS a registered tool even in invocation context", () => {
    const vs = toolScanner.scan("I'll call `create_api_key` to mint a key.", ctx);
    expect(vs).toEqual([]);
  });

  it("does NOT flag a backtick token that is too short to look like a tool name", () => {
    const vs = toolScanner.scan("call `run` now.", ctx);
    expect(vs).toEqual([]);
  });

  it("does NOT flag a token that is on the allow-list even in invocation context", () => {
    const vs = toolScanner.scan("I'll call `json` now.", ctx);
    expect(vs).toEqual([]);
  });
});

describe("runOutputGuard soft-rewrite — tool.phantom_reference strips backticks (RC1)", () => {
  it("strips backticks around the phantom token instead of deleting the full span", () => {
    const result = runOutputGuard("I'll call `phantom_tool_xyz` now.", ctx, { mode: "soft" });
    expect(result.text).toContain("phantom_tool_xyz");
    expect(result.text).not.toContain("`phantom_tool_xyz`");
    expect(result.violations.map((v) => v.kind)).toContain("tool.phantom_reference");
  });

  it("produces grammatically intact output after backtick strip", () => {
    const result = runOutputGuard("I'll call `create_oauth_app` now and return the result.", ctx, {
      mode: "soft",
    });
    expect(result.text).toBe("I'll call create_oauth_app now and return the result.");
  });

  it("records the violation for observability even after soft-rewriting", () => {
    const result = runOutputGuard("running `make_fake_tool` for you.", ctx, { mode: "soft" });
    const v = result.violations.find((x) => x.kind === "tool.phantom_reference");
    expect(v).toBeDefined();
    expect(v?.details?.invented_tool).toBe("make_fake_tool");
  });

  it("bare backticked identifier with no invocation verb produces NO violation and passes through unchanged", () => {
    const text = "the step `fetch_confluence_page` returned data successfully.";
    const result = runOutputGuard(text, ctx, { mode: "soft" });
    expect(result.violations.filter((v) => v.kind === "tool.phantom_reference")).toHaveLength(0);
    expect(result.text).toBe(text);
  });
});
