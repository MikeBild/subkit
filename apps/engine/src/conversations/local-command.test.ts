import { describe, expect, test } from "bun:test";
import {
  detectLocalCommand,
  isConfirmedLocalCommand,
  literalCommandLine,
  localCommandFingerprint,
  readLocalCommand,
  splitShellWords,
} from "./local-command.ts";

describe("splitShellWords", () => {
  test.each([
    ["docker mcp gateway run", ["docker", "mcp", "gateway", "run"]],
    ['npx -y "@scope/pkg name"', ["npx", "-y", "@scope/pkg name"]],
    ["node 'a b.js' --flag=\\$x", ["node", "a b.js", "--flag=$x"]],
    [
      "uvx mcp-server-git --repository '$HOME/repo'",
      ["uvx", "mcp-server-git", "--repository", "$HOME/repo"],
    ],
    ["ls *.json", ["ls", "*.json"]],
  ])("splits %s literally", (input, words) => {
    expect(splitShellWords(input)).toEqual({ ok: true, words });
  });

  test.each([
    "npx thing | sh",
    "a; b",
    "a && b",
    "a > out",
    "echo $(id)",
    "echo `id`",
    "echo $HOME",
    'echo "$HOME"',
    "echo 'unterminated",
    "",
  ])("refuses %p", (input) => {
    expect(splitShellWords(input).ok).toBe(false);
  });
});

describe("detectLocalCommand", () => {
  test("finds a backticked command", () => {
    expect(detectLocalCommand("starte `docker mcp gateway run`")).toBe("docker mcp gateway run");
  });

  test("finds an inline npx command and drops the trailing period", () => {
    expect(detectLocalCommand("please run npx @playwright/mcp@latest.")).toBe(
      "npx @playwright/mcp@latest",
    );
  });

  test("ignores backticked URLs and plain prose", () => {
    expect(detectLocalCommand("connect `http://localhost:8931/mcp`")).toBeNull();
    expect(detectLocalCommand("connect my GitHub account")).toBeNull();
  });

  test("a backticked product name next to a start verb is not a command", () => {
    expect(detectLocalCommand("Starte einen Connector f\u00fcr `HubSpot`")).toBeNull();
    expect(detectLocalCommand("start syncing `orders` from the shop")).toBeNull();
  });

  test("a bare program after a start verb counts only when MCP is named", () => {
    expect(detectLocalCommand("start the MCP server `my-server --stdio`")).toBe(
      "my-server --stdio",
    );
    expect(detectLocalCommand("start `my-server --stdio`")).toBeNull();
  });
});

describe("local command identity", () => {
  const config = {
    mcp: {
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp@latest"],
      env: { LOG: "1" },
      env_secret_names: ["TOKEN"],
      cwd: "/srv",
    },
  };

  test("the fingerprint changes with args, env names, env values and cwd", () => {
    const base = readLocalCommand(config);
    if (!base) throw new Error("spec expected");
    const fp = localCommandFingerprint(base);
    expect(localCommandFingerprint({ ...base, args: ["other"] })).not.toBe(fp);
    expect(localCommandFingerprint({ ...base, env: { OTHER: "1" } })).not.toBe(fp);
    expect(localCommandFingerprint({ ...base, env: { LOG: "2" } })).not.toBe(fp);
    expect(localCommandFingerprint({ ...base, env_secret_names: [] })).not.toBe(fp);
    expect(localCommandFingerprint({ ...base, cwd: null })).not.toBe(fp);
  });

  test("a persisted confirmation counts only for the same command", () => {
    const spec = readLocalCommand(config);
    if (!spec) throw new Error("spec expected");
    const persisted = {
      mcp: { ...config.mcp, confirmed_command_hash: localCommandFingerprint(spec) },
    };
    expect(isConfirmedLocalCommand(persisted, spec)).toBe(true);
    expect(isConfirmedLocalCommand(config, spec)).toBe(false);
    expect(isConfirmedLocalCommand(persisted, { ...spec, args: ["--evil"] })).toBe(false);
    expect(isConfirmedLocalCommand(persisted, { ...spec, env: { LOG: "changed" } })).toBe(false);
    expect(
      isConfirmedLocalCommand(
        { mcp: { ...config.mcp, confirmed_command_hash: "0".repeat(64) } },
        spec,
      ),
    ).toBe(false);
  });

  test("the literal command line quotes words with spaces", () => {
    expect(
      literalCommandLine({
        command: "node",
        args: ["my server.js"],
        env: {},
        env_names: [],
        env_secret_names: [],
        cwd: null,
      }),
    ).toBe("node 'my server.js'");
  });
});
