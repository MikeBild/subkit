// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens are the subject under test — these are intentional placeholders.
// Unit tests for the unsupported-placeholder detector.
//
// Locks down the behaviour that addresses session f00b8d1c — every
// placeholder shape the LLM tried that the runtime would silently
// pass through must now produce a structured detection with a
// concrete `did_you_mean` rewrite.

import { describe, expect, test } from "bun:test";
import { findUnsupportedPlaceholders } from "../unsupported.ts";

describe("findUnsupportedPlaceholders", () => {
  test("flags Mustache placeholders", () => {
    const found = findUnsupportedPlaceholders("/v2/projects/{{ $item.id }}/resources");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("mustache");
    expect(found[0]?.did_you_mean).toBe("${item.id}");
    expect(found[0]?.raw).toBe("{{ $item.id }}");
  });

  test("flags Mustache with $loop alias", () => {
    const found = findUnsupportedPlaceholders("/v2/projects/{{ $loop.item.id }}/resources");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("mustache");
    expect(found[0]?.did_you_mean).toBe("${item.id}");
  });

  test("flags Mustache with bare loop reference", () => {
    const found = findUnsupportedPlaceholders("/users/{{ orders }}");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("mustache");
    // Single bare identifier becomes `${item.<path>}` — best guess is
    // it's a loop alias.
    expect(found[0]?.did_you_mean).toBe("${item.orders}");
  });

  test("flags ${$loop.X} alias", () => {
    const found = findUnsupportedPlaceholders("/v2/projects/${$loop.item.id}/resources");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("loop_alias");
    expect(found[0]?.did_you_mean).toBe("${item.id}");
  });

  test("flags ${loop.X} alias", () => {
    const found = findUnsupportedPlaceholders("${loop.item.id}");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("loop_alias");
    expect(found[0]?.did_you_mean).toBe("${item.id}");
  });

  test("flags ${$item.X} alias", () => {
    const found = findUnsupportedPlaceholders("/v2/projects/${$item.id}");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("item_alias");
    expect(found[0]?.did_you_mean).toBe("${item.id}");
  });

  test("flags bad kinds (${user.X})", () => {
    const found = findUnsupportedPlaceholders("/users/${user.id}");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("bad_kind");
    // 2+ segment dotted paths default to `${scope.<head>.<rest>}` —
    // `user` is more likely a step id than a loop alias when a path
    // exists, and `scope.user.id` parses cleanly.
    expect(found[0]?.did_you_mean).toBe("${scope.user.id}");
  });

  test("flags bad kinds with multi-segment path (${project.deeply.nested})", () => {
    const found = findUnsupportedPlaceholders("/x/${project.deeply.nested}");
    expect(found.length).toBe(1);
    expect(found[0]?.code).toBe("bad_kind");
    expect(found[0]?.did_you_mean).toBe("${scope.project.deeply.nested}");
  });

  test("does NOT flag well-formed placeholders", () => {
    const found = findUnsupportedPlaceholders(
      "/users/${item.id}/orders/${scope.fetch.data.orders[0].id}",
    );
    expect(found).toEqual([]);
  });

  test("does NOT flag $$-escaped placeholders", () => {
    const found = findUnsupportedPlaceholders("$${item.id} is literal");
    expect(found).toEqual([]);
  });

  test("does NOT flag the bare base URL or path", () => {
    expect(findUnsupportedPlaceholders("https://api.example.com/v2/projects")).toEqual([]);
    expect(findUnsupportedPlaceholders("links.self")).toEqual([]);
  });

  test("flags multiple shapes in a single string in source order", () => {
    const found = findUnsupportedPlaceholders("/{{ a }}/x/${$loop.b}/y/${user.c}");
    expect(found.length).toBe(3);
    expect(found.map((m) => m.code)).toEqual(["mustache", "loop_alias", "bad_kind"]);
  });

  test("rewrite handles currentItem (reference impl idiom)", () => {
    const found = findUnsupportedPlaceholders("/x/{{ currentItem.id }}");
    expect(found[0]?.did_you_mean).toBe("${item.id}");
  });
});
