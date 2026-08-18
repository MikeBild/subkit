import { describe, expect, test } from "bun:test";
import { inboxHref, inboxQuery } from "./inbox-model";

describe("inboxHref", () => {
  test("points at the surface that owns the thing", () => {
    expect(inboxHref({ resource_type: "workflow", resource_id: "w1" })).toBe("/workflows/w1");
    expect(inboxHref({ resource_type: "connector", resource_id: "c1" })).toBe("/connectors/c1");
  });

  test("a collection without a detail route links to the list, not to a dead path", () => {
    expect(inboxHref({ resource_type: "execution", resource_id: "e1" })).toBe("/runs");
    expect(inboxHref({ resource_type: "patch_candidate", resource_id: "p1" })).toBe("/decisions");
  });

  test("returns null rather than a link that goes nowhere", () => {
    // A link costs a click to discover it was wrong; no link costs nothing.
    expect(inboxHref({ resource_type: null, resource_id: "x" })).toBeNull();
    expect(inboxHref({ resource_type: "workflow", resource_id: null })).toBeNull();
    expect(inboxHref({ resource_type: "something_new", resource_id: "x" })).toBeNull();
    expect(inboxHref({})).toBeNull();
  });
});

describe("inboxQuery", () => {
  test("filters are engine query parameters, so paging under them is correct", () => {
    // Filtering in the client after fetching a page yields short and empty
    // pages, because the cursor advances over rows the filter then removes.
    expect(inboxQuery("unread", 50, null)).toBe("limit=50&unread_only=true");
    expect(inboxQuery("actionable", 50, null)).toBe("limit=50&actionable_only=true");
  });

  test("carries the cursor and asks for nothing extra when unfiltered", () => {
    expect(inboxQuery("all", 25, 400)).toBe("limit=25&since=400");
    expect(inboxQuery("all", 25, null)).toBe("limit=25");
  });

  test("a zero cursor is a real cursor, not an absent one", () => {
    expect(inboxQuery("all", 25, 0)).toBe("limit=25&since=0");
  });
});
