import { readdirSync } from "node:fs";
import { join } from "node:path";

export type TestExecutionKind = "in_process" | "external_runtime";

const dockerDirectory = "tests/docker";
const dockerFile = /^[a-z0-9][a-z0-9-]*\.docker\.test\.ts$/;

export function isExternalRuntimeDockerTest(path: string): boolean {
  return (
    path.startsWith(`${dockerDirectory}/`) &&
    dockerFile.test(path.slice(dockerDirectory.length + 1))
  );
}

export function externalRuntimeDockerTests(repo: string): string[] {
  return readdirSync(join(repo, dockerDirectory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && dockerFile.test(entry.name))
    .map((entry) => `${dockerDirectory}/${entry.name}`)
    .sort();
}

export function testExecutionKind(
  path: string,
  externalTests: readonly string[],
): TestExecutionKind {
  return externalTests.includes(path) ? "external_runtime" : "in_process";
}
