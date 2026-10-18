import { describe, expect, test } from "bun:test";
import type { EngineClient } from "../engine-client.ts";
import { cockpitIntakeUrl, cockpitUrl, fetchPendingIntake } from "../lib/intake-review.ts";

type IntakeReader = Pick<EngineClient, "getDefaultIntakeCategory" | "listIntakeItems">;

function reader(overrides: Partial<IntakeReader>): IntakeReader {
  return {
    getDefaultIntakeCategory: async () => ({ category: "Inbox" }),
    listIntakeItems: async () => ({ items: [], total: 0 }),
    ...overrides,
  };
}

describe("fetchPendingIntake", () => {
  test("counts collected and reviewing items in the person's default category", async () => {
    const queries: unknown[] = [];
    const pending = await fetchPendingIntake(
      reader({
        getDefaultIntakeCategory: async () => ({ category: "Research" }),
        listIntakeItems: async (query) => {
          queries.push(query);
          return { items: [], total: query?.state === "collected" ? 4 : 1 };
        },
      }),
    );
    expect(pending).toEqual({ category: "Research", count: 5 });
    expect(queries).toEqual([
      { category: "Research", state: "collected" },
      { category: "Research", state: "reviewing" },
    ]);
  });

  test("falls back to the returned page when the total is absent", async () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      category: "Inbox",
      title: "Clip",
      state: "collected" as const,
      version: 1,
      original_snapshot: { origin: "session" as const, captured_at: "2026-01-01T00:00:00Z" },
    };
    const pending = await fetchPendingIntake(
      reader({ listIntakeItems: async () => ({ items: [item, { ...item, id: `${item.id}2` }] }) }),
    );
    expect(pending).toEqual({ category: "Inbox", count: 4 });
  });

  test("returns null when the category or the list cannot be read", async () => {
    expect(
      await fetchPendingIntake(
        reader({
          getDefaultIntakeCategory: async () => {
            throw new Error("forbidden");
          },
        }),
      ),
    ).toBeNull();
    expect(
      await fetchPendingIntake(
        reader({
          listIntakeItems: async () => {
            throw new Error("forbidden");
          },
        }),
      ),
    ).toBeNull();
    expect(
      await fetchPendingIntake(
        reader({ getDefaultIntakeCategory: async () => ({ category: "" }) }),
      ),
    ).toBeNull();
  });
});

describe("cockpit links", () => {
  test("keep the engine base path and drop query and fragment", () => {
    const client = { base: "https://sk.example.test/engine?x=1#y" };
    expect(cockpitIntakeUrl(client)).toBe("https://sk.example.test/engine/cockpit/intake");
    expect(cockpitUrl({ base: "https://sk.example.test" }, "chat/abc")).toBe(
      "https://sk.example.test/cockpit/chat/abc",
    );
  });
});
