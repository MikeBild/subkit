import { describe, expect, test } from "bun:test";
import { computeLineDiff, focusDiff } from "@/lib/line-diff";
import { VersionChange } from "./diff-card";
import { render } from "./patterns/test-utils";

describe("VersionChange", () => {
  test("shows Vorher and Nachher side by side, stacked on narrow screens", () => {
    const rows = focusDiff(computeLineDiff(["Be brief.", "Use du."], ["Be brief.", "Use Sie."]));
    const html = render(<VersionChange label="Änderung gegenüber v2" rows={rows} testId="v" />);
    expect(html).toContain("Änderung gegenüber v2");
    expect(html).toContain("grid gap-2 sm:grid-cols-2");
    const before = html.slice(
      html.indexOf('data-testid="v-before"'),
      html.indexOf('data-testid="v-after"'),
    );
    const after = html.slice(html.indexOf('data-testid="v-after"'));
    expect(before).toContain("Vorher");
    expect(before).toContain('data-diff-line="removed"');
    expect(before).toContain("Use du.");
    expect(before).not.toContain("Use Sie.");
    expect(after).toContain("Nachher");
    expect(after).toContain('data-diff-line="added"');
    expect(after).toContain("Use Sie.");
    expect(after).not.toContain("Use du.");
  });

  test("tints come from theme tokens and never form a side stripe", () => {
    const rows = focusDiff(computeLineDiff(["a"], ["b"]));
    const html = render(<VersionChange label="Änderung" rows={rows} testId="v" />);
    expect(html).toContain("bg-destructive/5");
    expect(html).toContain("bg-success/5");
    expect(html).not.toMatch(/border-l|red-\d|emerald-\d/);
  });

  test("English labels the panels Before and After", () => {
    const rows = focusDiff(computeLineDiff(["a"], ["b"]));
    const html = render(<VersionChange label="Change" rows={rows} testId="v" />, "en");
    expect(html).toContain("Before");
    expect(html).toContain("After");
  });

  test("an unchanged body says so instead of an empty diff", () => {
    const html = render(<VersionChange label="Änderung" rows={[]} testId="v" />);
    expect(html).toContain('data-testid="v-unchanged"');
    expect(html).toContain("Der Inhalt ist derselbe wie in der Version davor.");
    expect(html).not.toContain('data-testid="v-diff"');
  });
});
