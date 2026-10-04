import { describe, expect, it } from "bun:test";
import { decodeAtlassianTinyui, parseAtlassianCloudResourceUrl } from "./atlassian-tinyui.ts";

describe("decodeAtlassianTinyui", () => {
  it("decodes the fixture y4ozBQ → 87263947", () => {
    expect(decodeAtlassianTinyui("y4ozBQ")).toBe(87263947);
  });

  it("decodes when no padding is needed (length % 4 == 0)", () => {
    expect(decodeAtlassianTinyui("AQAAAA")).toBe(1);
  });

  it("decodes when 2 chars of padding are needed (length % 4 == 2)", () => {
    expect(decodeAtlassianTinyui("y4ozBQ")).toBe(87263947);
  });

  it("returns null on input shorter than 4 decoded bytes", () => {
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
    expect(decodeAtlassianTinyui("AQAAAA")).toBe(1);
  });
});

describe("parseAtlassianCloudResourceUrl", () => {
  it("resolves a Confluence Cloud tinyui URL", () => {
    const r = parseAtlassianCloudResourceUrl("https://acme.atlassian.net/wiki/x/y4ozBQ");
    expect(r).toEqual({
      kind: "confluence_tinyui",
      short: "y4ozBQ",
      page_id: 87263947,
    });
  });

  it("resolves a direct Confluence page URL (numeric id in path)", () => {
    const r = parseAtlassianCloudResourceUrl(
      "https://acme.atlassian.net/wiki/spaces/PROD/pages/83907824/Widget+Control",
    );
    expect(r).toEqual({ kind: "confluence_page", page_id: 83907824 });
  });

  it("resolves a Jira issue URL", () => {
    const r = parseAtlassianCloudResourceUrl("https://acme.atlassian.net/browse/ACME-22926");
    expect(r).toEqual({ kind: "jira_issue", key: "ACME-22926" });
  });

  it("returns null for non-Atlassian hosts", () => {
    expect(parseAtlassianCloudResourceUrl("https://example.com/wiki/x/y4ozBQ")).toBe(null);
  });

  it("returns null for unrecognised Atlassian paths", () => {
    expect(parseAtlassianCloudResourceUrl("https://acme.atlassian.net/")).toBe(null);
    expect(parseAtlassianCloudResourceUrl("https://acme.atlassian.net/wiki/")).toBe(null);
  });

  it("returns null for malformed URLs", () => {
    expect(parseAtlassianCloudResourceUrl("not a url")).toBe(null);
    expect(parseAtlassianCloudResourceUrl("")).toBe(null);
  });

  it("does NOT swallow a tinyui that fails to decode (short < 4 bytes)", () => {
    const r = parseAtlassianCloudResourceUrl("https://x.atlassian.net/wiki/x/AQA");
    expect(r).toEqual({ kind: "confluence_tinyui", short: "AQA", page_id: null });
  });
});
