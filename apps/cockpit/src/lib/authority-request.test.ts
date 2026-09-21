// The request-boundary panel must say what is being approved and what is not.
// Every method is mapped explicitly; an unknown one is never given a harmless
// label — the storage panel once showed a removal to its approver as a read.

import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import { presentRequestBoundary, type RequestBoundaryView } from "./authority-request";

const plain = (value: number) => String(value);
const base: RequestBoundaryView = {
  method: "POST",
  origin: "https://api.example.test",
  segments: ["", "v2", "sites", { var: "input.site" }, "releases"],
  variables: { "input.site": { enum: ["company-cockpit", "blog"] } },
  query: { fixed: {}, variable: [] },
  max_body_bytes: 20000,
  max_calls: 3,
};

describe("presentRequestBoundary", () => {
  test("shows the resolved target, every allowed value and both ceilings", () => {
    const shown = presentRequestBoundary(base, plain);
    expect(shown.target).toBe("https://api.example.test/v2/sites/{input.site}/releases");
    expect(shown.variables).toEqual([
      {
        key: "authority.boundary.variable",
        values: { name: "input.site", values: "company-cockpit, blog" },
      },
    ]);
    expect(shown.classNotice).toBe(false);
    expect(translate("en", shown.body.key, shown.body.values)).toContain("20000");
    expect(shown.calls).toBe(3);
    expect(shown.destructive).toBe(false);
    expect(shown.title).toBe("authority.boundary.send");
  });

  test("a static query is part of the target the approver sees", () => {
    const shown = presentRequestBoundary(
      {
        ...base,
        method: "GET",
        max_body_bytes: 0,
        query: { fixed: { status: "pending" }, variable: [] },
      },
      plain,
    );
    expect(shown.target).toEndWith("/releases?status=pending");
    expect(shown.title).toBe("authority.boundary.read");
    expect(shown.body.key).toBe("authority.boundary.noBody");
  });

  test("a removal is destructive, and an unknown method is never reassuring", () => {
    expect(
      presentRequestBoundary({ ...base, method: "DELETE", destructive: true }, plain),
    ).toMatchObject({
      title: "authority.boundary.delete",
      destructive: true,
    });
    expect(presentRequestBoundary({ ...base, method: "PURGE" }, plain)).toMatchObject({
      title: "authority.boundary.unknown",
      destructive: true,
    });
  });

  test("an author's destructive mark on a sending request is shown, never dropped", () => {
    const shown = presentRequestBoundary({ ...base, destructive: true }, plain);
    expect(shown).toMatchObject({
      title: "authority.boundary.send",
      destructive: true,
      declaredDestructive: true,
    });
    // A DELETE already says so in its title; the extra line is for the others.
    expect(
      presentRequestBoundary({ ...base, method: "DELETE", destructive: true }, plain)
        .declaredDestructive,
    ).toBe(false);
    expect(presentRequestBoundary(base, plain).declaredDestructive).toBe(false);
    expect(translate("de", "authority.boundary.declaredDestructive")).toContain("entfernt");
  });

  test("a value class is described in plain words, with the notice that it approves a form", () => {
    const shown = presentRequestBoundary(
      {
        ...base,
        method: "GET",
        max_body_bytes: 0,
        segments: ["", "v2", "sites", { var: "input.site" }, "stats", { var: "item.id" }],
        variables: {
          "input.site": { enum: ["blog"] },
          "item.id": { class: "uuid" },
          "scope.window.data.start": { class: "timestamp" },
        },
        query: {
          fixed: { tz: "UTC" },
          variable: [{ key: "from", var: "scope.window.data.start" }],
        },
      },
      plain,
    );
    // The varying query value is part of the target the approver reads.
    expect(shown.target).toBe(
      "https://api.example.test/v2/sites/{input.site}/stats/{item.id}?tz=UTC&from={scope.window.data.start}",
    );
    expect(shown.classNotice).toBe(true);
    expect(shown.destructive).toBe(false);
    const lines = shown.variables.map((line) => translate("de", line.key, line.values));
    expect(lines[1]).toBe("item.id darf jede UUID sein.");
    expect(lines[2]).toContain("UTC-Zeitpunkt");
    expect(translate("en", "authority.boundary.classNotice")).toContain(
      "only what the value looks like",
    );
  });

  test("a rule this dialog does not know makes the panel cautious and says why", () => {
    const shown = presentRequestBoundary(
      { ...base, variables: { "input.site": { class: "anything_goes" } } },
      plain,
    );
    expect(shown.destructive).toBe(true);
    const [line] = shown.variables;
    expect(line?.key).toBe("authority.boundary.unknownRule");
    expect(translate("de", line!.key, line!.values)).toContain("anything_goes");
    expect(translate("de", line!.key, line!.values)).toContain("nicht freigeben");
  });

  test("the copy is honest about what the approval does not cover", () => {
    for (const locale of ["de", "en"] as const) {
      const notice = translate(locale, "authority.boundary.contentNotice");
      const calls = translate(locale, "authority.boundary.calls", { count: 3 });
      expect(notice.length).toBeGreaterThan(40);
      expect(calls).toContain("3");
    }
    expect(translate("de", "authority.boundary.calls", { count: 3 })).toContain(
      "noch nicht mitgezählt",
    );
    expect(translate("en", "authority.boundary.calls", { count: 3 })).toContain("not yet counted");
    expect(translate("en", "authority.boundary.contentNotice")).toContain("not what it contains");
  });
});
