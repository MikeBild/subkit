import { describe, expect, test } from "bun:test";
import { skillsLoadState } from "./skills-model";

const done = { isPending: false, error: null, failureReason: null };
const loading = { isPending: true, error: null, failureReason: null };
const broken = { isPending: false, error: new Error("boom"), failureReason: null };
const retrying = { isPending: true, error: null, failureReason: new Error("boom") };

describe("skillsLoadState", () => {
  test("waits while either the skills or the proposals are loading", () => {
    expect(skillsLoadState([done, loading])).toEqual({ pending: true, failed: false });
    expect(skillsLoadState([loading, done])).toEqual({ pending: true, failed: false });
  });

  test("a failed proposals read is an error, not a silently shorter list", () => {
    expect(skillsLoadState([done, broken])).toEqual({ pending: false, failed: true });
    expect(skillsLoadState([done, retrying])).toEqual({ pending: false, failed: true });
  });

  test("both loaded is neither pending nor failed", () => {
    expect(skillsLoadState([done, done])).toEqual({ pending: false, failed: false });
  });
});
