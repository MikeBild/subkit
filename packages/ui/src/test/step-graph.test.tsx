import { describe, expect, it } from "bun:test";
import { StepGraph, stepGraphTier } from "@ui/components/proto/visual";
import { renderToStaticMarkup } from "react-dom/server";

const steps = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    label: `Step ${i + 1}`,
    state: i === 0 ? ("done" as const) : i === 1 ? ("active" as const) : ("pending" as const),
  }));

describe("StepGraph", () => {
  it("goes side by side only where every step gets about 8rem, else it stacks", () => {
    expect([1, 3, 4, 5, 6, 7, 8, 12].map(stepGraphTier)).toEqual([
      "sm",
      "sm",
      "lg",
      "2xl",
      "4xl",
      "4xl",
      "stacked",
      "stacked",
    ]);
  });

  it("never scrolls inside its box", () => {
    for (const count of [2, 4, 5, 7, 9]) {
      const html = renderToStaticMarkup(<StepGraph label="Steps" steps={steps(count)} />);
      expect(html).not.toContain("overflow-x-auto");
      expect(html).not.toContain("min-w-32");
      expect(html).toContain('data-slot="step-graph"');
      expect(html).toContain('class="@container"');
    }
  });

  it("measures its own width: stacked by default, a row from the step count's breakpoint", () => {
    const four = renderToStaticMarkup(<StepGraph label="Steps" steps={steps(4)} />);
    expect(four).toContain("flex flex-col @lg:flex-row");
    const many = renderToStaticMarkup(<StepGraph label="Steps" steps={steps(9)} />);
    expect(many).not.toContain(":flex-row");
    expect(many).toContain('aria-current="step"');
  });
});
