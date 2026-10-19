import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";

const realConfig = await import("../config.ts");
mock.module("../config.ts", () => ({
  ...realConfig,
  resolveProfile: () => ({
    engine_url: "https://engine.example.test",
    api_key: "fixture",
    active_tenant_id: "tenant",
  }),
}));
const { EngineClient } = await import("../engine-client.ts");
const { credentialsCommand } = await import("./credentials.ts");
const created: Array<Record<string, unknown>> = [];
let probeOk = true;
const attach = spyOn(EngineClient.prototype, "createCredential").mockImplementation(
  async (_id, body) => {
    created.push(body);
    return { id: "credential" };
  },
);
const probe = spyOn(EngineClient.prototype, "testConnector").mockImplementation(async () => ({
  ok: probeOk,
}));
const originalExitCode = process.exitCode ?? 0;

afterEach(() => {
  created.length = 0;
  attach.mockClear();
  probe.mockClear();
  probeOk = true;
  process.exitCode = originalExitCode;
});
afterAll(() => {
  attach.mockRestore();
  probe.mockRestore();
  mock.module("../config.ts", () => realConfig);
});

async function setCredential(skipChecks = false): Promise<string> {
  let output = "";
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    const command = (credentialsCommand.subCommands as Record<string, unknown>).set as {
      run: (context: { args: Record<string, unknown> }) => Promise<void>;
    };
    await command.run({
      args: {
        "connector-id": "connector",
        mode: "signed_jwt",
        "private-key-file": import.meta.filename,
        json: true,
        "skip-checks": skipChecks,
      },
    });
    return output;
  } finally {
    write.mockRestore();
  }
}

describe("signed JWT CLI credential setup", () => {
  test("reads the key file locally, submits only material, and probes in JSON mode", async () => {
    const output = await setCredential();
    expect(created).toEqual([
      { mode: "signed_jwt", private_key: await readFile(import.meta.filename, "utf8") },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output)).toEqual({ id: "credential", probe: { ok: true } });
    expect(output).not.toContain(import.meta.filename);
    expect(output).not.toContain("private_key");
  });
  test("reports a failed probe rather than successful connectivity", async () => {
    probeOk = false;
    expect(JSON.parse(await setCredential()).probe.ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });
  test("an explicit skip does not claim a successful probe", async () => {
    expect(JSON.parse(await setCredential(true))).toEqual({ id: "credential" });
    expect(probe).not.toHaveBeenCalled();
  });
});
