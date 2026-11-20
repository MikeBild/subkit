export interface ProductLicense {
  title: string;
  homepage: string | null;
  text: string;
}

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&amp;": "&",
};

function decode(text: string): string {
  return text.replace(/&(?:lt|gt|quot|#x27|#39|amp);/g, (entity) => ENTITIES[entity] ?? entity);
}

export function productLicense(creditsHtml: string, title: string): ProductLicense | null {
  const marker = `<span class="title">${title}</span>`;
  const start = creditsHtml.indexOf(marker);
  if (start < 0) return null;
  const next = creditsHtml.indexOf('<div class="product">', start);
  const block = creditsHtml.slice(start, next < 0 ? undefined : next);
  const pre = /<pre>([\s\S]*?)<\/pre>/.exec(block);
  if (!pre?.[1]?.trim()) return null;
  const homepage = /<span class="homepage"><a href="(https:\/\/[^"]+)">/.exec(block);
  return { title, homepage: homepage?.[1] ?? null, text: decode(pre[1]).trim() };
}

export interface FfmpegNoticeInput {
  runtimeVersion: string;
  creditsFile: string;
  creditsBytes: number;
  creditsSha256: string;
  license: ProductLicense;
  sourceStatement: string;
}

export function ffmpegLicenseProblem(license: ProductLicense): string | null {
  if (!/LGPL v2\.1\+ applies to\s+FFmpeg/.test(license.text))
    return "the FFmpeg entry no longer states that the LGPL v2.1+ applies";
  if (!/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1, February 1999/.test(license.text))
    return "the FFmpeg entry no longer carries the text of the LGPL version 2.1";
  return null;
}

export function renderFfmpegNotice(input: FfmpegNoticeInput): string {
  return `${[
    "",
    "=".repeat(72),
    "FFMPEG IN THE ELECTRON RUNTIME (LGPL)",
    "",
    `Facts from ${input.creditsFile} of the Electron ${input.runtimeVersion} distribution this package was built from (${input.creditsBytes} bytes, SHA-256 ${input.creditsSha256}):`,
    `- It lists the product "${input.license.title}"${input.license.homepage ? ` with the homepage ${input.license.homepage}` : ""}.`,
    "- Its license text, reproduced unchanged below, states that the LGPL v2.1 or later applies to FFmpeg and carries the full text of the GNU Lesser General Public License version 2.1.",
    "- It does not state the configure options of the FFmpeg build that Electron ships. That the build contains none of the optional GPL parts named in the text is the statement of the Electron project and UNVERIFIED here.",
    "",
    "Electron delivers FFmpeg as a separate shared library next to the runtime (libffmpeg.dylib on macOS, ffmpeg.dll on Windows, libffmpeg.so on Linux). SubKit Desktop ships that file unmodified, does not link FFmpeg into its own code and does not restrict replacing it: put a compatible build of the library in its place to use a modified FFmpeg. On macOS the changed app must then be signed again with an identity of your own, because the operating system refuses a signed app whose files were changed.",
    "",
    "SOURCE AND WRITTEN OFFER",
    input.sourceStatement,
    "",
    "LICENSE TEXT OF THE FFMPEG ENTRY",
    input.license.text,
  ].join("\n")}\n`;
}
