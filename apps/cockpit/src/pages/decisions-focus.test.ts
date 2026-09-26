// A number that names something has to lead to that something.
//
// The overview counts four separate things and links each number at the
// decisions page. The page read exactly one of them, and read it as a KIND:
// `bucket=blocked` set the filter to "schedule", which covers TWO sections —
// held schedules and failing workflows. So clicking Blocked listed the failing
// ones too, and clicking Failing narrowed nothing at all, because that bucket
// was never read. Reported from production, in those words: "clicking failing
// does not land me at only failing workflows, and clicking blocked does not
// show me only those either".
//
// This is the same defect as "production incidents: 1" pointing at eleven
// thousand runs, one page further along.

import { expect, test } from "bun:test";
import { readFocus } from "./decisions";

test("every tile the engine links at this page is understood here", () => {
  // The four the engine emits (operator/operational-overview.ts). A bucket this
  // page does not know silently widens the list back to everything, which is
  // the failure above.
  expect(readFocus("?bucket=blocked")).toBe("blocked");
  expect(readFocus("?bucket=failing")).toBe("failing");
  expect(readFocus("?bucket=overdue")).toBe("overdue");
  expect(readFocus("?bucket=other")).toBe("other");
});

test("no bucket, or one nobody emits, shows the whole queue", () => {
  // Not an error: the page is reachable on its own, and then it is the queue.
  expect(readFocus("")).toBeNull();
  expect(readFocus("?bucket=")).toBeNull();
  expect(readFocus("?bucket=everything")).toBeNull();
  // And it cannot be talked into a section by a value that merely looks like
  // one — the list is closed, not parsed.
  expect(readFocus("?bucket=BLOCKED")).toBeNull();
});
