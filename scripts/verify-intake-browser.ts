import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "playwright";

const root = join(import.meta.dir, "..");
const assets = join(root, "assets", "cockpit");
const id = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const proposalId = "018f4b4a-6d33-7b3a-9c2d-123456789abf";
const focusedId = "018f4b4a-6d33-7b3a-9c2d-123456789abd";
const skillProposalId = "018f4b4a-6d33-7b3a-9c2d-123456789ac1";
const supersededSkillId = "018f4b4a-6d33-7b3a-9c2d-123456789ac2";
const createdSkillId = "018f4b4a-6d33-7b3a-9c2d-123456789ac3";
let skillConfirmed = false;
let defaultCategory = "inbox";
let itemState = "collected";
let itemNote = "Anregung für unser Angebot";
let itemTitle = "Vier Spuren";
let itemBody = "# Vier Spuren";
let itemCategory = "inbox";
let itemVersion = 1;
let rejectNextItemPatch = false;
let confirmed = false;
let confirmationConflict = true;
let failMentionSeed = false;
const requests: Array<{ path: string; body: unknown }> = [];
let chatReferences: unknown[] = [];

const response = (value: unknown, init: ResponseInit = {}) =>
  Response.json(value, { ...init, headers: { "cache-control": "no-store", ...init.headers } });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/cockpit/bootstrap")
      return response({
        principal: {
          id,
          kind: "user",
          email: "person@example.test",
          role_name: "member",
          provider: "browser_session",
        },
        tenant: { id, slug: "test", display_name: "Test" },
        session: { expires_at: "2030-01-01T00:00:00.000Z", absolute_expires_at: null },
        permissions: [
          "intake:read",
          "intake:write",
          "intake:confirm",
          "knowledge:write",
          "skill:read",
          "skill:write",
          "skill:activate",
          "skill:archive",
          "conversation:read",
          "conversation:write",
          "stats:read",
        ],
        csrf_token: "csrf",
        version: "test",
        oauth_callback_url: null,
        recent_conversations: [],
      });
    if (url.pathname === "/v1/categories" && request.method === "GET")
      return response({
        categories: [
          {
            category: "inbox",
            total: 1,
            counts: {
              workflow: 0,
              connector: 0,
              knowledge_source: 0,
              skill: 0,
              file: 0,
              intake: 1,
            },
            intake_open: { collected: 1, reviewing: 0 },
          },
          {
            category: "research",
            total: 0,
            counts: {
              workflow: 0,
              connector: 0,
              knowledge_source: 0,
              skill: 0,
              file: 0,
              intake: 0,
            },
            intake_open: { collected: 0, reviewing: 0 },
          },
        ],
      });
    if (url.pathname === "/v1/intake/default-category") {
      if (request.method === "GET") return response({ category: defaultCategory });
      const body = (await request.json()) as { category: string };
      requests.push({ path: url.pathname, body });
      defaultCategory = body.category;
      return response({ category: defaultCategory });
    }
    if (url.pathname === "/v1/intake/items/mentions" && request.method === "GET") {
      if (failMentionSeed && url.searchParams.get("id") === id)
        return response({ message: "unavailable" }, { status: 503 });
      const matches = url.searchParams.get("id") === id || url.searchParams.get("q") !== null;
      return response({
        items: matches
          ? [
              {
                id,
                title: itemTitle,
                source_url: "https://example.test/four-tracks",
                category: itemCategory,
                state: itemState,
                version: itemVersion,
              },
            ]
          : [],
        total: matches ? 1 : 0,
      });
    }
    if (url.pathname === "/v1/intake/items" && request.method === "GET") {
      const category = url.searchParams.get("category");
      const state = url.searchParams.get("state");
      const visible = (!category || category === itemCategory) && (!state || state === itemState);
      return response({
        items: visible
          ? [
              {
                id,
                category: itemCategory,
                client_request_id: id,
                title: itemTitle,
                body: itemBody,
                note: itemNote,
                state: itemState,
                version: itemVersion,
                original_snapshot: {
                  title: "Vier Spuren",
                  source_url: "https://example.test/four-tracks",
                  source_author: "Deestech",
                  published_at: "2026-01-01T00:00:00.000Z",
                  captured_at: "2026-01-02T00:00:00.000Z",
                  body: "# Vier Spuren",
                  origin: "capture",
                },
                admitted_target_kind: confirmed ? "knowledge" : null,
                admitted_target_id: confirmed ? "knowledge-1" : null,
                created_at: "2026-01-02T00:00:00.000Z",
                updated_at: "2026-01-02T00:00:00.000Z",
              },
            ]
          : [],
        total: visible ? 1 : 0,
      });
    }
    if (url.pathname === `/v1/intake/items/${focusedId}` && request.method === "GET")
      return response({
        id: focusedId,
        category: "other-category",
        client_request_id: focusedId,
        title: "Anderer Eintrag",
        body: "# Anderer Eintrag",
        note: "",
        state: "collected",
        version: 1,
        original_snapshot: {
          title: "Anderer Eintrag",
          captured_at: "2026-01-02T00:00:00.000Z",
          body: "# Anderer Eintrag",
          origin: "session",
          agent: "claude-code",
          session_id: "session-fixture",
          repo: "operations-handbook",
          domains: ["operations"],
          evidence_excerpt: "Ordne Störungen zuerst nach Wirkung ein.",
          learning_kind: "practice",
        },
        admitted_target_kind: null,
        admitted_target_id: null,
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
    if (url.pathname === `/v1/intake/items/${id}` && request.method === "GET")
      return response({
        id,
        category: itemCategory,
        client_request_id: id,
        title: itemTitle,
        body: itemBody,
        note: itemNote,
        state: itemState,
        version: itemVersion,
        original_snapshot: {
          title: "Vier Spuren",
          source_url: "https://example.test/four-tracks",
          captured_at: "2026-01-02T00:00:00.000Z",
          body: "# Vier Spuren",
          origin: "capture",
        },
        admitted_target_kind: confirmed ? "knowledge" : null,
        admitted_target_id: confirmed ? "knowledge-1" : null,
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
    if (url.pathname === `/v1/intake/items/${id}` && request.method === "PATCH") {
      const body = (await request.json()) as {
        expected_version?: number;
        state?: string;
        title?: string;
        body?: string;
        note?: string;
        category?: string;
      };
      requests.push({ path: url.pathname, body });
      if (body.expected_version !== itemVersion)
        return response({ message: "item changed" }, { status: 409 });
      if (rejectNextItemPatch) {
        rejectNextItemPatch = false;
        itemVersion += 1;
        return response({ message: "item changed" }, { status: 409 });
      }
      if (body.state) itemState = body.state;
      if (body.title !== undefined) itemTitle = body.title;
      if (body.body !== undefined) itemBody = body.body;
      if (body.note !== undefined) itemNote = body.note;
      if (body.category) itemCategory = body.category;
      itemVersion += 1;
      return response({
        id,
        category: itemCategory,
        client_request_id: id,
        title: itemTitle,
        body: itemBody,
        note: itemNote,
        state: itemState,
        version: itemVersion,
        original_snapshot: {
          title: "Vier Spuren",
          source_url: "https://example.test/four-tracks",
          source_author: "Deestech",
          published_at: "2026-01-01T00:00:00.000Z",
          captured_at: "2026-01-02T00:00:00.000Z",
          body: "# Vier Spuren",
          origin: "capture",
        },
        admitted_target_kind: confirmed ? "knowledge" : null,
        admitted_target_id: confirmed ? "knowledge-1" : null,
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
    }
    if (url.pathname === "/v1/intake/proposals" && request.method === "GET")
      return response({
        items: [
          {
            id: proposalId,
            status: confirmed ? "confirmed" : "draft",
            current_revision: 1,
            confirmed_revision: confirmed ? 1 : null,
            confirmed_target_kind: confirmed ? "knowledge" : null,
            confirmed_target_id: confirmed ? "knowledge-1" : null,
            rejected_at: null,
            created_at: "2026-01-02T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z",
            revision: {
              revision: 1,
              digest: "digest",
              title: "Vier Spuren als Produktidee",
              body: "Behalte die Vier-Spuren-Idee.",
              target: {
                name: "Produktwissen",
                category: "incident-review",
                tags: ["incident-review", "domain:operations"],
              },
              items: [
                {
                  id,
                  version: 1,
                  title: "Vier Spuren",
                  source_url: "https://example.test/four-tracks",
                },
              ],
              created_at: "2026-01-02T00:00:00.000Z",
            },
          },
          {
            id: skillProposalId,
            status: skillConfirmed ? "confirmed" : "draft",
            current_revision: 1,
            confirmed_revision: skillConfirmed ? 1 : null,
            confirmed_target_kind: skillConfirmed ? "skill" : null,
            confirmed_target_id: skillConfirmed ? createdSkillId : null,
            rejected_at: null,
            created_at: "2026-01-02T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z",
            revision: {
              revision: 1,
              digest: "skill-digest",
              title: "Störungen zuerst einordnen",
              body: "Ordne jede Störung zuerst nach Wirkung ein.",
              target: {
                skill: {
                  new: {
                    title: "Störungen zuerst einordnen",
                    scope: "global",
                    tags: ["domain:operations"],
                    category: "operations",
                  },
                  supersedes: [{ skill_id: supersededSkillId, expected_version: 3 }],
                },
              },
              items: [
                {
                  id: focusedId,
                  version: 1,
                  title: "Anderer Eintrag",
                  source_url: null,
                },
              ],
              created_at: "2026-01-02T00:00:00.000Z",
            },
          },
        ],
        total: 2,
      });
    if (url.pathname === `/v1/skills/${supersededSkillId}`)
      return response({
        id: supersededSkillId,
        title: "Alte Störungsregel",
        body: "Melde jede Störung sofort.",
        version: 3,
        status: "active",
        scope: "global",
      });
    if (url.pathname === `/v1/intake/proposals/${skillProposalId}/confirm`) {
      requests.push({ path: url.pathname, body: await request.json() });
      skillConfirmed = true;
      return response({});
    }
    if (url.pathname === `/v1/intake/proposals/${proposalId}/confirm`) {
      requests.push({ path: url.pathname, body: await request.json() });
      if (confirmationConflict) return response({ message: "proposal changed" }, { status: 409 });
      confirmed = true;
      itemState = "admitted";
      return response({});
    }
    if (url.pathname === "/v1/conversations" && request.method === "GET")
      return response({ items: [], total: 0 });
    if (url.pathname === "/v1/conversations/chat-1" && request.method === "GET")
      return response({
        conversation: {
          id: "chat-1",
          tenant_id: id,
          target_workflow_id: null,
          target_connector_id: null,
          status: "active",
          owner_id: id,
          model: null,
          title: null,
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
        owner: null,
        created_resources: [],
        messages: [
          {
            id: "message-1",
            role: "user",
            model: null,
            created_at: "2026-01-02T00:00:00.000Z",
            parts: [
              {
                type: "text",
                text: "@Vier-Spuren-uberarbeitet Prüfe diesen Eintrag.",
                references: chatReferences,
              },
            ],
          },
        ],
        tool_calls: [],
        usage: { tokens: 0, by_model: [], cost: null },
      });
    if (url.pathname === "/v1/conversations" && request.method === "POST") {
      const body = (await request.json()) as { references?: unknown[] };
      chatReferences = body.references ?? [];
      requests.push({ path: url.pathname, body });
      return new Response(
        'event: outcome\ndata: {"conversation":{"id":"chat-1"},"result":{"status":"active"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (url.pathname.startsWith("/cockpit/")) {
      const file =
        url.pathname === "/cockpit/" ? "index.html" : url.pathname.slice("/cockpit/".length);
      return new Response(Bun.file(join(assets, file.includes(".") ? file : "index.html")));
    }
    return new Response(Bun.file(join(assets, "index.html")));
  },
});

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5_000);
  await page.addInitScript(() => localStorage.setItem("sk-cockpit-locale", "de"));
  await page.goto(`http://127.0.0.1:${server.port}/cockpit/intake`);
  await page.getByTestId("intake-page").waitFor();
  await page.getByTestId("intake-loading").waitFor({ state: "hidden" });
  await page.getByTestId("catalog-categories-open").click();
  await page.getByTestId("catalog-categories-sheet").waitFor();
  assert.equal(await page.getByTestId("catalog-category-edit").count(), 0);
  await page.keyboard.press("Escape");
  await page.getByTestId("catalog-categories-sheet").waitFor({ state: "hidden" });

  await page.getByTestId("intake-page-actions").click();
  await page.getByTestId("intake-category-default").click();
  await page.getByTestId("intake-default-category-dialog").waitFor();
  await page.getByTestId("intake-default-category-input").selectOption("__new__");
  await page.getByTestId("intake-default-category-new").fill("Eigene Ideen");
  await page.getByTestId("intake-default-category-save").click();
  await page.getByTestId("intake-default-category-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(requests.at(-1), {
    path: "/v1/intake/default-category",
    body: { category: "eigene-ideen" },
  });
  await page.getByTestId("intake-category").click();
  await page.getByRole("option", { name: "Inbox", exact: true }).click();
  await page.waitForFunction(() => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-family-collection-row="true"]'),
    ).find((element) => element.offsetParent !== null);
    row?.click();
    return Boolean(row);
  });
  await page.getByTestId("intake-detail").waitFor();
  const patchesBeforeCancel = requests.filter((request) =>
    request.path.endsWith(`/items/${id}`),
  ).length;
  await page.getByTestId("intake-detail-actions").click();
  await page.getByTestId("intake-detail-edit").click();
  await page.getByTestId("intake-edit-title").fill("Nicht speichern");
  await page.getByTestId("intake-edit-dialog-cancel").click();
  await page.getByTestId("intake-edit-dialog").waitFor({ state: "hidden" });
  assert.equal(
    requests.filter((request) => request.path.endsWith(`/items/${id}`)).length,
    patchesBeforeCancel,
  );
  await page
    .getByTestId("intake-detail")
    .getByRole("heading", { name: "Vier Spuren", level: 2 })
    .waitFor();

  await page.getByTestId("intake-detail-actions").click();
  await page.getByTestId("intake-detail-edit").click();
  await page.getByTestId("intake-edit-dialog").waitFor();
  assert.equal(await page.getByTestId("intake-edit-title").inputValue(), "Vier Spuren");
  assert.equal(await page.getByTestId("intake-edit-body").inputValue(), "# Vier Spuren");
  assert.equal(await page.getByTestId("intake-edit-note").count(), 0);
  await page.getByTestId("intake-edit-title").fill("Vier Spuren überarbeitet");
  await page.getByTestId("intake-edit-body").fill("# Überarbeitet");
  await page.getByTestId("intake-edit-category").selectOption("research");
  rejectNextItemPatch = true;
  await page.getByTestId("intake-edit-save").click();
  await page.getByTestId("intake-edit-reload").waitFor();
  assert.equal(
    await page.getByTestId("intake-edit-title").inputValue(),
    "Vier Spuren überarbeitet",
  );
  assert.equal(await page.getByTestId("intake-edit-body").inputValue(), "# Überarbeitet");
  await page.getByTestId("intake-edit-reload").click();
  await page.getByTestId("intake-edit-reload").waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("intake-edit-title").inputValue(), "Vier Spuren");
  assert.equal(await page.getByTestId("intake-edit-body").inputValue(), "# Vier Spuren");
  await page.getByTestId("intake-edit-title").fill("Vier Spuren überarbeitet");
  await page.getByTestId("intake-edit-body").fill("# Überarbeitet");
  await page.getByTestId("intake-edit-category").selectOption("research");
  await page.getByTestId("intake-edit-save").click();
  await page.getByTestId("intake-edit-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(requests.at(-1)?.body, {
    title: "Vier Spuren überarbeitet",
    body: "# Überarbeitet",
    category: "research",
    expected_version: 2,
  });
  await page.getByTestId("intake-current-body").getByText("Überarbeitet").waitFor();
  await page.getByTestId("intake-original-toggle").click();
  await page.getByTestId("intake-original-body").getByText("Vier Spuren").waitFor();

  await page.getByTestId("intake-detail-actions").click();
  await page.getByTestId("intake-detail-discard").click();
  await page.getByTestId("intake-detail").getByText("Verworfen", { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1)?.body, { state: "discarded", expected_version: 3 });
  const discardedReviewHref = await page
    .getByTestId("intake-detail-review-chat")
    .getAttribute("href");
  assert.ok(discardedReviewHref);
  assert.equal(
    new URL(discardedReviewHref, `http://127.0.0.1:${server.port}`).searchParams.get(
      "intake_item_ids",
    ),
    id,
  );

  const detailActions = page.getByTestId("intake-detail-actions");
  const restore = page.getByTestId("intake-detail-restore");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await restore.count()) > 0) break;
    await detailActions.click();
    await restore.waitFor({ state: "attached", timeout: 2_000 }).catch(() => {});
  }
  await restore.dispatchEvent("click");
  await page.getByTestId("intake-detail").getByText("Gesammelt", { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1)?.body, { state: "collected", expected_version: 4 });

  const proposal = page.getByTestId(`intake-proposal-${proposalId}`);
  await proposal
    .getByTestId(`intake-proposal-${proposalId}-target-details`)
    .getByText("Produktwissen · incident-review")
    .waitFor();
  await proposal.getByTestId(`intake-proposal-${proposalId}-review-toggle`).click();
  await proposal
    .getByTestId(`intake-proposal-${proposalId}-target-tags`)
    .getByText("incident-review, domain:operations")
    .waitFor();
  await proposal.getByTestId(`intake-proposal-${proposalId}-source-${id}`).waitFor();
  const reviewHref = await page.getByTestId("intake-detail-review-chat").getAttribute("href");
  assert.ok(reviewHref);
  const reviewUrl = new URL(reviewHref, `http://127.0.0.1:${server.port}`);
  assert.equal(reviewUrl.searchParams.get("intake_item_ids"), id);
  assert.equal(reviewUrl.searchParams.get("references"), `intake_item:${id}`);
  assert.equal(
    reviewUrl.searchParams.get("prompt"),
    "Prüfe diesen Eintrag und schlage vor, was wir übernehmen sollten, als Wissen oder als Skill.",
  );
  assert.doesNotMatch(reviewUrl.searchParams.get("prompt") ?? "", /neuen Einträge/);
  await page.getByTestId(`intake-proposal-${proposalId}-confirm`).click();
  const confirmationDetails = await page
    .getByTestId(`intake-proposal-${proposalId}-confirm-dialog-consequence`)
    .innerText();
  assert.match(confirmationDetails, /Produktwissen/);
  assert.match(confirmationDetails, /incident-review/);
  assert.match(confirmationDetails, /domain:operations/);
  await page.getByTestId(`intake-proposal-${proposalId}-confirm-dialog-confirm`).click();
  await page.getByTestId(`intake-proposal-${proposalId}-confirm-dialog-cancel`).waitFor();
  assert.equal(confirmed, false);
  assert.equal(await page.getByTestId("intake-proposal-history").count(), 0);
  await page.getByTestId(`intake-proposal-${proposalId}-confirm-dialog-cancel`).click();
  confirmationConflict = false;
  await page.getByTestId(`intake-proposal-${proposalId}-confirm`).click();
  await page.getByTestId(`intake-proposal-${proposalId}-confirm-dialog-confirm`).click();
  assert.deepEqual(requests.filter((entry) => entry.path.endsWith("/confirm")).at(-1)?.body, {
    expected_revision: 1,
    digest: "digest",
  });
  await page.getByTestId("intake-proposal-history").waitFor();
  assert.equal(
    await page.getByTestId("intake-proposal-history").getAttribute("data-state"),
    "closed",
  );
  await page.goto(`http://127.0.0.1:${server.port}/cockpit/intake?item=${focusedId}`);
  await page.getByTestId("intake-detail").waitFor();
  await page
    .getByTestId("intake-detail")
    .getByRole("heading", { name: "Anderer Eintrag", level: 2 })
    .waitFor();
  await page.goto(`http://127.0.0.1:${server.port}/cockpit/intake?proposal=${skillProposalId}`);
  const skillProposal = page.getByTestId(`intake-proposal-${skillProposalId}`);
  const skillTargetDetails = skillProposal.getByTestId(
    `intake-proposal-${skillProposalId}-target-details`,
  );
  await skillTargetDetails
    .getByText("Neuer Skill „Störungen zuerst einordnen“ · operations · gilt überall")
    .waitFor();
  await skillTargetDetails.getByText(/Ersetzt Alte Störungsregel/).waitFor();
  const skillConfirm = page.getByTestId(`intake-proposal-${skillProposalId}-confirm`);
  await skillConfirm.waitFor();
  assert.equal(await skillConfirm.innerText(), "Als Skill bestätigen");
  await skillConfirm.click();
  const skillConsequence = await page
    .getByTestId(`intake-proposal-${skillProposalId}-confirm-dialog-consequence`)
    .innerText();
  assert.match(skillConsequence, /aktiven Skill „Störungen zuerst einordnen“/);
  assert.match(skillConsequence, /gilt überall/);
  assert.match(skillConsequence, /archiviert: Alte Störungsregel/);
  await page.getByTestId(`intake-proposal-${skillProposalId}-confirm-dialog-confirm`).click();
  await page.getByTestId(`intake-proposal-${skillProposalId}-skill`).waitFor();
  assert.deepEqual(
    requests.filter((entry) => entry.path === `/v1/intake/proposals/${skillProposalId}/confirm`),
    [
      {
        path: `/v1/intake/proposals/${skillProposalId}/confirm`,
        body: { expected_revision: 1, digest: "skill-digest" },
      },
    ],
  );
  await page.goto(`http://127.0.0.1:${server.port}/cockpit/intake?proposal=${proposalId}`);
  await page.getByTestId("intake-detail").waitFor();
  await page
    .getByTestId("intake-detail")
    .getByRole("heading", { name: "Vier Spuren", level: 2 })
    .waitFor();
  const chatHref = await page.getByTestId("intake-detail-review-chat").getAttribute("href");
  assert.ok(chatHref);
  await page.goto(`http://127.0.0.1:${server.port}${chatHref}`);
  await page.getByTestId("chat-composer-input").waitFor();
  await page.getByTestId("chat-composer-input").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const input = document.querySelector(
      '[data-testid="chat-composer-input"]',
    ) as HTMLTextAreaElement | null;
    return input?.value.includes("@Vier-Spuren-uberarbeitet");
  });
  await page.waitForFunction(() => {
    const submit = document.querySelector(
      '[data-testid="chat-composer-submit"]',
    ) as HTMLButtonElement | null;
    return submit !== null && !submit.disabled;
  });
  assert.equal(await page.getByTestId("chat-composer-submit").isDisabled(), false);
  const chatRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/v1/conversations",
  );
  await page.getByTestId("chat-composer-submit").click();
  await page
    .getByTestId("chat-message-0-text-0-mentions")
    .getByText("Vier-Spuren-uberarbeitet")
    .waitFor();
  assert.deepEqual(JSON.parse((await chatRequest).postData() ?? "{}").references, [
    { type: "intake_item", id, label: "Vier-Spuren-uberarbeitet" },
  ]);
  await page.goto(`http://127.0.0.1:${server.port}/cockpit/chat/new`);
  await page.getByTestId("chat-composer-input").fill("@Vier");
  await page.getByTestId("chat-mention-item-0").waitFor();
  await page.getByTestId("chat-mention-item-0").click();
  assert.match(
    await page.getByTestId("chat-composer-input").inputValue(),
    /@Vier-Spuren-uberarbeitet/,
  );
  failMentionSeed = true;
  await page.goto(
    `http://127.0.0.1:${server.port}/cockpit/chat/new?prompt=Pr%C3%BCfe&references=intake_item%3A${id}`,
  );
  await page.getByTestId("chat-reference-seed-pending").waitFor({ timeout: 10_000 });
  assert.equal(await page.getByTestId("chat-composer-submit").isDisabled(), true);
  failMentionSeed = false;
  await page.getByTestId("chat-reference-seed-pending").getByRole("button").click();
  await page.getByTestId("chat-reference-seed-pending").waitFor({ state: "hidden" });
  assert.match(
    await page.getByTestId("chat-composer-input").inputValue(),
    /@Vier-Spuren-uberarbeitet/,
  );
  await page.waitForFunction(() => {
    const submit = document.querySelector(
      '[data-testid="chat-composer-submit"]',
    ) as HTMLButtonElement | null;
    return submit !== null && !submit.disabled;
  });
  assert.equal(await page.getByTestId("chat-composer-submit").isDisabled(), false);
  const retriedChatRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/v1/conversations",
  );
  await page.getByTestId("chat-composer-submit").click();
  await page
    .getByTestId("chat-message-0-text-0-mentions")
    .getByText("Vier-Spuren-uberarbeitet")
    .waitFor();
  assert.deepEqual(JSON.parse((await retriedChatRequest).postData() ?? "{}").references, [
    { type: "intake_item", id, label: "Vier-Spuren-uberarbeitet" },
  ]);
  await page.goto(`http://127.0.0.1:${server.port}/cockpit/intake?proposal=missing`);
  await page.getByTestId("intake-error").waitFor();
  process.stdout.write("Intake browser verification passed.\n");
} finally {
  await browser.close();
  server.stop(true);
}
