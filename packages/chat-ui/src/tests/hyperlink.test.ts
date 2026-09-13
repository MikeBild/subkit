import { describe, expect, test } from "bun:test";

import { hyperlink, renderTextWithLinks } from "../hyperlink.ts";

const URL = "https://github.com/MikeBild/subkit/compare/subkit-v6.10.0...subkit-v6.10.1";
const OSC8 = (url: string, text = url) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

describe("hyperlink — supported terminal emits OSC 8", () => {
  test("display text defaults to the full URL so a copy yields the URL", () => {
    expect(hyperlink(URL, undefined, true)).toBe(OSC8(URL));
  });
  test("explicit display text is wrapped, URL stays the target", () => {
    expect(hyperlink(URL, "release notes", true)).toBe(OSC8(URL, "release notes"));
  });
});

describe("hyperlink — unsupported terminal falls back to plain (copyable) text", () => {
  test("no display text → bare URL (NOT terminal-link's space-joined form)", () => {
    const out = hyperlink(URL, undefined, false);
    expect(out).toBe(URL);
    expect(out).not.toContain("\x1b"); // no escapes
    expect(out).not.toContain(" "); // never `text url`
  });
  test("with a label → `label: url` (still no escapes, URL intact for copy)", () => {
    expect(hyperlink(URL, "release notes", false)).toBe(`release notes: ${URL}`);
  });
});

describe("renderTextWithLinks", () => {
  test("supported: each URL becomes a single OSC 8 click target", () => {
    const text = `see ${URL} for details`;
    expect(renderTextWithLinks(text, true)).toBe(`see ${OSC8(URL)} for details`);
  });
  test("unsupported: URLs stay plain, prose untouched", () => {
    const text = `see ${URL} for details`;
    expect(renderTextWithLinks(text, false)).toBe(text);
  });
  test("trailing sentence punctuation is not captured into the link", () => {
    const out = renderTextWithLinks(`open ${URL}.`, true);
    // The dot stays OUTSIDE the OSC 8 target.
    expect(out).toBe(`open ${OSC8(URL)}.`);
  });
  test("prose with no URL is returned unchanged", () => {
    expect(renderTextWithLinks("just some text", true)).toBe("just some text");
    expect(renderTextWithLinks("just some text", false)).toBe("just some text");
  });
});
