import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { requestSourceLabel, runCaller } from "@/pages/runs-model";

const german = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);
const PERSON = "11111111-1111-4111-8111-111111111111";
const ROOT = "22222222-2222-4222-8222-222222222222";
const directory = new Map([[PERSON, "Lena Koch"]]);

const run = (caller: Parameters<typeof runCaller>[0]["caller"], request_source = "mcp") => ({
  caller,
  request_source,
  execution_authority_id: null,
  workflow_version_id: null,
  hold_writes: false,
});

describe("who asked for a run", () => {
  test("a person who signed in is named, with the channel and a verified badge", () => {
    const line = runCaller(
      run({
        kind: "user",
        principal_id: PERSON,
        provider: "oidc",
        product_id: null,
        verified_by: "mcp_oauth",
        channel: "mcp",
        origin_execution_id: null,
      }),
      directory,
      german,
    );
    expect(line.who).toBe("Lena Koch");
    expect(line.channel).toBe("MCP");
    expect(line.state).toBe("verified");
    expect(line.why[0]).toEqual(["Geprüft über", "MCP-Anmeldung (OAuth)"]);
  });

  test("a scheduled run names the schedule and invents no person", () => {
    const line = runCaller(
      run(
        {
          kind: "engine",
          principal_id: null,
          provider: null,
          product_id: null,
          verified_by: null,
          channel: "scheduler",
          origin_execution_id: null,
        },
        "scheduler",
      ),
      directory,
      german,
    );
    expect(line.who).toBe("Zeitplan");
    expect(line.channel).toBeNull();
    expect(line.state).toBe("automatic");
    expect(line.why[0]).toEqual(["Geprüft über", "Von SubKit gestartet, ohne Anmeldung"]);
  });

  test("someone the reader may not look up stays a person, never a raw identifier", () => {
    const line = runCaller(
      run({
        kind: "system_account",
        principal_id: PERSON,
        provider: "api_key",
        product_id: null,
        verified_by: "api_key",
        channel: "api",
        origin_execution_id: ROOT,
      }),
      new Map(),
      german,
    );
    expect(line.who).toBe("Dienstkonto");
    expect(JSON.stringify(line.why.map(([label]) => label))).toContain("Ursprünglicher Lauf");
  });

  test("a run that recorded no identity names its channel and never a person", () => {
    const line = runCaller(
      run(
        {
          kind: "unknown",
          principal_id: null,
          provider: null,
          product_id: null,
          verified_by: null,
          channel: "webhook",
          origin_execution_id: null,
        },
        "webhook",
      ),
      directory,
      german,
    );
    expect(line.who).toBe("Webhook");
    expect(line.channel).toBeNull();
    expect(line.state).toBe("automatic");
  });

  test("every channel the engine records has a name, so no machine value reaches the reader", () => {
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
      expect(requestSourceLabel(source, german).text).not.toBe(source);
    }
    expect(requestSourceLabel("queue", german).text).toBe("Warteschlange");
  });
});
