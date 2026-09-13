import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const baseline = read(join(root, "contract/dependency-baseline.json"));
const main = read(join(root, "package.json"));
const npm = main.packageManager?.startsWith("npm@");
const scopes = ["."];
if (existsSync(join(root, "apps/cockpit/package.json"))) scopes.push("apps/cockpit");

for (const scope of scopes) {
  const directory = join(root, scope);
  const manifest = read(join(directory, "package.json"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const require = createRequire(join(directory, "package.json"));
  for (const [name, target] of Object.entries(baseline.packages)) {
    if (!(name in declared)) continue;
    assert.equal(declared[name], target, `${scope}: ${name} declaration drift`);
    const expected = target.startsWith("npm:") ? target.slice(target.lastIndexOf("@") + 1) : target;
    const search = require.resolve.paths(name) ?? [];
    const installed = search.map((path) => join(path, name, "package.json")).find(existsSync);
    assert.ok(installed, `${scope}: ${name} is not installed`);
    assert.equal(read(installed).version, expected, `${scope}: ${name} resolved version drift`);
  }
  if (npm) assert.equal(manifest.packageManager, `npm@${baseline.runtimes.npm}`);
}

assert.equal(readFileSync(join(root, ".bun-version"), "utf8").trim(), baseline.runtimes.bun);
assert.equal(readFileSync(join(root, ".node-version"), "utf8").trim(), baseline.runtimes.node);
assert.equal(
  main.packageManager,
  npm ? `npm@${baseline.runtimes.npm}` : `bun@${baseline.runtimes.bun}`,
);
const manager = npm ? "npm" : "bun";
const version = spawnSync(manager, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, `${manager} must be executable`);
assert.equal(version.stdout.trim(), baseline.runtimes[manager], `${manager} runtime drift`);
if (npm) assert.equal(process.versions.node, baseline.runtimes.node, "Node runtime drift");
if (main.workspaces) {
  assert.ok(
    !existsSync(join(root, "apps/cockpit/bun.lock")),
    "workspace must use the root lockfile",
  );
}
console.log(`Dependency baseline verified in ${scopes.length} package scope(s)`);
