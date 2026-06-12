// Fix 4 (plan review-last-login-thu-velvet-fiddle): URLs in assistant
// prose must be clickable in sk. MessageContent pipes text parts (and
// the no-parts fallback) through the shared OSC 8 helper; code blocks
// and tables stay byte-exact. The test env is non-TTY, so OSC 8 is
// forced on (same discipline as the ConfirmPrompt G11 tests) and the
// cache reset keeps detection deterministic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetHyperlinkSupportCacheForTests } from "@chat-ui/index.ts";
import { render } from "ink-testing-library";
import { MessageContent } from "./message-content.tsx";

const OSC8_START = "\x1b]8;;";
const OSC8_END = "\x07";

beforeEach(() => {
  process.env.SK_FORCE_HYPERLINKS = "1";
  resetHyperlinkSupportCacheForTests();
});
afterEach(() => {
  delete process.env.SK_FORCE_HYPERLINKS;
  resetHyperlinkSupportCacheForTests();
});

/** Every OSC 8 link target in `frame`, in order of appearance. */
function linkTargets(frame: string): string[] {
  const targets: string[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC + BEL by design — OSC 8 sequences are literal control bytes.
  const re = /\x1b\]8;;([^\x07]*)\x07/g;
  for (const m of frame.matchAll(re)) {
    if (m[1]) targets.push(m[1]); // closers carry an empty target
  }
  return targets;
}

describe("MessageContent · OSC 8 linkification", () => {
  test("URLs in plain text parts become OSC 8 hyperlinks", () => {
    const url = "https://engine.example.com/v1/connectors/abc/oauth/start?grant=skog_test";
    const r = render(
      <MessageContent
        content=""
        parts={[{ type: "text", text: `Open this link: ${url} to sign in.` }]}
        width={200}
      />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain(`${OSC8_START}${url}${OSC8_END}`);
    expect(frame).toContain(`${OSC8_START}${OSC8_END}`);
    r.unmount();
  });

  test("the no-parts fallback path linkifies too", () => {
    const url = "https://example.com/docs";
    // No `parts` prop → content is parsed; a bare prose line stays a
    // text part and must come out linkified either way.
    const r = render(<MessageContent content={`See ${url} for details.`} width={200} />);
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain(`${OSC8_START}${url}${OSC8_END}`);
    r.unmount();
  });

  test("markdown stripping happens BEFORE linkification — `code`-quoted URL still links", () => {
    const url = "https://example.com/path";
    const r = render(
      <MessageContent
        content=""
        parts={[{ type: "text", text: `see \`${url}\` now` }]}
        width={200}
      />,
    );
    const frame = r.lastFrame() ?? "";
    // normalizeInlineMarkdown removes the backticks; the bare URL then
    // becomes a link whose target carries no backtick residue.
    expect(frame).toContain(`${OSC8_START}${url}${OSC8_END}`);
    r.unmount();
  });

  test("a long URL wrapped at narrow width keeps every OSC 8 target intact (clickable on every line)", () => {
    const url =
      "https://engine.example.com/v1/connectors/0a1b2c3d-4e5f-6789-abcd-ef0123456789/oauth/start?grant=skog_AAAABBBBCCCCDDDDEEEEFFFF0000111122223333";
    const r = render(
      <MessageContent
        content=""
        parts={[{ type: "text", text: `Open this link to re-authorize: ${url} and come back.` }]}
        width={40}
      />,
    );
    const frame = r.lastFrame() ?? "";
    // The visible text may wrap, but ink/wrap-ansi must re-open the
    // hyperlink per visual line — every non-empty OSC 8 target is the
    // FULL unsplit URL, so clicking any segment opens the right page.
    const targets = linkTargets(frame);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toBe(url);
    }
    // Balanced escapes: every `\x1b]8;;…` start has a BEL terminator,
    // i.e. no start marker was split mid-sequence by the wrapper.
    const starts = frame.split(OSC8_START).length - 1;
    const ends = frame.split(OSC8_END).length - 1;
    expect(starts).toBe(ends);
    r.unmount();
  });

  test("code blocks are NOT linkified", () => {
    const url = "https://example.com/in-code";
    const r = render(
      <MessageContent
        content=""
        parts={[
          { type: "code_block", code: `curl ${url}`, language: "bash" },
          { type: "text", text: `docs at ${url}` },
        ]}
        width={200}
      />,
    );
    const frame = r.lastFrame() ?? "";
    // Exactly ONE link (the text part); the code block keeps the raw URL.
    const targets = linkTargets(frame);
    expect(targets).toEqual([url]);
    r.unmount();
  });

  test("table parts are NOT linkified", () => {
    const url = "https://example.com/in-table";
    const r = render(
      <MessageContent
        content=""
        parts={[{ type: "table", headers: ["link"], rows: [[url]] }]}
        width={200}
      />,
    );
    const frame = r.lastFrame() ?? "";
    expect(linkTargets(frame)).toEqual([]);
    r.unmount();
  });

  test("plain prose without URLs carries no escape sequences", () => {
    const r = render(
      <MessageContent
        content=""
        parts={[{ type: "text", text: "No links here — just prose." }]}
        width={200}
      />,
    );
    const frame = r.lastFrame() ?? "";
    expect(frame).not.toContain(OSC8_START);
    r.unmount();
  });
});
