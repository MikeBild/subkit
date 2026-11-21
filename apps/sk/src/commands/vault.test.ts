import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { EngineClient } from "../engine-client.ts";
import { vaultCommand } from "./vault.ts";

const PROFILE_ENV = {
  SK_PROFILE: undefined,
  SUBKIT_PROFILE: undefined,
  SUBKIT_ENGINE_URL: "https://engine.example.test",
  SUBKIT_API_KEY: "fixture",
  SUBKIT_TENANT: "tenant",
} as const;
const savedEnv = Object.fromEntries(
  Object.keys(PROFILE_ENV).map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;
for (const [key, value] of Object.entries(PROFILE_ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
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
  latency_ms: 0,
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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function setCredential(skipChecks = false): Promise<string> {
  let output = "";
  const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: Readable.from([await readFile(import.meta.filename, "utf8")]),
    configurable: true,
  });
  try {
    const command = (vaultCommand.subCommands as Record<string, unknown>).attach as {
      run: (context: { args: Record<string, unknown> }) => Promise<void>;
    };
    await command.run({
      args: {
        "connector-id": "connector",
        mode: "signed_jwt",
        json: true,
        "skip-checks": skipChecks,
      },
    });
    return output;
  } finally {
    write.mockRestore();
    if (stdin) Object.defineProperty(process, "stdin", stdin);
  }
}

describe("signed JWT CLI credential setup", () => {
  test("reads the key from stdin, submits only material, and probes in JSON mode", async () => {
    const output = await setCredential();
    expect(created).toEqual([
      {
        mode: "signed_jwt",
        private_key: (await readFile(import.meta.filename, "utf8")).replace(/\r?\n$/, ""),
      },
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
