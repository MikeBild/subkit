import { describe, expect, test } from "bun:test";
import { computeLineDiff, focusDiff } from "@/lib/line-diff";
import { VersionChange } from "./diff-card";
import { render } from "./patterns/test-utils";

describe("VersionChange", () => {
  test("shows removed and added lines in one unified view under its label", () => {
    const rows = focusDiff(computeLineDiff(["Be brief.", "Use du."], ["Be brief.", "Use Sie."]));
    const html = render(<VersionChange label="Änderung gegenüber v2" rows={rows} testId="v" />);
    expect(html).toContain("Änderung gegenüber v2");
    expect(html).toContain('data-testid="v-diff"');
    expect(html).toContain('data-diff-line="removed"');
    expect(html).toContain('data-diff-line="added"');
    expect(html).toContain("- Use du.");
    expect(html).toContain("+ Use Sie.");
    expect(html).not.toContain("border-l");
  });

  test("an unchanged body says so instead of an empty diff", () => {
    const html = render(<VersionChange label="Änderung" rows={[]} testId="v" />);
    expect(html).toContain('data-testid="v-unchanged"');
    expect(html).toContain("Der Inhalt ist derselbe wie in der Version davor.");
    expect(html).not.toContain('data-testid="v-diff"');
  });
});
