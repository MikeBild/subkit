import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { runCaller } from "@/pages/runs-model";

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
});
