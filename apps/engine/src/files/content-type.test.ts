import { describe, expect, test } from "bun:test";
import { storedContentHeaders } from "./content-type.ts";

describe("storedContentHeaders", () => {
  test("active content is downloaded and sandboxed instead of rendered", () => {
    for (const contentType of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml"]) {
      const headers = storedContentHeaders(contentType, "page.html");
      expect(headers["content-disposition"]).toStartWith("attachment;");
      expect(headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
      expect(headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  test("a missing or unknown type is downloaded", () => {
    expect(storedContentHeaders(null, "blob")["content-type"]).toBe("application/octet-stream");
    expect(storedContentHeaders(null, "blob")["content-disposition"]).toStartWith("attachment;");
    expect(
      storedContentHeaders("application/x-unknown", "a.bin")["content-disposition"],
    ).toStartWith("attachment;");
  });

  test("passive media and plain text stay viewable inline", () => {
    for (const [stored, served] of [
      ["image/png", "image/png"],
      ["IMAGE/JPEG", "image/jpeg"],
      ["text/plain; charset=UTF-8", "text/plain; charset=utf-8"],
      ["video/mp4; codecs=avc1", "video/mp4"],
      ["audio/mpeg", "audio/mpeg"],
    ] as const) {
      const headers = storedContentHeaders(stored, "x");
      expect(headers["content-disposition"]).toStartWith("inline;");
      expect(headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
      expect(headers["content-type"]).toBe(served);
    }
  });

  test("only the validated base type is served, so a stored value cannot smuggle a second type", () => {
    const smuggled = storedContentHeaders("application/pdf;,text/html", "x.pdf");
    expect(smuggled["content-type"]).toBe("application/pdf");
    for (const stored of [
      "application/pdf, text/html",
      "text/plain\r\nx-injected: 1",
      "text/plain; charset=utf-8,text/html",
      "nonsense",
      "",
    ]) {
      const headers = storedContentHeaders(stored, "x");
      expect(headers["content-type"]).not.toContain("html");
      expect(headers["content-type"]).not.toContain("\n");
      expect(headers["content-type"]).not.toContain(",");
    }
    expect(storedContentHeaders("application/pdf, text/html", "x")).toMatchObject({
      "content-type": "application/octet-stream",
      "content-security-policy": "sandbox; default-src 'none'",
    });
    expect(
      storedContentHeaders("application/pdf, text/html", "x")["content-disposition"],
    ).toStartWith("attachment;");
  });

  test("a PDF stays inline without the sandbox that would block the browser viewer", () => {
    const headers = storedContentHeaders("application/pdf", "report.pdf");
    expect(headers["content-disposition"]).toStartWith("inline;");
    expect(headers["content-security-policy"]).toBeUndefined();
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  test("the filename cannot break out of the header", () => {
    const headers = storedContentHeaders("text/html", 'a"b\\c\r\nx: y-Ä.html');
    expect(headers["content-disposition"]).toBe(
      `attachment; filename="a_b_c__x: y-_.html"; filename*=UTF-8''a%22b%5Cc%0D%0Ax%3A%20y-%C3%84.html`,
    );
    expect(storedContentHeaders("text/plain", "it's (1)*.txt")["content-disposition"]).toBe(
      `inline; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A.txt`,
    );
  });
});
