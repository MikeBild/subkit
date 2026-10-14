import { formatDateTime, LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function exact(locator, value) {
  await locator.getByText(value, { exact: true }).waitFor({ state: "visible" });
}

export async function verifyWorkflowHistoryEvidence(
  page,
  stand,
  locale,
  capture,
  { mockApi, recordId },
) {
  const t = (key, values) => translate(locale, key, values);
  const actorId = "01900000-0000-4000-8000-000000000071";
  const email = "workflow-author@example.test";
  const fileCreatorId = "01900000-0000-4000-8000-000000000072";
  const fileCreatorEmail = "file-creator@example.test";
  const keyOwnerId = "01900000-0000-4000-8000-000000000073";
  const keyOwnerEmail = "key-owner@example.test";
  const keyCreatorId = "01900000-0000-4000-8000-000000000074";
  const keyCreatorEmail = "key-creator@example.test";
  const unknownAuthorityCreatorId = "01900000-0000-4000-8000-000000000075";
  const account = "Workflow publishing account";
  const checksum = "09af".repeat(16);
  const fileCreatedAt = "2026-08-10T09:00:00.000Z";
  const authorityCreatedAt = "2026-08-10T08:00:00.000Z";
  const history = [
    {
      id: "01900000-0000-4000-8000-000000000083",
      version: 3,
      author: { kind: "user", id: actorId },
      created_at: "2025-07-11T12:00:00.000Z",
    },
    {
      id: "01900000-0000-4000-8000-000000000082",
      version: 2,
      author: null,
      created_at: "2025-07-10T12:00:00.000Z",
    },
    {
      id: "01900000-0000-4000-8000-000000000081",
      version: 1,
      author: { kind: "system_account", id: actorId },
      created_at: "2025-07-09T12:00:00.000Z",
    },
  ].map((row) => ({
    ...row,
    workflow_id: recordId,
    invalid: false,
    note: `Saved content ${row.version}`,
    checksum: row.version === 3 ? checksum : String(row.version).repeat(64),
  }));
  let undocumented = false;
  let fileCreatorKnown = true;
  let keyCreatorKnown = true;
  let authorityCreatorKnown = true;
  let definition;
  const writes = [];
  const pattern = "**/v1/**";
  const transform = (route, change) =>
    mockApi({
      request: () => route.request(),
      fulfill: (response) =>
        route.fulfill({ ...response, body: JSON.stringify(change(JSON.parse(response.body))) }),
    });
  const handler = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && path.startsWith(`/v1/workflows/${recordId}`)) {
      writes.push({ method: request.method(), path });
      return route.fulfill({
        status: 409,
        json: { error: { code: "unexpected_evidence_mutation" } },
      });
    }
    if (request.method() !== "GET") return route.fallback();
    if (path === `/v1/workflows/${recordId}/history`) {
      require(undocumented ||
        definition, "Canonical workflow definition must precede history rendering");
      const items = undocumented
        ? []
        : history.map((row) => ({ ...row, dag: structuredClone(definition) }));
      return route.fulfill({ json: { items, total: items.length } });
    }
    if (path === `/v1/workflows/${recordId}`)
      return transform(route, (body) => {
        require(typeof body.name === "string" &&
          Array.isArray(body.steps), "Canonical workflow definition required");
        definition = {
          name: body.name,
          steps: structuredClone(body.steps),
          ...(body.input_schema ? { input_schema: body.input_schema } : {}),
          ...(body.output_schema ? { output_schema: body.output_schema } : {}),
        };
        return {
          ...body,
          created_at: history[2].created_at,
          current_version: undocumented ? null : 3,
          current_version_id: undocumented ? null : history[0].id,
          draft_version_id: null,
          ...(undocumented ? { lifecycle: "draft", steps: [] } : {}),
          creator: undocumented ? null : history[2].author,
          checksum: undocumented ? null : history[0].checksum,
        };
      });
    if (path === "/v1/identity/users")
      return transform(route, (body) => ({
        ...body,
        items: [
          [actorId, email],
          [fileCreatorId, fileCreatorEmail],
          [keyOwnerId, keyOwnerEmail],
          [keyCreatorId, keyCreatorEmail],
        ].map(([id, address]) => ({ ...body.items[0], id, email: address })),
        total: 4,
      }));
    if (path === `/v1/files/${recordId}`)
      return transform(route, (body) => ({
        ...body,
        created_by: fileCreatorKnown ? fileCreatorId : actorId,
        creator: fileCreatorKnown ? { kind: "user", id: fileCreatorId } : null,
        created_at: fileCreatedAt,
      }));
    if (path === "/v1/identity/api-keys")
      return transform(route, (body) => ({
        ...body,
        items: body.items.map((item) =>
          item.id === recordId
            ? {
                ...item,
                user_id: keyOwnerId,
                system_account_id: null,
                creator: keyCreatorKnown ? { kind: "user", id: keyCreatorId } : null,
              }
            : item,
        ),
      }));
    if (path === `/v1/workflows/${recordId}/execution-authorities`)
      return transform(route, (body) => ({
        ...body,
        items: body.items.map((authority) => ({
          ...authority,
          created_at: authorityCreatedAt,
          created_by: authorityCreatorKnown ? actorId : unknownAuthorityCreatorId,
        })),
      }));
    if (path === "/v1/identity/system-accounts")
      return transform(route, (body) => ({
        ...body,
        items: [{ ...body.items[0], id: actorId, name: account }],
        total: 1,
      }));
    return route.fallback();
  };
  await page.route(pattern, handler);
  try {
    await stand.visit(page, `workflows/${recordId}`);
    await page.getByTestId("workflow-tabs-tab-structure").click();
    await page.getByTestId("workflow-versions-toggle").click();
    const labels = [email, t("runs.caller.unknown"), account];
    for (const [index, version] of history.entries()) {
      const row = page
        .locator(
          `[data-testid="workflow-versions-row-${index}"], [data-testid="workflow-versions-mobile-row-${index}"]`,
        )
        .filter({ visible: true });
      const date = await page.evaluate(
        ({ tag, at }) =>
          new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(at),
          ),
        { tag: LOCALE_TAGS[locale], at: version.created_at },
      );
      const saved = `${labels[index]} · ${date}`;
      await exact(row, saved);
      require(!(await row.innerText()).includes(
        actorId,
      ), "Version list exposes a raw actor identifier");
      await row.getByRole("button", { name: `v${version.version}`, exact: true }).click();
      const sheet = page.getByTestId("workflow-version-sheet");
      await exact(sheet.getByTestId("workflow-version-facts"), saved);
      require(!(await sheet.innerText()).includes(
        actorId,
      ), "Version sheet exposes a raw actor identifier");
      await capture(`workflow-version-author-${version.version}`);
      await page.getByTestId("workflow-version-sheet-close").click();
      await sheet.waitFor({ state: "hidden" });
    }
    await page.getByTestId("workflow-technical-toggle").click();
    await exact(page.getByTestId("workflow-technical-checksum").locator("dd"), checksum);
    await exact(page.getByTestId("workflow-technical-creator").locator("dd"), account);
    require((await page.getByTestId("workflow-technical-creator").innerText()).includes(email) ===
      false, "Creator was incorrectly taken from the latest version author");
    await capture("workflow-technical-known-creator-checksum");
    undocumented = true;
    await stand.visit(page, `workflows/${recordId}`);
    await page.getByTestId("workflow-tabs-tab-structure").click();
    await page.getByTestId("workflow-technical-toggle").click();
    await exact(page.getByTestId("workflow-technical-checksum").locator("dd"), "—");
    await exact(
      page.getByTestId("workflow-technical-creator").locator("dd"),
      t("runs.caller.unknown"),
    );
    await capture("workflow-technical-undocumented-creator-checksum");

    await stand.visit(page, `files/${recordId}`);
    const fileFacts = page.getByTestId("file-facts");
    await fileFacts
      .getByText(
        t("files.uploadedBy", {
          date: formatDateTime(locale, fileCreatedAt),
          name: fileCreatorEmail,
        }),
        { exact: true },
      )
      .waitFor({ state: "visible" });
    require(!(await fileFacts.innerText()).includes(
      fileCreatorId,
    ), "File facts expose a raw creator identifier");
    await capture("file-known-creator");
    fileCreatorKnown = false;
    await stand.visit(page, `files/${recordId}`);
    await fileFacts
      .getByText(
        t("files.uploadedBy", {
          date: formatDateTime(locale, fileCreatedAt),
          name: t("runs.caller.unknown"),
        }),
        { exact: true },
      )
      .waitFor({ state: "visible" });
    require(!(await fileFacts.innerText()).includes(
      fileCreatorId,
    ), "Unknown file creator exposes a raw identifier");
    await capture("file-unknown-creator");

    await stand.visit(page, "api-access?section=keys");
    await page
      .locator(
        '[data-testid="api-keys-row-link-0"]:visible, [data-testid="api-keys-mobile-row-link-0"]:visible',
      )
      .click();
    const keyFacts = page.getByTestId("api-key-sheet-facts");
    const ownerFact = keyFacts.getByText(t("apiKeys.owner"), { exact: true }).locator("xpath=..");
    const creatorFact = keyFacts
      .getByText(t("apiKeys.creator"), { exact: true })
      .locator("xpath=..");
    await ownerFact.getByText(keyOwnerEmail, { exact: true }).waitFor({ state: "visible" });
    await creatorFact.getByText(keyCreatorEmail, { exact: true }).waitFor({ state: "visible" });
    require(!(await keyFacts.innerText()).includes(keyOwnerId) &&
      !(await keyFacts.innerText()).includes(
        keyCreatorId,
      ), "API-key facts expose a raw owner or creator identifier");
    await capture("api-key-owner-distinct-from-creator");
    keyCreatorKnown = false;
    await stand.visit(page, "api-access?section=keys");
    await page
      .locator(
        '[data-testid="api-keys-row-link-0"]:visible, [data-testid="api-keys-mobile-row-link-0"]:visible',
      )
      .click();
    const unknownKeyFacts = page.getByTestId("api-key-sheet-facts");
    await unknownKeyFacts
      .getByText(t("apiKeys.owner"), { exact: true })
      .locator("xpath=..")
      .getByText(keyOwnerEmail, { exact: true })
      .waitFor({ state: "visible" });
    await unknownKeyFacts
      .getByText(t("apiKeys.creator"), { exact: true })
      .locator("xpath=..")
      .getByText(t("common.unknown"), { exact: true })
      .waitFor({ state: "visible" });
    await capture("api-key-unknown-creator-owner-retained");

    await stand.visit(page, `workflows/${recordId}`);
    await page.getByTestId("workflow-tabs-tab-approvals").click();
    await page.getByTestId("workflow-former-grants-toggle").click();
    const approvalRow = page.getByTestId("authority-history-0").locator("xpath=ancestor::tr");
    await approvalRow
      .getByText(`${email} · ${formatDateTime(locale, authorityCreatedAt)}`, { exact: true })
      .waitFor({ state: "visible" });
    require(!(await approvalRow.innerText()).includes(
      actorId,
    ), "Workflow approval row exposes a raw creator identifier");
    await approvalRow.click();
    const approvalSheet = page.getByTestId("authority-sheet");
    await approvalSheet.waitFor({ state: "visible" });
    await approvalSheet
      .getByTestId("authority-effects")
      .getByText("https://reports.example.test/monthly", { exact: false })
      .waitFor({ state: "visible" });
    require(!(await approvalSheet.innerText()).includes(
      email,
    ), "Workflow approval scope is confused with its creator");
    await capture("workflow-approval-creator-separated-from-scope");
    authorityCreatorKnown = false;
    await stand.visit(page, `workflows/${recordId}`);
    await page.getByTestId("workflow-tabs-tab-approvals").click();
    await page.getByTestId("workflow-former-grants-toggle").click();
    const unknownApprovalRow = page
      .getByTestId("authority-history-0")
      .locator("xpath=ancestor::tr");
    await unknownApprovalRow
      .getByText(`${t("audit.actor.user")} · ${formatDateTime(locale, authorityCreatedAt)}`, {
        exact: true,
      })
      .waitFor({ state: "visible" });
    require(!(await unknownApprovalRow.innerText()).includes(
      unknownAuthorityCreatorId,
    ), "Unmapped workflow approval creator exposes a raw identifier");
    await capture("workflow-approval-unmapped-creator");
    require(writes.length === 0, "Read-only version evidence attempted a workflow mutation");
  } finally {
    await page.unroute(pattern, handler);
  }
}
