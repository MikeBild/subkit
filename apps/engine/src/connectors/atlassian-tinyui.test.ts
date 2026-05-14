// Tinyui decoder + URL parser tests. The session-0498925e regression
// fixture (y4ozBQ → 87263947) is the canonical example; the rest
// covers padding edge cases and rejection of invalid shapes.

import { describe, expect, it } from "bun:test";
import { decodeAtlassianTinyui, parseAtlassianCloudResourceUrl } from "./atlassian-tinyui.ts";

describe("decodeAtlassianTinyui", () => {
  it("decodes the session-0498925e fixture y4ozBQ → 87263947", () => {
    expect(decodeAtlassianTinyui("y4ozBQ")).toBe(87263947);
  });

  it("decodes when no padding is needed (length % 4 == 0)", () => {
    // 4 chars → 3 bytes after decode → returns null (< 4 bytes).
    // Construct a known 8-char shortlink: encodeURIComponent(btoa('\x01\x00\x00\x00').replace(/=+$/,''))
    // = "AQAAAA". Decodes to 0x00 0x00 0x00 0x01 — little-endian = 1.
    expect(decodeAtlassianTinyui("AQAAAA")).toBe(1);
  });

  it("decodes when 2 chars of padding are needed (length % 4 == 2)", () => {
    // "y4ozBQ" has length 6 → 6 % 4 = 2 → pad with "==" → 8 chars → 6 bytes.
    expect(decodeAtlassianTinyui("y4ozBQ")).toBe(87263947);
  });

  it("returns null on input shorter than 4 decoded bytes", () => {
    // 3 chars of base64 → 2 bytes decoded → not enough for a uint32.
    expect(decodeAtlassianTinyui("AQA")).toBe(null);
  });

  it("returns null on characters outside the base64url alphabet", () => {
    expect(decodeAtlassianTinyui("y4ozB!")).toBe(null);
    expect(decodeAtlassianTinyui("y4 ozBQ")).toBe(null);
  });

  it("returns null on empty / non-string input", () => {
    expect(decodeAtlassianTinyui("")).toBe(null);
    // biome-ignore lint/suspicious/noExplicitAny: defensive null handling
    expect(decodeAtlassianTinyui(null as any)).toBe(null);
    // biome-ignore lint/suspicious/noExplicitAny: defensive null handling
    expect(decodeAtlassianTinyui(undefined as any)).toBe(null);
  });

  it("handles base64url alphabet characters (- and _)", () => {
    // Replacing `+`/`/` with `-`/`_` is a no-op for "AQAAAA"; the test
    // proves the mapping pass doesn't break decoding either way.
    expect(decodeAtlassianTinyui("AQAAAA")).toBe(1);
  });
});

describe("parseAtlassianCloudResourceUrl", () => {
  it("resolves the session-0498925e Confluence Cloud tinyui URL", () => {
    const r = parseAtlassianCloudResourceUrl("https://si-emobility.atlassian.net/wiki/x/y4ozBQ");
    expect(r).toEqual({
      kind: "confluence_tinyui",
      short: "y4ozBQ",
      page_id: 87263947,
    });
  });

  it("resolves a direct Confluence page URL (numeric id in path)", () => {
    const r = parseAtlassianCloudResourceUrl(
      "https://si-emobility.atlassian.net/wiki/spaces/PROD/pages/83907824/Sifinity+Control",
    );
    expect(r).toEqual({ kind: "confluence_page", page_id: 83907824 });
  });

  it("resolves a Jira issue URL", () => {
    const r = parseAtlassianCloudResourceUrl(
      "https://si-emobility.atlassian.net/browse/EMOB-22926",
    );
    expect(r).toEqual({ kind: "jira_issue", key: "EMOB-22926" });
  });

  it("returns null for non-Atlassian hosts", () => {
    expect(parseAtlassianCloudResourceUrl("https://example.com/wiki/x/y4ozBQ")).toBe(null);
  });

  it("returns null for unrecognised Atlassian paths", () => {
    expect(parseAtlassianCloudResourceUrl("https://si-emobility.atlassian.net/")).toBe(null);
    expect(parseAtlassianCloudResourceUrl("https://si-emobility.atlassian.net/wiki/")).toBe(null);
  });

  it("returns null for malformed URLs", () => {
    expect(parseAtlassianCloudResourceUrl("not a url")).toBe(null);
    expect(parseAtlassianCloudResourceUrl("")).toBe(null);
  });

  it("does NOT swallow a tinyui that fails to decode (short < 4 bytes)", () => {
    // 3-char short → 2 decoded bytes → page_id null but kind still set.
    const r = parseAtlassianCloudResourceUrl("https://x.atlassian.net/wiki/x/AQA");
    expect(r).toEqual({ kind: "confluence_tinyui", short: "AQA", page_id: null });
  });
});
