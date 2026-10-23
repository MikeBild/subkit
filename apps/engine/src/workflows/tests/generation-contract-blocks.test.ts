import { describe, expect, test } from "bun:test";
import { buildGenerationPrompt } from "../../conversations/authoring-pipeline.ts";
import { SCOPE_ENVELOPE_FIELDS, wrapEnvelope } from "../../execution/engine/envelope.ts";
import { buildLoopChildScope } from "../../execution/loop-scope.ts";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { SANDBOX_SK_MEMBERS } from "../../sandboxes/quickjs/stdlib/sandbox-globals.ts";
import {
  inspectReportMessage,
  REPORT_CONTENT_TYPES,
  REPORT_ENVELOPE_HEADERS,
  REPORT_MESSAGE_BUILDERS,
  REPORT_RECIPIENT_HEADERS_REFUSED,
  REPORT_TRANSFER_ENCODINGS,
  renderReportDeliveryContract,
} from "../report-delivery-boundary.ts";
import {
  LOOP_INDEX_SCOPE_KEY,
  LOOP_ITEM_SCOPE_KEY,
  renderScopeShapeContract,
} from "../scope-shape.ts";

const plainMessage = (extra: string[] = []) =>
  Buffer.from(
    [
      "From: reports@example.com",
      "To: owner@example.com",
      ...extra,
      "Subject: Daily report",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Hello",
    ].join("\r\n"),
  ).toString("base64url");

async function builtRaw(options: Record<string, unknown>): Promise<string> {
  const result = await runJs({
    code: "return sk.buildMimeMessage(input).raw;",
    input: options,
    limits: { wall_ms: 5000 },
    clock: null,
  });
  return result.output as string;
}

describe("report delivery contract block", () => {
  const block = renderReportDeliveryContract().join("\n");

  test("names every allowed header, refused recipient header, content type and encoding", () => {
    for (const header of REPORT_ENVELOPE_HEADERS) expect(block).toContain(header);
    for (const header of REPORT_RECIPIENT_HEADERS_REFUSED) expect(block).toContain(header);
    for (const type of REPORT_CONTENT_TYPES) expect(block).toContain(type);
    for (const encoding of REPORT_TRANSFER_ENCODINGS) expect(block).toContain(encoding);
    expect(block).toContain("header_not_allowed");
    expect(block).toContain("extra_recipients");
  });

  test("names UTF-8 builders that exist in the sandbox", () => {
    for (const builder of REPORT_MESSAGE_BUILDERS) {
      expect(SANDBOX_SK_MEMBERS).toContain(builder);
      expect(block).toContain(`sk.${builder}(`);
    }
  });

  test("the boundary refuses each recipient header the block forbids", () => {
    expect(inspectReportMessage({ raw: plainMessage() }).ok).toBe(true);
    for (const header of REPORT_RECIPIENT_HEADERS_REFUSED) {
      expect(inspectReportMessage({ raw: plainMessage([`${header}: x@example.com`]) })).toEqual({
        ok: false,
        reason: "header_not_allowed",
      });
    }
  });

  test("the recommended builder output passes the boundary and cc does not", async () => {
    const base = {
      from: "reports@example.com",
      to: "owner@example.com",
      subject: "Tägliche Übersicht",
      text: "Grüße",
      html: "<p>Grüße</p>",
    };
    const accepted = inspectReportMessage({ raw: await builtRaw(base) });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.boundary.content_type).toBe("multipart/alternative");
    expect(inspectReportMessage({ raw: await builtRaw({ ...base, cc: "x@example.com" }) })).toEqual(
      { ok: false, reason: "header_not_allowed" },
    );
  });
});

describe("scope shape contract block", () => {
  const block = renderScopeShapeContract().join("\n");

  test("lists exactly the envelope fields the engine records", () => {
    const envelope = wrapEnvelope({
      data: { ok: true },
      duration_ms: 1,
      error: null,
      request_meta: {
        status: 200,
        headers: { "content-type": "application/json" },
        pagination: { pages: 1, items: 1, duplicates_dropped: 0, complete: true, truncated: false },
      },
    });
    for (const key of Object.keys(envelope)) expect(SCOPE_ENVELOPE_FIELDS).toContain(key as never);
    expect(block).toContain(`{ ${SCOPE_ENVELOPE_FIELDS.join(", ")} }`);
    for (const key of Object.keys(envelope.pagination ?? {})) expect(block).toContain(key);
  });

  test("names the loop item keys the engine binds", () => {
    const child = buildLoopChildScope({ fetch: { data: [] } }, { id: 1 }, 0);
    expect(child[LOOP_ITEM_SCOPE_KEY]).toEqual({ id: 1 });
    expect(child[LOOP_INDEX_SCOPE_KEY]).toBe(0);
    expect(block).toContain(`input.scope.${LOOP_ITEM_SCOPE_KEY}`);
    expect(block).toContain(`input.scope.${LOOP_INDEX_SCOPE_KEY}`);
    expect(block).toContain("output_transform_function");
  });
});

test("the generation prompt carries the transform contract blocks compactly", () => {
  const prompt = buildGenerationPrompt({
    goal: "Send the daily report",
    connectors: [],
    docsByConnector: new Map(),
    samplesSection: null,
  });
  const start = prompt.indexOf("## Transform contract");
  const end = prompt.indexOf("JSONata is NOT a programmable transform language", start);
  const section = prompt.slice(start, end).trimEnd().split("\n");
  for (const line of [...renderScopeShapeContract(), ...renderReportDeliveryContract()])
    expect(section).toContain(line);
  expect(section.length).toBeLessThanOrEqual(40);
});
