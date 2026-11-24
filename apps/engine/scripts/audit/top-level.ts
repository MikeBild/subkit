export const TOP_LEVEL_DIRECTORIES: Readonly<Record<string, string>> = {
  ".githooks": "git hooks",
  ".github": "CI workflows",
  apps: "the products",
  docker:
    "container entrypoint scripts, the image source offer and the test and demo compose files",
  packages: "code shared between apps",
  patches: "bun patches of dependencies",
  "qa-evidence": "sanitized QA evidence that bug reports link to",
  scripts: "the bun run command dispatcher",
  tests: "cross-app contract, docker and e2e tests",
  vendor: "pinned third-party inputs and license notices",
};

export const TOP_LEVEL_FILES = [
  ".bun-version",
  ".commitlintrc.json",
  ".dockerignore",
  ".env.example",
  ".gitignore",
  ".gitleaks.toml",
  ".semgrep-excluded-rules",
  ".semgrepignore",
  "Dockerfile",
  "LICENSE",
  "README.md",
  "RELEASING.md",
  "SECURITY.md",
  "biome.json",
  "bun.lock",
  "bunfig.toml",
  "docker-compose.yml",
  "drizzle.config.ts",
  "package.json",
  "stryker.config.json",
  "subkit.config.example.json",
  "tsconfig.base.json",
  "tsconfig.json",
] as const;

export function unexpectedTopLevelEntries(paths: readonly string[]): string[] {
  const directories = new Set(Object.keys(TOP_LEVEL_DIRECTORIES));
  const files = new Set<string>(TOP_LEVEL_FILES);
  const unexpected = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    const slash = path.indexOf("/");
    if (slash === -1) {
      if (!files.has(path)) unexpected.add(path);
    } else if (!directories.has(path.slice(0, slash))) unexpected.add(`${path.slice(0, slash)}/`);
  }
  return [...unexpected].sort();
}
