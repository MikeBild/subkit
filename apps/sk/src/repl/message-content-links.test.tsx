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

function linkTargets(frame: string): string[] {
  const targets: string[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC + BEL by design — OSC 8 sequences are literal control bytes.
  const re = /\x1b\]8;;([^\x07]*)\x07/g;
  for (const m of frame.matchAll(re)) {
    if (m[1]) targets.push(m[1]);
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
    const targets = linkTargets(frame);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target).toBe(url);
    }
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
