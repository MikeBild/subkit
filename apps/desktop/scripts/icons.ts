import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLATE = "#0f172a";
const MARK = "#f8fafc";
const SURFACE = "#f8fafc";
const MUTED = "#94a3b8";

export const MAC_GRID = { canvas: 1024, plate: 824, inset: 100, radius: 185.4 } as const;
export const TRAY_POINTS = 18;
export const DMG_WINDOW = { width: 540, height: 380, iconY: 190, appX: 140, linkX: 400 } as const;

export const ICONSET: readonly (readonly [string, number])[] = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

export const RENDERED: readonly (readonly [string, number, number])[] = [
  ["trayTemplate.png", TRAY_POINTS, TRAY_POINTS],
  ["trayTemplate@2x.png", TRAY_POINTS * 2, TRAY_POINTS * 2],
  ["icon-mac.png", 512, 512],
  ["dmg-background.png", DMG_WINDOW.width, DMG_WINDOW.height],
  ["dmg-background@2x.png", DMG_WINDOW.width * 2, DMG_WINDOW.height * 2],
];

export function glyphOf(favicon: string): string[] {
  const glyph = /<g class="glyph"[^>]*>([\s\S]*?)<\/g>/.exec(favicon)?.[1];
  if (!glyph) throw new Error("favicon.svg no longer carries the mark as a glyph group");
  return glyph
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function indent(lines: string[], depth: number): string[] {
  return lines.map((line) => `${"  ".repeat(depth)}${line}`);
}

export function macIconSvg(glyph: string[]): string {
  const { canvas, plate, inset, radius } = MAC_GRID;
  const scale = (plate * 22) / 32 / 24;
  const offset = inset + (plate * 5) / 32;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}" width="${canvas}" height="${canvas}" role="img" aria-label="SubKit">`,
    "  <defs>",
    '    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">',
    '      <feGaussianBlur in="SourceAlpha" stdDeviation="10" />',
    '      <feOffset dy="12" result="blur" />',
    '      <feComponentTransfer><feFuncA type="linear" slope="0.3" /></feComponentTransfer>',
    '      <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>',
    "    </filter>",
    "  </defs>",
    `  <rect x="${inset}" y="${inset}" width="${plate}" height="${plate}" rx="${radius}" fill="${PLATE}" filter="url(#shadow)" />`,
    `  <g fill="none" stroke="${MARK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="translate(${offset} ${offset}) scale(${scale.toFixed(4)})">`,
    ...indent(glyph, 2),
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

export function traySvg(glyph: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${TRAY_POINTS}" height="${TRAY_POINTS}" role="img" aria-label="SubKit">`,
    '  <g fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    ...indent(glyph, 2),
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

export function dmgBackgroundSvg(): string {
  const { width, height, iconY, appX, linkX } = DMG_WINDOW;
  const from = appX + 80;
  const to = linkX - 80;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="SubKit">`,
    `  <rect width="${width}" height="${height}" fill="${SURFACE}" />`,
    `  <g fill="none" stroke="${MUTED}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">`,
    `    <path d="M${from} ${iconY}H${to}" />`,
    `    <path d="M${to - 12} ${iconY - 12}l12 12-12 12" />`,
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
}

function render(svg: string, output: string, width: number, height = width): void {
  run([
    "rsvg-convert",
    "--width",
    String(width),
    "--height",
    String(height),
    "--output",
    output,
    svg,
  ]);
}

export async function generateIcons(root: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Rendering the icons needs macOS (iconutil)");
  const assets = join(root, "assets");
  const glyph = glyphOf(await readFile(join(root, "../cockpit/public/favicon.svg"), "utf8"));
  const sources = {
    icon: join(assets, "icon-mac.svg"),
    tray: join(assets, "tray.svg"),
    dmg: join(assets, "dmg-background.svg"),
  };
  await writeFile(sources.icon, macIconSvg(glyph));
  await writeFile(sources.tray, traySvg(glyph));
  await writeFile(sources.dmg, dmgBackgroundSvg());

  render(sources.tray, join(assets, "trayTemplate.png"), TRAY_POINTS);
  render(sources.tray, join(assets, "trayTemplate@2x.png"), TRAY_POINTS * 2);
  render(sources.icon, join(assets, "icon-mac.png"), 512);
  render(sources.dmg, join(assets, "dmg-background.png"), DMG_WINDOW.width, DMG_WINDOW.height);
  render(
    sources.dmg,
    join(assets, "dmg-background@2x.png"),
    DMG_WINDOW.width * 2,
    DMG_WINDOW.height * 2,
  );
  run([
    "tiffutil",
    "-cathidpicheck",
    join(assets, "dmg-background.png"),
    join(assets, "dmg-background@2x.png"),
    "-out",
    join(assets, "dmg-background.tiff"),
  ]);

  const scratch = await mkdtemp(join(tmpdir(), "subkit-icons-"));
  try {
    const iconset = join(scratch, "icon.iconset");
    await mkdir(iconset);
    for (const [file, size] of ICONSET) render(sources.icon, join(iconset, file), size);
    run(["iconutil", "--convert", "icns", "--output", join(assets, "icon.icns"), iconset]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`Rendered the app, menu bar and DMG icons into ${assets}`);
}
