import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoMutationInfrastructureSentinel,
  writeMutationInfrastructureSentinel,
} from "../audit/mutation-infrastructure-sentinel.ts";

test("rejects a mutation run after a trusted core runner infrastructure failure", () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-mutation-sentinel-"));
  const ticket = join(root, "mutation-validation-ticket.json");
  writeFileSync(ticket, "{}\n");
  try {
    expect(() => assertNoMutationInfrastructureSentinel(ticket)).not.toThrow();
    writeMutationInfrastructureSentinel(ticket, "core test output sink failed");
    expect(() => assertNoMutationInfrastructureSentinel(ticket)).toThrow(
      "mutation runner infrastructure failed: core test output sink failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
