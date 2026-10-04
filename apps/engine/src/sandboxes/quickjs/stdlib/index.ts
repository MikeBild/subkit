import stdlibSource from "./stdlib.js" with { type: "text" };

export const STDLIB_SOURCE: string = (stdlibSource as unknown as string)
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

const versionMatch = STDLIB_SOURCE.match(/version:\s*"([^"]+)"/);
if (!versionMatch) {
  throw new Error("sk-stdlib: could not extract version from stdlib.js");
}

export const STDLIB_VERSION: string = versionMatch[1] ?? "0.0.0";
