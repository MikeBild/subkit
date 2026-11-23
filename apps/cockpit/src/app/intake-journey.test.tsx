import { expect } from "bun:test";
import type { Locale } from "@/lib/i18n";
import {
  ALL_PERMISSIONS,
  attentionItem,
  attentionWith,
  INTAKE,
  intakeEntry,
  journeys,
  mount,
  NOW,
} from "./journey-fixtures";

const isolated = journeys(import.meta.path);
const PROPOSAL = "66666666-6666-4666-8666-666666666666";
const SOURCE = "77777777-7777-4777-8777-777777777777";

function inbox() {
  let confirmed = false;
  const proposal = () => ({
    id: PROPOSAL,
    tenant_id: intakeEntry.tenant_id,
    status: confirmed ? "confirmed" : "draft",
    current_revision: 1,
    confirmed_revision: confirmed ? 1 : null,
    confirmed_target_kind: confirmed ? "knowledge" : null,
    confirmed_target_id: confirmed ? SOURCE : null,
    rejected_at: null,
    stale_reason: null,
    created_at: NOW,
    updated_at: NOW,
    revision: {
      revision: 1,
      digest: "digest-1",
      title: "Order number rules",
      body: "Every delivery note carries an order number.",
      target: { name: "Delivery handbook", category: "operations" },
      items: [{ id: INTAKE, version: 1, title: intakeEntry.title, source_url: null }],
      created_at: NOW,
    },
  });
  const entry = () =>
    confirmed
      ? {
          ...intakeEntry,
          state: "admitted",
          version: 2,
          admitted_target_kind: "knowledge",
          admitted_target_id: SOURCE,
        }
      : intakeEntry;
  const routes = {
    "/v1/attention": () =>
      attentionWith(
        confirmed
          ? []
          : [
              attentionItem({
                id: "intake",
                kind: "intake",
                subject: null,
                reason: "intake_collected",
                counts: { intake: 1, intake_by_category: { operations: 1 } },
                actions: [
                  {
                    verb: "review",
                    href: "/cockpit/intake?category=all",
                    primary: true,
                    permission: "intake:read",
                  },
                ],
              }),
            ],
      ),
    "/v1/intake/items": () => ({ items: [entry()] }),
    [`/v1/intake/items/${INTAKE}`]: () => entry(),
    "/v1/intake/proposals": () => ({ items: [proposal()] }),
    [`POST /v1/intake/proposals/${PROPOSAL}/confirm`]: () => {
      confirmed = true;
      return proposal();
    },
    [`/v1/knowledge-sources/${SOURCE}`]: () => ({
      id: SOURCE,
      name: "Delivery handbook",
      slug: "delivery-handbook",
      category: "operations",
    }),
  };
  return routes;
}

async function acceptFromInbox(locale: Locale) {
  const app = await mount("/intake", { locale, permissions: ALL_PERMISSIONS, routes: inbox() });
  app.at("/intake");
  expect(app.find("nav-intake-count")?.textContent).toBe("1");
  expect(app.find("kn-inbox-summary")?.textContent).toContain(
    app.t("kn.inbox.count.one", { n: 1, open: 1 }),
  );
  await app.click("kn-row");
  app.at(`/intake/${INTAKE}`);
  expect(app.text()).toContain(intakeEntry.title);
  const confirm = app.find(`intake-proposal-${PROPOSAL}-confirm`);
  expect(confirm?.textContent).toBe(app.t("intake.proposal.confirm"));
  await app.click(`intake-proposal-${PROPOSAL}-confirm`);
  expect(app.find(`intake-proposal-${PROPOSAL}-confirm-dialog`)).not.toBeNull();
  await app.click(`intake-proposal-${PROPOSAL}-confirm-dialog-confirm`);
  const posted = app.seen.filter((call) => call.startsWith("POST "));
  expect(posted).toEqual([`POST /v1/intake/proposals/${PROPOSAL}/confirm`]);
  expect(app.find(`intake-proposal-${PROPOSAL}-confirm`)).toBeNull();
  expect(app.find("nav-intake-count")).toBeNull();
  expect(app.text()).toContain(app.t("kn.inbox.strip.acceptedSource"));
  await app.back();
  app.at("/intake");
  expect(app.find("nav-intake-count")).toBeNull();
  expect(app.find("kn-inbox-summary")?.textContent).toContain(
    app.t("kn.inbox.count.one", { n: 1, open: 0 }),
  );
  expect(app.missingKeys()).toEqual([]);
}

isolated("Inbox (de) › accepting a reviewed entry clears the counter", async () => {
  await acceptFromInbox("de");
});

isolated("Inbox (en) › accepting a reviewed entry clears the counter", async () => {
  await acceptFromInbox("en");
});
