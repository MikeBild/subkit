import { describe, expect, test } from "bun:test";
import { plan } from "../lib/commands.ts";
import {
  DEFER_MUTATION_FLAG,
  mutationDeferralWarning,
  mutationFromGateDescription,
  parseMutationDeferral,
  releaseGateDescription,
  releaseNotesMutationLine,
} from "../lib/mutation-deferral.ts";
import { releaseGateMutation } from "../release-gate-provenance.ts";

const CTX = { version: "1.2.3", platform: "linux" };
const commands = (result: ReturnType<typeof plan>) =>
  result.ok ? result.steps.map((step) => step.argv.join(" ")) : [];

describe("parseMutationDeferral", () => {
  test("without the flag the mutation evidence stays required", () => {
    expect(parseMutationDeferral(["--model", "x"])).toEqual({
      mutation: "verified",
      rest: ["--model", "x"],
    });
  });

  test("the flag defers and is removed from the passed-on arguments", () => {
    expect(parseMutationDeferral(["--model", "x", DEFER_MUTATION_FLAG])).toEqual({
      mutation: "deferred",
      rest: ["--model", "x"],
    });
  });
});

describe("release evidence", () => {
  test("the warning names the subject and the skipped check", () => {
    const warning = mutationDeferralWarning("v1.2.3");
    expect(warning).toContain("MUTATION EVIDENCE DEFERRED for v1.2.3");
    expect(warning).toContain("bun run quality release --check was skipped");
  });

  test("the gate status records the deferral and reads it back", () => {
    expect(releaseGateDescription("verified")).toBe(
      "Mandatory local verification and live models passed",
    );
    expect(releaseGateDescription("deferred")).toEndWith("; mutation: deferred");
    expect(mutationFromGateDescription(releaseGateDescription("deferred"))).toBe("deferred");
    expect(mutationFromGateDescription(releaseGateDescription("verified"))).toBe("verified");
    expect(mutationFromGateDescription(undefined)).toBe("verified");
  });

  test("the release notes state a deferral and stay unchanged otherwise", () => {
    expect(releaseNotesMutationLine("deferred")).toStartWith("Mutation evidence: deferred.");
    expect(releaseNotesMutationLine("verified")).toBe("");
  });

  test("the published gate status of the tag decides the notes line", () => {
    const status = (description: string) => ({
      statuses: [
        { context: "other", description: releaseGateDescription("deferred") },
        { context: "subkit-release/v1.2.3", state: "success", description },
      ],
    });
    expect(releaseGateMutation(status(releaseGateDescription("deferred")), "v1.2.3")).toBe(
      "deferred",
    );
    expect(releaseGateMutation(status(releaseGateDescription("verified")), "v1.2.3")).toBe(
      "verified",
    );
    expect(() => releaseGateMutation({ statuses: [] }, "v1.2.3")).toThrow(
      "Missing release gate status",
    );
  });
});

describe("verify release --defer-mutation", () => {
  test("skips only the mutation evidence check and warns first", () => {
    const strict = commands(plan("verify", ["release"], CTX));
    const deferred = commands(plan("verify", ["release", DEFER_MUTATION_FLAG], CTX));
    expect(strict[0]).toBe("bun scripts/release-mutation-evidence.ts check");
    expect(deferred[0]).toBe("bun scripts/warn-mutation-deferred.ts");
    expect(deferred).not.toContain("bun scripts/release-mutation-evidence.ts check");
    expect(deferred.slice(1)).toEqual(strict.slice(1));
  });

  test("is refused where no mutation evidence is checked", () => {
    const result = plan("verify", ["static", DEFER_MUTATION_FLAG], CTX);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.usage).toContain("bun run verify release");
  });

  test("release tag passes the flag on to the tag script", () => {
    expect(commands(plan("release", ["tag", DEFER_MUTATION_FLAG], CTX))).toEqual([
      `bun scripts/tag-release.ts ${DEFER_MUTATION_FLAG}`,
    ]);
    expect(commands(plan("release", ["tag"], CTX))).toEqual(["bun scripts/tag-release.ts"]);
  });
});
