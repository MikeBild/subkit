// Unit tests for the output-guard secret pre-pass and the streaming
// text_delta scrubber.
//
// The pre-pass is a security invariant, NOT a scanner: a secret-shaped
// span is always redacted and the turn continues — in soft mode, in
// hard mode (no throw for a secrets-only text), and even in off mode.
// Secret spans never enter `violations`, so a hard-mode throw caused
// by a real scanner violation carries no token material.

import { describe, expect, it } from "bun:test";

import { LlmOutputViolation } from "../../errors.ts";
import { runOutputGuard } from "../index.ts";
import { createStreamScrubber } from "../stream-scrub.ts";

const ctx = { engine_url: "https://subkit-api.acme.dev" };

// Obviously fake, regex-shaped fixture (Atlassian ATATT pat).
const FAKE_TOKEN = "ATATTexampleexampleexample123Aa456";

describe("runOutputGuard — secret pre-pass (soft mode)", () => {
  it("redacts a secret-shaped token and continues without throwing", () => {
    const r = runOutputGuard(`Your Jira token is ${FAKE_TOKEN}, saved.`, ctx, { mode: "soft" });
    expect(r.text).toContain("***REDACTED:pat***");
    expect(r.text).not.toContain(FAKE_TOKEN);
  });

  it("does not surface the secret as a violation", () => {
    const r = runOutputGuard(`token: ${FAKE_TOKEN}`, ctx, { mode: "soft" });
    expect(JSON.stringify(r.violations)).not.toContain(FAKE_TOKEN);
  });

  it("leaves clean text untouched", () => {
    const text = "Workflow committed as v3 — run it now?";
    const r = runOutputGuard(text, ctx, { mode: "soft" });
    expect(r.text).toBe(text);
  });
});

describe("runOutputGuard — secret pre-pass (hard mode)", () => {
  it("does NOT throw on a secrets-only text — returns it redacted", () => {
    const r = runOutputGuard(`Use ${FAKE_TOKEN} as the API token.`, ctx, { mode: "hard" });
    expect(r.text).toContain("***REDACTED:pat***");
    expect(r.text).not.toContain(FAKE_TOKEN);
    expect(r.violations).toEqual([]);
  });

  it("still throws on a real scanner violation, with no token in the violation list", () => {
    try {
      runOutputGuard(`Use https://your-subkit-instance.com/mcp with token ${FAKE_TOKEN}`, ctx, {
        mode: "hard",
      });
      throw new Error("guard did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmOutputViolation);
      const violations = (err as LlmOutputViolation).violations;
      expect(violations.map((v) => v.kind)).toContain("placeholder.host");
      expect(JSON.stringify(violations)).not.toContain(FAKE_TOKEN);
    }
  });

  it("leaves clean text untouched and does not throw", () => {
    const text = "Use https://subkit-api.acme.dev/mcp";
    expect(runOutputGuard(text, ctx, { mode: "hard" }).text).toBe(text);
  });
});

describe("runOutputGuard — secret pre-pass (off mode)", () => {
  it("redacts secrets even when the guard is off", () => {
    const r = runOutputGuard(`token ${FAKE_TOKEN} end`, ctx, { mode: "off" });
    expect(r.text).toBe("token ***REDACTED:pat*** end");
    expect(r.violations).toEqual([]);
  });
});

describe("createStreamScrubber", () => {
  it("redacts a token split across two push() chunks", () => {
    // Each half alone is unmatchable (the prefix run is too short, the
    // suffix has no ATATT anchor) — only the joined buffer matches.
    const half1 = "Here is the credential: ATATTexampleexample";
    const half2 = "example123Aa456 — keep it safe.\n\n";
    const filler = "lorem ipsum dolor sit amet, ".repeat(20); // > holdback, with boundaries
    const scrubber = createStreamScrubber();
    const emitted =
      scrubber.push(half1) + scrubber.push(half2) + scrubber.push(filler) + scrubber.flush();
    expect(emitted).not.toContain(FAKE_TOKEN);
    expect(emitted).toContain("***REDACTED:pat***");
    // Everything except the token survives verbatim — the scrubber must
    // not drop or reorder text around the holdback seams.
    expect(emitted).toBe((half1 + half2 + filler).replace(FAKE_TOKEN, "***REDACTED:pat***"));
  });

  it("flush() drains the held tail so nothing is lost", () => {
    const scrubber = createStreamScrubber();
    const text = "short reply, well under the holdback window";
    expect(scrubber.push(text)).toBe(""); // held
    expect(scrubber.flush()).toBe(text); // drained verbatim
  });

  it("reassembles clean text verbatim across many small chunks", () => {
    const scrubber = createStreamScrubber();
    const full = "All workflow steps validated. Committing as v4 now — done.\n\n".repeat(12);
    let out = "";
    for (let i = 0; i < full.length; i += 7) {
      out += scrubber.push(full.slice(i, i + 7));
    }
    out += scrubber.flush();
    expect(out).toBe(full);
  });

  it("never emits a partial token even when the cut lands inside it", () => {
    // Push enough trailing token-charset filler that the naive cut
    // would land inside the secret run; the boundary nudge must hold
    // the whole run back instead of splitting it.
    const scrubber = createStreamScrubber(32);
    const out1 = scrubber.push(`prefix text ${FAKE_TOKEN}`);
    const out2 = scrubber.push(" trailing words that push the buffer well past the holdback");
    const out = out1 + out2 + scrubber.flush();
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain("***REDACTED:pat***");
  });
});
