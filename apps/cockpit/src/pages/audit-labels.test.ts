import { expect, test } from "bun:test";
import type { TranslationKey } from "@/lib/i18n";
import { accessLabel, sourceLabel } from "./audit-labels";

const translate = (key: TranslationKey) => key;

test("recorded sources select their own translated labels", () => {
  for (const source of [
    "api",
    "cli",
    "scheduler",
    "mcp",
    "webhook",
    "tool-chain",
    "ui",
    "chat",
    "queue",
  ]) {
    expect(sourceLabel(source, translate)).toBe(`audit.timeline.source.${source}`);
  }
});

test("access mechanisms retain distinct names", () => {
  const expected = {
    api_key: "apiKey",
    browser_session: "browserSession",
    mcp_oauth: "mcpOAuth",
    token_exchange: "tokenExchange",
    external_bearer: "externalBearer",
    task_run: "taskRun",
    portal_token: "portalToken",
  };
  for (const [access, label] of Object.entries(expected)) {
    expect(accessLabel(access, translate)).toBe(`audit.timeline.accessType.${label}`);
  }
});

test("missing, unknown and inherited property names remain unrecorded", () => {
  for (const value of [null, undefined, "", "other", "constructor", "toString", "__proto__"]) {
    expect(sourceLabel(value, translate)).toBe("audit.timeline.notRecorded");
    expect(accessLabel(value, translate)).toBe("audit.timeline.notRecorded");
  }
});
