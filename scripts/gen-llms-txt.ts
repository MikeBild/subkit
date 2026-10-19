import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLMS_PAGE_PATHS, type LlmsPage, renderLlmsIndex } from "@shared/llms-index.ts";

const OUT_DIR = "apps/engine/src/http/llms";

function readmeReference(heading: string): string {
  const readme = readFileSync("README.md", "utf8");
  const start = readme.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`README.md has no ${heading} section`);
  const rest = readme.slice(start);
  const nextSection = rest.slice(1).search(/\n## (?!#)/);
  const section = nextSection < 0 ? rest : rest.slice(0, nextSection + 1);
  return section.replace(/^## /, "# ").trimEnd();
}

const SOURCES: Record<string, () => string> = {
  "setup.md": () =>
    readFileSync("README.md", "utf8").replace(
      /\[([^\]]+)\]\(((?:\.\.\/|\.\/)?[A-Za-z0-9_./-]+\.md)(#[^)]*)?\)/g,
      (link, label: string, path: string) =>
        LLMS_PAGE_PATHS.includes(path) ? link : `${label} (\`${path}\` in the source repository)`,
    ),
  "coding-agents.md": () => readmeReference("Use sk from a coding agent"),
  "transactional-email.md": () => readmeReference("Transactional email replies"),
  "cli.md": () => run("scripts/gen-cli-reference.ts"),
  "settings.md": () => run("apps/engine/scripts/gen-settings-doc.ts"),
  "connectors.md": () => run("scripts/gen-catalog.ts"),
};

function run(script: string): string {
  const res = Bun.spawnSync(["bun", "run", script], { stdout: "pipe", stderr: "inherit" });
  if (res.exitCode !== 0) throw new Error(`${script} exited with ${res.exitCode}`);
  return res.stdout.toString();
}

function stripGeneratedMarker(markdown: string): string {
  return markdown.replace(/^<!--[^\n]*-->\n+/, "").trimEnd();
}

function title(markdown: string, path: string): string {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  if (!m?.[1]) throw new Error(`${path} has no H1`);
  return m[1];
}

function summary(markdown: string): string {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || /^(#|>|\||!\[|```|[-*+]\s|\d+\.\s|<)/.test(text)) continue;
    const plain = text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ");
    return (plain.match(/^(.*?[.!?])(?:\s|$)/)?.[1] ?? plain).trim();
  }
  return "";
}

const pages: Array<LlmsPage & { body: string }> = LLMS_PAGE_PATHS.map((path) => {
  const source = SOURCES[path];
  if (!source) throw new Error(`no source for ${path}`);
  const body = stripGeneratedMarker(source());
  return { path, title: title(body, path), summary: summary(body), body };
});

const full = [
  renderLlmsIndex(pages, { linkFor: (p) => `llms/${p.path}`, fullUrl: "llms-full.txt" }),
  ...pages.map((p) => `\n<!-- Source: ${p.path} -->\n\n${p.body}`),
].join("\n");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "llms-full.txt"), `${full}\n`);
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  `${JSON.stringify({ pages: pages.map(({ body: _b, ...p }) => p) }, null, 2)}\n`,
);
