// `docs/BOOTSTRAP-PREFLIGHT.md` is a COPY, not a SubKit document.
//
// The same text is carried byte-identically by every product of the family.
// No product shares code with another — each implements the contract on its
// own — so the only thing keeping the six numbered checks meaning the same
// thing in six repositories is that the prose does not drift.
//
// This test pins the sha256 of the file, which makes drift a test failure
// rather than a discovery.
//
// HOW TO RAISE THE PIN, and the one way that is wrong: the new digest must
// come from the DISTRIBUTED document — the text as the family agreed it —
// and never from this repository's own copy. Re-pinning to whatever is on
// disk turns the gate into a rubber stamp: the sibling-repo pin that once
// went green against a locally truncated file is exactly this mistake, and
// `tests/contract/cockpit-konvention-kopie.test.ts` carries the same
// warning for the same reason.
//
// A SubKit-specific mapping of the numbered checks to this repo's code
// belongs in `docs/admins/bootstrap-preflight.md`, which is ours to edit
// freely — that separation is what lets the shared text stay frozen.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const CONVENTION = join(REPO, "docs/BOOTSTRAP-PREFLIGHT.md");

/** Bootstrap Preflight, version 1.0 — the reviewed family text. */
const CONVENTION_SHA256 = "8170e4cdb2636d800e75e0de4738380c55eee4252b519c64982be6d7a0db1284";

describe("docs/BOOTSTRAP-PREFLIGHT.md is the family text, unmodified", () => {
  const bytes = readFileSync(CONVENTION);

  test("its sha256 is the pinned digest", () => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(
      digest,
      "docs/BOOTSTRAP-PREFLIGHT.md is no longer the reviewed version 1.0 text — " +
        "raise the pin only from the distributed document, never from this repo's own file",
    ).toBe(CONVENTION_SHA256);
  });

  test("it still declares the version the pin names", () => {
    // Belt and braces: a future edit that happened to collide on the digest
    // is not a thing, but a future edit that raised the pin AND the version
    // together without anyone noticing the version moved is. This asserts
    // the number a reader sees matches the number the pin is documented as.
    expect(bytes.toString("utf8")).toContain("Version 1.0 —");
  });

  test("it names all six checks and both never-does clauses", () => {
    // The mapping page in docs/admins/ answers these per check; this test
    // only proves the questions are still in the copy, so a truncated file
    // fails here with a readable reason rather than as a digest mismatch
    // an operator cannot interpret.
    const text = bytes.toString("utf8");
    for (const marker of [
      "`MASTER_KEY` is present in production",
      "`DATABASE_URL` reaches PostgreSQL",
      "If the release stores objects",
      "The current settings revision",
      "Every Vault or secret version",
      "The identity provider configuration",
      "It never derives one secret from another",
      "It never depends on a sibling product being reachable",
    ]) {
      expect(text, `the copy no longer contains: ${marker}`).toContain(marker);
    }
  });
});
