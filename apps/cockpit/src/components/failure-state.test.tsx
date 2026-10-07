import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@/components/cockpit/patterns/test-utils";
import { ForbiddenState, queryView } from "./failure-state";

const empty = (data: { items: unknown[] }) => data.items.length === 0;
const base = { data: undefined, error: null, failureReason: null, isPending: true };

describe("queryView", () => {
  test("nothing yet and nothing wrong is loading", () => {
    expect(queryView<{ items: unknown[] }>(base, empty)).toBe("loading");
  });

  test("a failed read is an error, not an empty list", () => {
    expect(
      queryView<{ items: unknown[] }>(
        { ...base, isPending: false, error: new Error("500") },
        empty,
      ),
    ).toBe("error");
  });

  test("the first failure already counts, while the query is still retrying", () => {
    expect(
      queryView<{ items: unknown[] }>({ ...base, failureReason: new Error("500") }, empty),
    ).toBe("error");
  });

  test("rows are ready, no rows are empty", () => {
    expect(queryView({ ...base, isPending: false, data: { items: [1] } }, empty)).toBe("ready");
    expect(queryView({ ...base, isPending: false, data: { items: [] } }, empty)).toBe("empty");
  });

  test("data already on screen stays while a refresh fails", () => {
    expect(
      queryView(
        { ...base, isPending: false, data: { items: [1] }, error: new Error("500") },
        empty,
      ),
    ).toBe("ready");
  });
});

describe("ForbiddenState", () => {
  test("names the missing permission and who grants it, in both languages", () => {
    const de = render(<ForbiddenState />, "de");
    expect(de).toContain("Keine Berechtigung");
    expect(de).toContain("Rolle Administrator");
    const en = render(<ForbiddenState />, "en");
    expect(en).toContain("No permission");
    expect(en).toContain("Administrator role");
  });

  test("is a titled forbidden state inside the page, never a second page title or an action", () => {
    const html = render(<ForbiddenState />);
    expect(html).toContain('data-family-state="forbidden"');
    expect(html).toContain('data-family-failure-kind="forbidden"');
    expect(html).toContain('data-testid="resource-permission-alert"');
    expect(html).not.toContain("data-family-surface");
    expect(html).not.toMatch(/<h[1-6][\s>]/);
    expect(html).not.toMatch(/<(a|button)[\s>]/);
  });

  test("every page renders a refused read through it, not as an empty list", () => {
    const src = join(import.meta.dir, "..");
    const files = [
      ...readdirSync(join(src, "pages")).map((file) => join(src, "pages", file)),
      ...readdirSync(join(src, "components/cockpit")).map((file) =>
        join(src, "components/cockpit", file),
      ),
    ].filter((file) => file.endsWith(".tsx") && !file.includes(".test."));
    const loose = files.filter((file) =>
      readFileSync(file, "utf8").includes("resource.permission."),
    );
    expect(loose).toEqual([]);
  });
});
