import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitVisibleSourceDigest } from "../../../../scripts/lib/source-digest.ts";
import { externalRuntimeDockerTests } from "../audit/external-runtime-tests.ts";
import { validateExternalRuntimeAcceptance } from "../run-external-runtime-acceptance.ts";

const repo = resolve(import.meta.dir, "../../../..");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = `.artifacts/external-runtime-fixture-${crypto.randomUUID()}`;
  const absolute = join(repo, root);
  const tests = externalRuntimeDockerTests(repo);
  const visible = gitVisibleSourceDigest(repo).digest;
  const manifestText = "fixture-manifest";
  const wave = {
    wave_id: "fixture-wave",
    source_freeze_sha256: "a".repeat(64),
    test_freeze_sha256: "b".repeat(64),
    external_runtime_tests: tests,
  } as never;
  mkdirSync(absolute, { recursive: true });
  const command = (mode: "cold" | "warm") => {
    const builds = Array.from({ length: 5 }, (_, index) => {
      const attempt = index + 1;
      const native = {
        project: `project-${mode}-${attempt}`,
        image_id: `sha256:${String(attempt).repeat(64)}`,
        platform: "linux/amd64",
        source: { digest: visible },
        context: { digest: "c".repeat(64) },
      };
      const receiptPath = `${mode}.build-index.json.receipts/${attempt}.json`;
      const nativeText = JSON.stringify(native);
      const target = join(absolute, receiptPath);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, nativeText);
      return {
        attempt,
        project: native.project,
        image_id: native.image_id,
        platform: native.platform,
        source: native.source,
        context_digest: native.context.digest,
        receipt_path: receiptPath,
        receipt_sha256: hash(nativeText),
      };
    });
    const index = { mode, repeat: 5, tests, builds };
    const indexText = JSON.stringify(index);
    const indexPath = `${root}/${mode}.build-index.json`;
    writeFileSync(join(repo, indexPath), indexText);
    return {
      mode,
      repeat: 5 as const,
      exit_code: 0 as const,
      build_index_path: indexPath,
      build_index_sha256: hash(indexText),
    };
  };
  const commands = [command("cold"), command("warm")];
  const receipt = {
    version: 1,
    wave_id: "fixture-wave",
    manifest_sha256: hash(manifestText),
    source_sha256: "a".repeat(64),
    test_sha256: "b".repeat(64),
    git_source_digest: visible,
    tests,
    commands,
  };
  return {
    absolute,
    manifestText,
    wave,
    receipt,
    check: (value: unknown = receipt) =>
      validateExternalRuntimeAcceptance(repo, wave, manifestText, value),
    cleanup: () => rmSync(absolute, { recursive: true, force: true }),
  };
}

test("external acceptance binds ten complete native receipts to the frozen wave", () => {
  const f = fixture();
  try {
    expect(f.check()).toEqual([]);
  } finally {
    f.cleanup();
  }
});

test("external acceptance rejects missing and tampered indexes or native receipts", () => {
  for (const change of [
    "missing-index",
    "tampered-index",
    "missing-native",
    "tampered-native",
  ] as const) {
    const f = fixture();
    try {
      if (change === "missing-index") rmSync(join(f.absolute, "cold.build-index.json"));
      if (change === "tampered-index")
        writeFileSync(join(f.absolute, "cold.build-index.json"), "{}");
      if (change === "missing-native")
        rmSync(join(f.absolute, "cold.build-index.json.receipts", "1.json"));
      if (change === "tampered-native")
        writeFileSync(join(f.absolute, "cold.build-index.json.receipts", "1.json"), "{}");
      expect(f.check().length).toBeGreaterThan(0);
    } finally {
      f.cleanup();
    }
  }
});

test("external acceptance rejects repeated attempts and projects even when the index hash is refreshed", () => {
  for (const field of ["attempt", "project"] as const) {
    const f = fixture();
    try {
      const path = join(f.absolute, "cold.build-index.json");
      const index = JSON.parse(readFileSync(path, "utf8")) as { builds: Record<string, unknown>[] };
      index.builds[4]![field] = index.builds[0]![field];
      const text = JSON.stringify(index);
      writeFileSync(path, text);
      f.receipt.commands[0]!.build_index_sha256 = hash(text);
      expect(f.check().join("\n")).toContain("malformed or repeated");
    } finally {
      f.cleanup();
    }
  }
});

test("external acceptance rejects malformed receipt shapes and symlinked native proof", () => {
  const f = fixture();
  try {
    expect(f.check(null).length).toBeGreaterThan(0);
    expect(f.check({ ...f.receipt, commands: null }).length).toBeGreaterThan(0);
    const receipt = join(f.absolute, "cold.build-index.json.receipts", "1.json");
    const replacement = join(f.absolute, "replacement.json");
    writeFileSync(replacement, readFileSync(receipt));
    rmSync(receipt);
    symlinkSync(replacement, receipt);
    expect(f.check().length).toBeGreaterThan(0);
  } finally {
    f.cleanup();
  }
});
