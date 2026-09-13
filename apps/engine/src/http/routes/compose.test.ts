// Drift test for the Compose file the engine hands out.
//
// The point of GET /docker-compose.yml is that someone with no checkout can
// install the release they are talking to. That only holds while the served
// bytes are the repository's own file — a stale embedded copy would be worse
// than no route at all, because it would look authoritative and start the
// wrong topology.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { COMPOSE_YAML } from "./compose.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const onDisk = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

describe("GET /docker-compose.yml", () => {
  test("serves the repository file byte for byte", () => {
    expect(COMPOSE_YAML).toBe(onDisk);
  });

  test("carries the services a first run needs", () => {
    // Losing any of these silently turns the published file into a topology
    // that boots but cannot store anything.
    for (const service of ["engine", "postgres", "object-store", "object-store-init"]) {
      expect(COMPOSE_YAML).toContain(`  ${service}:`);
    }
  });

  test("pins the version this binary actually is", () => {
    // The file is served by a running engine, so a tag that lags behind hands a
    // newcomer the previous release while claiming to describe this one.
    // scripts/bump-version.ts keeps the two in step; this fails if it stops.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(COMPOSE_YAML).toContain(`\${SUBKIT_IMAGE_TAG:-${pkg.version}}`);
  });

  test("pins the engine image rather than floating on latest", () => {
    // A published file that says `:latest` would start a different release than
    // the engine that served it.
    expect(COMPOSE_YAML).toMatch(
      /image:\s*\$\{SUBKIT_IMAGE:-mikebild\/subkit:\$\{SUBKIT_IMAGE_TAG:-\d+\.\d+\.\d+\}\}/,
    );
  });

  test("needs exactly one operator-supplied value", () => {
    // Every other variable carries a local-only default, so the documented
    // two-line install works. MASTER_KEY deliberately has none.
    expect(COMPOSE_YAML).toContain("MASTER_KEY: ${MASTER_KEY:-}");
    const withoutDefaults = [...COMPOSE_YAML.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]);
    expect(withoutDefaults).toEqual([]);
  });

  test("explains itself to someone who only has this file", () => {
    // The header is the whole onboarding for a reader with no repository and no
    // docs site open next to them.
    expect(COMPOSE_YAML).toContain("GET /docker-compose.yml");
    expect(COMPOSE_YAML).toContain("openssl rand -hex 32");
  });

  test("references no private repository", () => {
    // The repository stays private; a public artefact that points at it hands
    // the reader a 404 and a dead end.
    expect(COMPOSE_YAML).not.toContain("github.com");
  });
});
