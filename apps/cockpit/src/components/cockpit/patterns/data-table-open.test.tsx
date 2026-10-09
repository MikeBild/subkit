import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { DataTable } from "./data-table";

const value = {
  locale: "de",
  preference: "de",
  setPreference() {},
  t: (key, values) => translate("de", key, values),
  tn: (key, count, values) => translatePlural("de", key, count, values),
  dateTime: (date) => String(date),
} as I18nValue;

test("only available records expose row navigation on desktop and mobile", () => {
  const html = renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <DataTable
        collectionId="availability"
        collectionTier="embedded"
        columns={[{ id: "name", accessorKey: "name", header: "Name" }]}
        data={[
          { name: "Available", available: true },
          { name: "Unavailable", available: false },
        ]}
        sorting={[]}
        onSortingChange={() => {}}
        onOpen={() => {}}
        canOpen={(row) => row.available}
        rowHref={(row) => (row.available ? "/workflows/available" : null)}
        emptyState={{
          zero: { title: "Empty" },
          filtered: { title: "Empty", description: "Empty", resetLabel: "Reset", onReset() {} },
        }}
        hasActiveFilters={false}
        columnsLabel="Columns"
        recordsLabel="Records"
        actionsLabel="Actions"
      />
    </I18nContext.Provider>,
  );
  const document = new JSDOM(html).window.document;
  const available = document.querySelector('[data-testid="availability-row-0"]');
  const unavailable = document.querySelector('[data-testid="availability-row-1"]');
  expect(available?.classList.contains("cursor-pointer")).toBe(true);
  expect(available?.querySelector("a")?.getAttribute("href")).toContain("/workflows/available");
  expect(unavailable?.classList.contains("cursor-pointer")).toBe(false);
  expect(unavailable?.querySelector("a")).toBeNull();
  expect(unavailable?.querySelector('[data-slot="row-chevron"] svg')).toBeNull();
  const mobileAvailable = document.querySelector('[data-testid="availability-mobile-row-0"]');
  const mobileUnavailable = document.querySelector('[data-testid="availability-mobile-row-1"]');
  expect(mobileAvailable?.classList.contains("cursor-pointer")).toBe(true);
  expect(mobileUnavailable?.classList.contains("cursor-pointer")).toBe(false);
  expect(mobileUnavailable?.querySelector("a")).toBeNull();
  expect(document.querySelectorAll('a[href$="/workflows/available"]')).toHaveLength(2);
});
