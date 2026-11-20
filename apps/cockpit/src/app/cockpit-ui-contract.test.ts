import { describe, expect, test } from "bun:test";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const css = readFileSync(join(root, "apps/cockpit/src/index.css"), "utf8");
const contractCss = readFileSync(join(root, "contract/cockpit-ui.css"), "utf8");
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
  test("maps every contract rule to existing local evidence", () => {
    const conformance = JSON.parse(
      readFileSync(join(root, "contract/conformance.cockpit-ui.json"), "utf8"),
    ) as { contract: string; rules: Record<string, { enforced_by: string[]; why?: string }> };

    expect(conformance.contract).toBe("cockpit-ui");
    expect(Object.keys(conformance.rules).length).toBeGreaterThan(0);
    for (const rule of Object.values(conformance.rules)) {
      if (rule.enforced_by.length === 0) expect(rule.why?.trim().length ?? 0).toBeGreaterThan(0);
      for (const file of rule.enforced_by) expect(existsSync(join(root, file))).toBe(true);
    }
  });

  test("keeps every shared token region byte-identical", () => {
    for (const name of regions) expect(region(css, name)).toBe(region(contractCss, name));
  });

  test("uses the Subkit prefix outside shared regions", () => {
    let localCss = css;
    for (const name of regions) localCss = localCss.replace(region(css, name), "");
    const names = [...localCss.matchAll(/^\s*--([a-z0-9-]+):/gm)].map((match) => match[1]);
    const allowed = new Set([
      "font-sans",
      "font-mono",
      "font-heading",
      "radius-sm",
      "radius-md",
      "radius-lg",
      "radius-xl",
      "radius-2xl",
      "text-lg",
      "text-lg--line-height",
      "text-3xl",
      "text-3xl--line-height",
    ]);
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
      ...globSync("apps/cockpit/src/features/chat/**/*.tsx", { cwd: root }),
    ]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/(?:hover|focus|data-open|aria-expanded):bg-accent/);
    }
  });

  test("keeps the local action grammar and spacing contract explicit", () => {
    const button = readFileSync(join(root, "apps/cockpit/src/components/ui/button.tsx"), "utf8");
    expect(button).toContain('default: "bg-primary text-primary-foreground hover:bg-primary/90"');
    expect(button).toContain('link: "text-accent underline-offset-4 hover:underline"');
    expect(button).not.toContain('default: "bg-accent');

    for (const file of [
      "apps/cockpit/src/pages/admin.tsx",
      "apps/cockpit/src/pages/settings.tsx",
      "apps/cockpit/src/pages/chat.tsx",
      "apps/cockpit/src/pages/catalog.tsx",
      "apps/cockpit/src/pages/runs.tsx",
      "apps/cockpit/src/pages/audit.tsx",
      "apps/cockpit/src/pages/usage.tsx",
      "apps/cockpit/src/components/cockpit/patterns/page.tsx",
      "apps/cockpit/src/components/cockpit/patterns/page-header.tsx",
      "apps/cockpit/src/components/cockpit/patterns/data-table.tsx",
      "apps/cockpit/src/components/cockpit/table-columns.tsx",
      "apps/cockpit/src/components/ai-elements/tool.tsx",
      "apps/cockpit/src/components/ai-elements/prompt-input.tsx",
      ...globSync("apps/cockpit/src/features/**/*.tsx", { cwd: root }),
    ]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/(?:^|[" ])space-[xy]-/);
    }
  });
});
