import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface GitVisibleUntrackedFile {
  path: string;
  content: Uint8Array;
}

export interface GitVisibleSnapshot {
  revision: string;
  status: string;
  diff: string;
  untracked: GitVisibleUntrackedFile[];
}

export interface GitVisibleSourceDigest {
  revision: string;
  dirty: boolean;
  digest: string;
}

const protocol = "subkit-git-visible-v2";

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function digestGitVisibleSnapshot(snapshot: GitVisibleSnapshot): string {
  const framed = JSON.stringify({
    protocol,
    revision: snapshot.revision,
    status: snapshot.status,
    diff: snapshot.diff,
    untracked: [...snapshot.untracked]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(({ path: file, content }) => ({ path: file, sha256: sha256(content) })),
  });
  return sha256(new TextEncoder().encode(framed));
}

function gitOutput(repoRoot: string, args: string[]): Buffer {
  const result = spawnSync("git", args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr?.toString("utf8") ?? "unknown error"}`,
    );
  return result.stdout ?? Buffer.alloc(0);
}

function nulDelimitedPaths(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function gitVisibleSourceDigest(repoRoot: string): GitVisibleSourceDigest {
  const revision = gitOutput(repoRoot, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const status = gitOutput(repoRoot, ["status", "--porcelain=v1", "-z"]).toString("utf8");
  const diff = gitOutput(repoRoot, ["diff", "--no-ext-diff", "--binary", "HEAD"]).toString("utf8");
  const untracked = nulDelimitedPaths(
    gitOutput(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ).map((file) => ({ path: file, content: readFileSync(path.join(repoRoot, file)) }));

  return {
    revision,
    dirty: status.length > 0,
    digest: digestGitVisibleSnapshot({ revision, status, diff, untracked }),
  };
}
