import { describe, expect, test } from "bun:test";
import { ffmpegLicenseProblem, productLicense, renderFfmpegNotice } from "./runtime-licenses.ts";

const LGPL =
  "In combination the LGPL v2.1+ applies to\nFFmpeg.\n\n                  GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 2.1, February 1999\n\nYou may &quot;relink&quot; the Library &amp; keep the author&#x27;s notice.";

const CREDITS = [
  '<div class="product">',
  '<span class="title">fdlibm</span>',
  '<span class="homepage"><a href="https://example.org/fdlibm">homepage</a></span>',
  '<div class="license">',
  "<pre>Permission to use fdlibm is granted.</pre>",
  "</div>",
  "</div>",
  '<div class="product">',
  '<span class="title">ffmpeg</span>',
  '<span class="homepage"><a href="https://git.ffmpeg.org/ffmpeg.git">homepage</a></span>',
  '<div class="license">',
  `<pre>${LGPL}</pre>`,
  "</div>",
  "</div>",
  '<div class="product">',
  '<span class="title">fft</span>',
  "<pre>A later entry.</pre>",
  "</div>",
].join("\n");

describe("license entries of the runtime credits file", () => {
  test("reads one entry with its homepage and decodes the text", () => {
    const license = productLicense(CREDITS, "ffmpeg");
    expect(license?.homepage).toBe("https://git.ffmpeg.org/ffmpeg.git");
    expect(license?.text).toContain('You may "relink" the Library & keep the author\'s notice.');
    expect(license?.text).not.toContain("A later entry");
    expect(license?.text).not.toContain("fdlibm");
  });

  test("answers nothing for a missing entry or an entry without text", () => {
    expect(productLicense(CREDITS, "libvpx")).toBeNull();
    expect(productLicense('<span class="title">ffmpeg</span><pre>  </pre>', "ffmpeg")).toBeNull();
  });

  test("an entry without the LGPL statement or its text is a problem", () => {
    const license = productLicense(CREDITS, "ffmpeg");
    if (!license) throw new Error("missing fixture entry");
    expect(ffmpegLicenseProblem(license)).toBeNull();
    expect(ffmpegLicenseProblem({ ...license, text: "MIT" })).toBe(
      "the FFmpeg entry no longer states that the LGPL v2.1+ applies",
    );
    expect(
      ffmpegLicenseProblem({ ...license, text: "the LGPL v2.1+ applies to FFmpeg. See COPYING." }),
    ).toBe("the FFmpeg entry no longer carries the text of the LGPL version 2.1");
  });

  test("the notice names the file it was read from, the offer and the license text", () => {
    const license = productLicense(CREDITS, "ffmpeg");
    if (!license) throw new Error("missing fixture entry");
    const notice = renderFfmpegNotice({
      runtimeVersion: "45.4.1",
      creditsFile: "LICENSES.chromium.html",
      creditsBytes: 1234,
      creditsSha256: "ab".repeat(32),
      license,
      sourceStatement: "Written offer: on request.",
    });
    expect(notice).toContain("FFMPEG IN THE ELECTRON RUNTIME (LGPL)");
    expect(notice).toContain(`LICENSES.chromium.html of the Electron 45.4.1 distribution`);
    expect(notice).toContain(`1234 bytes, SHA-256 ${"ab".repeat(32)}`);
    expect(notice).toContain("Written offer: on request.");
    expect(notice).toContain("Version 2.1, February 1999");
    expect(notice.indexOf("SOURCE AND WRITTEN OFFER")).toBeLessThan(
      notice.indexOf("LICENSE TEXT OF THE FFMPEG ENTRY"),
    );
  });
});
