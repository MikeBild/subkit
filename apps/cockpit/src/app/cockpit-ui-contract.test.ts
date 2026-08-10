import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const css = readFileSync(join(root, "apps/cockpit/src/index.css"), "utf8");
const contractCss = readFileSync(join(root, "contract/cockpit-ui.css"), "utf8");
const contractDoc = readFileSync(join(root, "contract/COCKPIT-UI.md"), "utf8");
const regions = ["tokens-light", "tokens-dark", "theme-map"] as const;

function region(source: string, name: (typeof regions)[number]): string {
  const match = source.match(
    new RegExp(
      `^\\s*/\\* cockpit-ui:begin ${name} \\*/\\n([\\s\\S]*?)^\\s*/\\* cockpit-ui:end ${name} \\*/`,
      "m",
    ),
  );
  if (!match?.[1]) throw new Error(`missing cockpit-ui region: ${name}`);
  return match[1];
}

describe("cockpit-ui family contract", () => {
  test("keeps every shared token region byte-identical", () => {
    for (const name of regions) expect(region(css, name)).toBe(region(contractCss, name));
  });

  test("pins the copied contract digest", () => {
    const digest = createHash("sha256").update(contractCss).digest("hex");
    expect(contractDoc).toContain(`Tokens-Digest: sha256:${digest}`);
  });

  test("uses the Subkit prefix outside shared regions", () => {
    let localCss = css;
    for (const name of regions) localCss = localCss.replace(region(css, name), "");
    const names = [...localCss.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((match) => match[1]);
    const allowed = new Set(["font-sans", "font-mono", "font-heading"]);
    expect(names.filter((name) => name && !allowed.has(name) && !name.startsWith("sk-"))).toEqual(
      [],
    );
  });

  test("keeps exactly one blocking inline theme script", () => {
    const html = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
    expect([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]).toHaveLength(1);
    expect(html).toContain("sk-cockpit-theme");
  });

  test("keeps interactive selection surfaces neutral", () => {
    for (const file of [
      "apps/cockpit/src/components/ui/dropdown-menu.tsx",
      "apps/cockpit/src/components/ui/select.tsx",
      "apps/cockpit/src/components/ai-elements/prompt-input.tsx",
      "apps/cockpit/src/pages/chat.tsx",
    ]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/(?:hover|focus|data-open|aria-expanded):bg-accent/);
    }
  });
});
