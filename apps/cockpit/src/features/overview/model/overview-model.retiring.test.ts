import { describe, expect, test } from "bun:test";
import { formatDate, type TranslationKey, translate } from "@/lib/i18n";
import { attentionRow } from "./overview-model";
import { de, item } from "./overview-model-fixtures.ts";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("a connector endpoint the vendor retires", () => {
  test("an announced retirement names the sunset date per locale instead of calling the endpoint gone", () => {
    const retiring = item({
      id: "connector:c1",
      class: "decide",
      severity: "notice",
      kind: "connector",
      subject: { kind: "connector", id: "c1", name: "GitHub QA Dispatch PROD" },
      reason: "needs_update",
      deadline: "2028-03-10T00:00:00.000Z",
    });
    const deDay = (value: string) => formatDate("de", value);
    const enDay = (value: string) => formatDate("en", value);
    expect(deDay("2028-03-10T00:00:00.000Z")).toBe("10.03.2028");
    expect(attentionRow(retiring, de, deDay)).toMatchObject({
      reason: de("overview.short.endpoint_retiring", { date: "10.03.2028" }),
      badge: { state: "needs_update", label: "connectors.healthState.retiring" },
    });
    expect(attentionRow(retiring, en, enDay).reason).toBe("Endpoint retires on Mar 10, 2028");
    expect(attentionRow({ ...retiring, deadline: null }, en, enDay).reason).toBe(
      "The vendor announced the endpoint’s retirement",
    );
    expect(attentionRow({ ...retiring, deadline: null }, de, deDay).reason).toBe(
      de("overview.short.endpoint_retiringUndated"),
    );
  });

  test("an endpoint that is gone keeps its failing wording", () => {
    const gone = item({
      id: "connector:c2",
      kind: "connector",
      subject: { kind: "connector", id: "c2", name: "Jira" },
      reason: "needs_update",
      deadline: "2026-01-31T23:59:59.000Z",
    });
    const row = attentionRow(gone, de, (value) => formatDate("de", value));
    expect(row.reason).toBe(de("overview.short.needs_update"));
    expect(row.badge).toEqual({
      state: "needs_update",
      label: "connectors.healthState.needsUpdate",
    });
    expect(attentionRow(gone, en).reason).toBe("The endpoint no longer exists");
  });
});
