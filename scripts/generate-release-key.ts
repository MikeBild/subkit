#!/usr/bin/env bun
// Generate (or rotate) the Ed25519 keypair used to sign `SHA256SUMS`
// in releases.
//
// Outputs:
//   1. Overwrites `packages/cli-core/src/release-public-key.ts` with
//      the freshly generated public key in PEM SPKI form. This file
//      is committed to the repo — the public key is, by definition,
//      public.
//   2. Prints the matching private key (PKCS#8 PEM) to stdout once.
//      The operator pastes it into the `RELEASE_SIGNING_KEY` GitHub
//      Actions secret. Do not commit the private key.
//
// Usage:
//   bun run scripts/generate-release-key.ts
//
// Rotation procedure: see `docs/operations.md`.

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_KEY_FILE = join(REPO_ROOT, "packages/cli-core/src/release-public-key.ts");

function main(): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString().trim();
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString().trim();

  // Patch only the constant body; leave the file's docstring intact.
  const original = readFileSync(PUBLIC_KEY_FILE, "utf8");
  const patched = original.replace(
    /export const RELEASE_PUBLIC_KEY = `[^`]*`;/m,
    `export const RELEASE_PUBLIC_KEY = \`${publicPem}\`;`,
  );
  if (patched === original) {
    process.stderr.write(
      `error: could not locate RELEASE_PUBLIC_KEY constant in ${PUBLIC_KEY_FILE}\n`,
    );
    process.exit(1);
  }
  writeFileSync(PUBLIC_KEY_FILE, patched);
  process.stderr.write(`✓ wrote new public key to ${PUBLIC_KEY_FILE}\n`);
  process.stderr.write(
    "✓ commit the diff so all binaries built from this branch verify against the new key\n\n",
  );
  process.stderr.write("--- PRIVATE KEY (paste into RELEASE_SIGNING_KEY GitHub secret) ---\n");
  process.stdout.write(`${privatePem}\n`);
  process.stderr.write("--- END PRIVATE KEY ---\n");
}

main();
