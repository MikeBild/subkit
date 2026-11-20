import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const mark = join(root, "../cockpit/public/favicon.svg");
const assets = join(root, "assets");
const POINTS = 18;

const source = await readFile(mark, "utf8");
const glyph = /<g class="glyph"[^>]*>([\s\S]*?)<\/g>/.exec(source)?.[1];
if (!glyph) throw new Error(`No glyph group found in ${mark}`);

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${POINTS}" height="${POINTS}" role="img" aria-label="SubKit">`,
  '  <g fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
  ...glyph
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `    ${line}`),
  "  </g>",
  "</svg>",
  "",
].join("\n");

await mkdir(assets, { recursive: true });
const template = join(assets, "tray.svg");
await writeFile(template, svg);

for (const [file, scale] of [
  ["trayTemplate.png", 1],
  ["trayTemplate@2x.png", 2],
] as const) {
  const size = String(POINTS * scale);
  const render = Bun.spawnSync(
    ["rsvg-convert", "--width", size, "--height", size, "--output", join(assets, file), template],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (render.exitCode !== 0) throw new Error(`rsvg-convert failed for ${file}`);
}
console.log(`Wrote the menu bar template image into ${assets}`);
