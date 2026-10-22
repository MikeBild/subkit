import { describe, expect, test } from "bun:test";
import {
  askingTools,
  popularTemplates,
  serviceHost,
  serviceInitial,
  templateFor,
  toolTitle,
} from "./connector-view-model";

const recipe = { slug: "r" };

describe("connector view model", () => {
  test("ranks the templates with the most ready workflows first, then by name", () => {
    const ranked = popularTemplates(
      [
        { name: "Zeta", recipes: [recipe] },
        { name: "Alpha", recipes: [] },
        { name: "Beta", recipes: [recipe, recipe] },
        { name: "Gamma", recipes: [recipe] },
      ],
      3,
    );
    expect(ranked.map((template) => template.name)).toEqual(["Beta", "Gamma", "Zeta"]);
  });

  test("shows the host of an address and never a masked secret", () => {
    expect(serviceHost("https://api.example.com/v1")).toBe("api.example.com");
    expect(serviceHost("https://api.example.com/v1?key=***redacted***")).toBe("api.example.com");
    expect(serviceHost("not an address")).toBeNull();
    expect(serviceHost(null)).toBeNull();
  });

  test("names a tool by its title or a readable form of its server name", () => {
    expect(toolTitle({ name: "run_dashboard_query" })).toBe("Run dashboard query");
    expect(toolTitle({ name: "x", title: "Dashboard abfragen" })).toBe("Dashboard abfragen");
  });

  test("counts the tools that still ask before they run", () => {
    expect(askingTools(["a", "b", "c"], ["b"])).toBe(2);
    expect(askingTools([], ["b"])).toBe(0);
  });

  test("finds the template a connector was made from", () => {
    expect(templateFor([{ slug: "github" }], "github")).toEqual({ slug: "github" });
    expect(templateFor([{ slug: "github" }], null)).toBeNull();
  });

  test("marks a service with its first letter", () => {
    expect(serviceInitial("  hubspot")).toBe("H");
    expect(serviceInitial("")).toBe("?");
  });
});
