import { execFile as nodeExecFile } from "node:child_process";
import { homedir, userInfo } from "node:os";

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; env: Record<string, string> },
  callback: (error: Error | null, stdout: string) => void,
) => void;

export interface LoginPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileLike;
  timeoutMs?: number;
}

const FALLBACK_PREFIX = ["/opt/homebrew/bin", "/usr/local/bin"];
const LOGIN_SHELL_TIMEOUT_MS = 3000;
const PASSTHROUGH = ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"] as const;

const defaultExecFile: ExecFileLike = (file, args, options, callback) => {
  nodeExecFile(file, args, { ...options, encoding: "utf8" }, (error, stdout) =>
    callback(error, String(stdout ?? "")),
  );
};

export function dedupePath(...parts: string[]): string {
  const seen = new Set<string>();
  for (const part of parts) {
    for (const entry of part.split(":")) {
      if (entry) seen.add(entry);
    }
  }
  return [...seen].join(":");
}

export function resolveLoginPath(options: LoginPathOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const current = env.PATH ?? "";
  if (platform !== "darwin") return Promise.resolve(current);
  const fallback = dedupePath(FALLBACK_PREFIX.join(":"), current);
  const run = options.execFile ?? defaultExecFile;
  const shell = env.SHELL || "/bin/zsh";
  const shellEnv: Record<string, string> = {
    HOME: env.HOME ?? homedir(),
    USER: env.USER ?? userInfo().username,
    SHELL: shell,
  };
  return new Promise((resolve) => {
    try {
      run(
        shell,
        ["-ilc", 'printf %s "$PATH"'],
        { timeout: options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS, env: shellEnv },
        (error, stdout) => {
          const resolved = stdout.trim().split("\n").at(-1) ?? "";
          resolve(error || !resolved ? fallback : dedupePath(resolved, current));
        },
      );
    } catch {
      resolve(fallback);
    }
  });
}

let cached: Promise<string> | null = null;

export function loginPath(): Promise<string> {
  cached ??= resolveLoginPath();
  return cached;
}

export function engineHostEnv(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const host: Record<string, string> = { PATH: path, NODE_USE_SYSTEM_CA: "1" };
  for (const name of PASSTHROUGH) {
    const value = env[name];
    if (value) host[name] = value;
  }
  return host;
}
