import { describe, expect, test } from "bun:test";
import { dedupePath, type ExecFileLike, engineHostEnv, resolveLoginPath } from "./login-path.ts";

function fakeExec(result: {
  error?: Error;
  stdout?: string;
}): ExecFileLike & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const run = ((file, args, options, callback) => {
    calls.push([file, args, options]);
    callback(result.error ?? null, result.stdout ?? "");
  }) as ExecFileLike & { calls: unknown[][] };
  run.calls = calls;
  return run;
}

describe("resolveLoginPath", () => {
  test("on macOS asks the login shell once with a minimal environment and dedupes the result", async () => {
    const execFile = fakeExec({ stdout: "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin" });
    const path = await resolveLoginPath({
      platform: "darwin",
      env: {
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/bash",
        HOME: "/Users/a",
        USER: "a",
        MASTER_KEY: "x",
      },
      execFile,
    });
    expect(path).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(execFile.calls).toEqual([
      [
        "/bin/bash",
        ["-ilc", 'printf %s "$PATH"'],
        { timeout: 3000, env: { HOME: "/Users/a", USER: "a", SHELL: "/bin/bash" } },
      ],
    ]);
  });

  test("uses zsh when SHELL is not set", async () => {
    const execFile = fakeExec({ stdout: "/usr/bin" });
    await resolveLoginPath({
      platform: "darwin",
      env: { PATH: "/usr/bin", HOME: "/h", USER: "u" },
      execFile,
    });
    expect(execFile.calls[0]?.[0]).toBe("/bin/zsh");
  });

  test("falls back to the Homebrew directories plus the current PATH when the shell fails or times out", async () => {
    const execFile = fakeExec({ error: new Error("timed out") });
    const path = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: "/usr/bin:/usr/local/bin", HOME: "/h", USER: "u" },
      execFile,
    });
    expect(path).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  });

  test("falls back when the shell prints nothing", async () => {
    const path = await resolveLoginPath({
      platform: "darwin",
      env: { PATH: "/usr/bin", HOME: "/h", USER: "u" },
      execFile: fakeExec({ stdout: "" }),
    });
    expect(path).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  });

  test("keeps the process PATH on Windows without starting a shell", async () => {
    const execFile = fakeExec({ stdout: "/never" });
    const path = await resolveLoginPath({
      platform: "win32",
      env: { PATH: "C:\\Windows" },
      execFile,
    });
    expect(path).toBe("C:\\Windows");
    expect(execFile.calls).toHaveLength(0);
  });
});

describe("engineHostEnv", () => {
  test("passes PATH, system CAs and only the Docker variables that are set", () => {
    expect(
      engineHostEnv("/usr/bin", {
        DOCKER_HOST: "unix:///d.sock",
        DOCKER_CONTEXT: "",
        AWS_SECRET: "s",
      }),
    ).toEqual({ PATH: "/usr/bin", NODE_USE_SYSTEM_CA: "1", DOCKER_HOST: "unix:///d.sock" });
  });
});

describe("dedupePath", () => {
  test("keeps the first occurrence and drops empty entries", () => {
    expect(dedupePath("/a::/b", "/b:/c:/a")).toBe("/a:/b:/c");
  });
});
