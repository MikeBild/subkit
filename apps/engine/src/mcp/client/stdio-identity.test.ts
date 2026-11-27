import { describe, expect, test } from "bun:test";
import {
  carryStdioConfirmation,
  stdioCommandDisplay,
  stdioCommandHash,
  stdioSpecFromConfig,
  withoutStdioServerManagedFields,
} from "./stdio-identity.ts";

const SPEC = {
  command: "docker",
  args: ["mcp", "gateway", "run"],
  env: { B: "2", A: "1" },
  env_secret_names: ["TOKEN"],
  cwd: "/srv/work",
};

describe("stdio command identity", () => {
  test("is a sha256 hex digest that ignores env and secret-name order", () => {
    const hash = stdioCommandHash(SPEC);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stdioCommandHash({ ...SPEC, env: { A: "1", B: "2" } })).toBe(hash);
  });

  test("changes with the command, args, env, secret names and cwd", () => {
    const hash = stdioCommandHash(SPEC);
    for (const changed of [
      { ...SPEC, command: "podman" },
      { ...SPEC, args: ["mcp", "gateway"] },
      { ...SPEC, args: ["gateway", "mcp", "run"] },
      { ...SPEC, env: { A: "1", B: "3" } },
      { ...SPEC, env: { A: "1" } },
      { ...SPEC, env_secret_names: ["TOKEN", "OTHER"] },
      { ...SPEC, cwd: "/srv/other" },
      { command: SPEC.command, args: SPEC.args, env: SPEC.env, env_secret_names: ["TOKEN"] },
    ]) {
      expect(stdioCommandHash(changed)).not.toBe(hash);
    }
  });

  test("displays the literal command line", () => {
    expect(
      stdioCommandDisplay({ ...SPEC, args: ["run", "--name", "my server"] }).command_line,
    ).toBe("docker run --name 'my server'");
  });
});

describe("stdio confirmation carry-over", () => {
  const confirmed = {
    mcp: {
      transport: "stdio",
      ...SPEC,
      confirmed_command_hash: stdioCommandHash(SPEC),
      confirmed_by: "user-b",
      confirmed_at: "2026-11-27T10:00:00.000Z",
      command_set_by: "user-a",
    },
  };

  test("keeps the confirmation when the command is unchanged", () => {
    const next = { mcp: { transport: "stdio", ...SPEC, remote_tool_call_timeout_ms: 5_000 } };
    const carried = carryStdioConfirmation(confirmed, next, "user-c") as typeof confirmed;
    expect(carried.mcp.confirmed_command_hash).toBe(stdioCommandHash(SPEC));
    expect(carried.mcp.command_set_by).toBe("user-a");
  });

  test("clears the confirmation and records the editor when the command changes", () => {
    const next = { mcp: { transport: "stdio", ...SPEC, args: ["mcp", "gateway", "run", "-v"] } };
    const carried = carryStdioConfirmation(confirmed, next, "user-c") as {
      mcp: Record<string, unknown>;
    };
    expect(carried.mcp.confirmed_command_hash).toBeUndefined();
    expect(carried.mcp.confirmed_by).toBeUndefined();
    expect(carried.mcp.command_set_by).toBe("user-c");
  });

  test("never takes a confirmation from the client", () => {
    const forged = {
      mcp: {
        transport: "stdio",
        ...SPEC,
        confirmed_command_hash: stdioCommandHash(SPEC),
        confirmed_by: "attacker",
      },
    };
    const carried = carryStdioConfirmation(null, forged, "user-a") as {
      mcp: Record<string, unknown>;
    };
    expect(carried.mcp.confirmed_command_hash).toBeUndefined();
    expect(carried.mcp.confirmed_by).toBeUndefined();
    expect(withoutStdioServerManagedFields(forged)).toEqual({
      mcp: { transport: "stdio", ...SPEC },
    });
    expect(stdioSpecFromConfig(carried)).toEqual(SPEC);
  });
});
