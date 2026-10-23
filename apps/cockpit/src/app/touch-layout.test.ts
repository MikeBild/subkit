import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "..");
const css = readFileSync(join(src, "index.css"), "utf8");
const html = readFileSync(join(src, "..", "index.html"), "utf8");

describe("touch and phone layout", () => {
  test("controls reach a 44px target on touch screens without changing their look", () => {
    const coarse = css.slice(css.indexOf("@media (pointer: coarse) {"));
    expect(coarse).toContain(":where(button, a)[data-variant][data-size]::after");
    expect(coarse).toContain("inset: min(0px, calc((100% - 2.75rem) / 2));");
  });

  test("text fields on phones never fall below 16px, so iOS does not zoom on focus", () => {
    expect(css).toContain(
      "@media (pointer: coarse) and (width < 48rem), (pointer: coarse) and (height < 32rem) {",
    );
    expect(css).toContain("font-size: max(1rem, 1em);");
  });

  test("the app fills the dynamic viewport inside the safe area", () => {
    expect(html).toContain("viewport-fit=cover");
    expect(css).toMatch(/#root \{\s*height: 100dvh;/);
    expect(css).toContain("env(safe-area-inset-bottom)");
  });

  test("the shell frame cannot be scrolled away by focus or scrollIntoView", () => {
    const shell = readFileSync(join(src, "app/shell.tsx"), "utf8");
    const workspace = readFileSync(
      join(src, "components/cockpit/patterns/responsive-workspace.tsx"),
      "utf8",
    );
    expect(shell).toContain('<SidebarInset className="min-h-0 min-w-0 overflow-clip"');
    expect(shell).not.toContain('className="h-full min-h-0 overflow-hidden"');
    expect(workspace).toContain('className="grid min-h-0 min-w-0 flex-1 overflow-clip"');
  });
});
