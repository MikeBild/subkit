import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Measured, measureClass } from "./measure";
import { PageTitle } from "./page-title";

describe("measure", () => {
  test("every measure caps the width", () => {
    for (const m of ["label", "name", "excerpt"] as const)
      expect(measureClass(m)).toMatch(/max-w-/);
  });

  test("measured text truncates inside its cap", () => {
    const html = renderToStaticMarkup(<Measured measure="label">Mike</Measured>);
    expect(html).toContain("truncate");
    expect(html).toContain("max-w-48");
    expect(html).toContain(">Mike</span>");
  });
});

describe("page title", () => {
  test("renders one level-one heading with the full text as tooltip", () => {
    const html = renderToStaticMarkup(<PageTitle testId="t">Quartalsbericht</PageTitle>);
    expect(html).toBe(
      '<h1 data-testid="t" title="Quartalsbericht" class="min-w-0 truncate text-2xl font-semibold">Quartalsbericht</h1>',
    );
  });

  test("a rich title gets no tooltip", () => {
    expect(
      renderToStaticMarkup(
        <PageTitle>
          <b>x</b>
        </PageTitle>,
      ),
    ).not.toContain("title=");
  });
});
