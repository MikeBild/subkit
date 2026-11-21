import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { DataTable } from "./data-table";
import { StatusBadge } from "./status-badge";

const value = {
  locale: "de",
  preference: "de",
  setPreference() {},
  t: (key, values) => translate("de", key, values),
  tn: (key, count, values) => translatePlural("de", key, count, values),
  dateTime: (date) => String(date),
} as I18nValue;

test("only available records expose row navigation on desktop and mobile", () => {
  const longStatus = "Zugangsdaten abgelehnt und erneute Anmeldung erforderlich";
  const html = renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <DataTable
        collectionId="availability"
        collectionTier="embedded"
        columns={[
          { id: "name", accessorKey: "name", header: "Name" },
          {
            id: "status",
            accessorKey: "available",
            header: "Status",
            cell: () => <StatusBadge state="rejected" label={longStatus} />,
          },
        ]}
        data={[
          { name: "Available", available: true },
          { name: "Unavailable", available: false },
        ]}
        sorting={[]}
        onSortingChange={() => {}}
        onOpen={() => {}}
        rowActions={() => (
          <button type="button" data-testid="test-row-action">
            Action
          </button>
        )}
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
  expect(document.querySelector('[data-testid="availability-desktop"]')?.className).toContain(
    "@xl:block",
  );
  expect(document.querySelector('[data-testid="availability-mobile"]')?.className).toContain(
    "@xl:hidden",
  );
  expect(document.querySelector('[data-slot="row-actions"] span')?.className).toContain(
    "flex-wrap",
  );
  const actionsHead = document.querySelector('[data-slot="row-actions-head"]');
  expect(actionsHead?.textContent).toBe("Actions");
  expect(actionsHead?.className).toContain("text-right");
  expect(actionsHead?.className).not.toContain("sr-only");
  expect(actionsHead?.querySelector(".sr-only")).toBeNull();
  expect(document.querySelector('[data-testid="availability-sort-name"]')?.className).toContain(
    "-ml-2.5",
  );
  const statusCell = document.querySelectorAll(
    '[data-testid="availability-row-0"] [data-slot="table-cell"]',
  )[1];
  const statusBadge = statusCell?.querySelector('[data-slot="badge"]');
  expect(statusCell?.className).toContain("min-w-0");
  expect(statusCell?.className).not.toContain("overflow-hidden");
  expect(statusBadge?.getAttribute("title")).toBe(longStatus);
  expect(statusBadge?.getAttribute("aria-label")).toBe(longStatus);
  expect(statusBadge?.className).toContain("max-w-full");
  expect(statusBadge?.querySelector("span.min-w-0")?.className).toContain("truncate");
  const available = document.querySelector('[data-testid="availability-row-0"]');
  const unavailable = document.querySelector('[data-testid="availability-row-1"]');
  expect(available?.classList.contains("cursor-pointer")).toBe(true);
  expect(available?.querySelector("a")?.getAttribute("href")).toContain("/workflows/available");
  expect(unavailable?.classList.contains("cursor-pointer")).toBe(false);
  expect(unavailable?.querySelector("a")).toBeNull();
  expect(document.querySelectorAll('[data-slot="row-chevron"]')).toHaveLength(0);
  expect(available?.querySelectorAll('[data-slot="table-cell"]')).toHaveLength(2);
  const mobileAvailable = document.querySelector('[data-testid="availability-mobile-row-0"]');
  const mobileUnavailable = document.querySelector('[data-testid="availability-mobile-row-1"]');
  expect(mobileAvailable?.classList.contains("cursor-pointer")).toBe(true);
  expect(mobileUnavailable?.classList.contains("cursor-pointer")).toBe(false);
  expect(mobileUnavailable?.querySelector("a")).toBeNull();
  expect(document.querySelectorAll('a[href$="/workflows/available"]')).toHaveLength(2);
});
