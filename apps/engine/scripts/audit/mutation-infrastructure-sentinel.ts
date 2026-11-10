import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const FILE = "core-test-runner-infrastructure-failure.json";

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`);
}

export function mutationInfrastructureSentinelPath(ticketPath: string): string {
  if (!isAbsolute(ticketPath)) throw new Error("mutation ticket path must be absolute");
  const root = resolve(dirname(ticketPath));
  const file = resolve(root, FILE);
  if (!contained(root, file))
    throw new Error("mutation infrastructure sentinel escaped ticket root");
  return file;
}

export function writeMutationInfrastructureSentinel(ticketPath: string, reason: string): void {
  const file = mutationInfrastructureSentinelPath(ticketPath);
  const root = dirname(file);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("mutation ticket root is not a regular directory");
  writeFileSync(file, `${JSON.stringify({ status: "failed", reason }, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

export function assertNoMutationInfrastructureSentinel(ticketPath: string): void {
  const file = mutationInfrastructureSentinelPath(ticketPath);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("mutation infrastructure sentinel is unsafe");
    const value = JSON.parse(readFileSync(file, "utf8")) as { status?: unknown; reason?: unknown };
    if (value.status !== "failed" || typeof value.reason !== "string")
      throw new Error("mutation infrastructure sentinel is malformed");
    throw new Error(`mutation runner infrastructure failed: ${value.reason}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
