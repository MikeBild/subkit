// The budget a caller is told about must be the budget that refuses them.
//
// Found on a live installation, after the workspace cap had just been made
// settable: `get_token_budget` still answered `budget_tokens: null`. It took
// the per-user branch, read the per-user ceiling — unset, as it is on every
// installation that never configured one — and reported "nothing bounds you",
// while a workspace cap of a hundred and fifty million was what would stop
// the next call.
//
// `checkAndDecrement` treats the per-user cap as an ADDITIONAL ceiling on top
// of the workspace's, so the binding one is whichever has less room left.

import { describe, expect, test } from "bun:test";
import { bindingCeiling } from "./metrics.ts";

describe("which ceiling refuses first", () => {
  test("the workspace binds when the caller has no personal cap", () => {
    // The live case. Before the fix this answered as though nothing bound.
    expect(bindingCeiling(null, 115_822_246)).toBe("tenant");
  });

  test("the personal cap binds when the workspace has none", () => {
    expect(bindingCeiling(500, null)).toBe("user");
  });

  test("the tighter of the two binds", () => {
    expect(bindingCeiling(500, 9_000)).toBe("user");
    expect(bindingCeiling(9_000, 500)).toBe("tenant");
  });

  test("a tie goes to the personal cap, which the dispatch evaluates first", () => {
    expect(bindingCeiling(1_000, 1_000)).toBe("user");
  });

  test("nothing binds when neither ceiling exists", () => {
    expect(bindingCeiling(null, null)).toBeNull();
  });

  test("an exhausted ceiling still binds — zero left is not no cap", () => {
    // `null` means absent. `0` means there is a cap and it is used up. Reading
    // them as the same thing is how an exhausted workspace would report itself
    // as unlimited.
    expect(bindingCeiling(0, null)).toBe("user");
    expect(bindingCeiling(null, 0)).toBe("tenant");
    expect(bindingCeiling(0, 5_000)).toBe("user");
  });
});
