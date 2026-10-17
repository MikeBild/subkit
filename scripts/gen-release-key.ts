#!/usr/bin/env bun

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC_KEY_FILE = join(REPO_ROOT, "packages/cli-core/src/release-public-key.ts");
const INSTALLER_FILE = join(REPO_ROOT, "scripts/install.sh");

function main(): void {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString().trim();
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString().trim();

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
  const installer = readFileSync(INSTALLER_FILE, "utf8");
  const patchedInstaller = installer.replace(
    /-----BEGIN PUBLIC KEY-----\n[\s\S]*?\n-----END PUBLIC KEY-----/,
    publicPem,
  );
  if (patchedInstaller === installer) {
    throw new Error(`could not locate the installer public key in ${INSTALLER_FILE}`);
  }
  writeFileSync(PUBLIC_KEY_FILE, patched);
  writeFileSync(INSTALLER_FILE, patchedInstaller);
  process.stderr.write(`✓ wrote new public key to ${PUBLIC_KEY_FILE}\n`);
  process.stderr.write(`✓ updated the installer trust root in ${INSTALLER_FILE}\n`);
  process.stderr.write(
    "✓ commit the diff so all binaries built from this branch verify against the new key\n\n",
  );
  process.stderr.write("--- PRIVATE KEY (paste into RELEASE_SIGNING_KEY GitHub secret) ---\n");
  process.stdout.write(`${privatePem}\n`);
  process.stderr.write("--- END PRIVATE KEY ---\n");
}

main();
