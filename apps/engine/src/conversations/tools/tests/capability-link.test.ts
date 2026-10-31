import { describe, expect, test } from "bun:test";
import { CAPABILITY_LINK_NOTICE, hideCapabilityLinks } from "../capability-link.ts";

describe("hideCapabilityLinks", () => {
  test("replaces links that carry a capability in the fragment, at any depth", () => {
    const link = `https://support.example/portal#access=${"a".repeat(43)}`;
    expect(hideCapabilityLinks({ data: { output: { url: link, number: 2 } } })).toEqual({
      data: { output: { url: CAPABILITY_LINK_NOTICE, number: 2 } },
    });
  });

  test("keeps ordinary links and values", () => {
    const value = { docs: "https://example.com/guide#setup", items: ["a", 1, null] };
    expect(hideCapabilityLinks(value)).toEqual(value);
  });
});
