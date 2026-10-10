import { chromium } from "playwright";
import { verifyConventionJourneys } from "./konvention-check.mjs";
import { verifyApiAccess } from "./lib/cockpit-api-access.mjs";
import { verifyCatalogEvidence } from "./lib/cockpit-catalog-evidence.mjs";
import { verifyChatActivation } from "./lib/cockpit-chat-activation.mjs";
import { verifyChatActivity } from "./lib/cockpit-chat-activity.mjs";
import { verifyChatApprovals, verifyChatDecidedApproval } from "./lib/cockpit-chat-approvals.mjs";
import { verifyChatChoices } from "./lib/cockpit-chat-choices.mjs";
import { verifyChatHeader } from "./lib/cockpit-chat-header.mjs";
import { verifyChatOAuth } from "./lib/cockpit-chat-oauth.mjs";
import { verifyChatReauth } from "./lib/cockpit-chat-reauth.mjs";
import { verifyChatReplies } from "./lib/cockpit-chat-replies.mjs";
import { verifyConnectorDetail } from "./lib/cockpit-connector-detail.mjs";
import { verifyCreateConnector } from "./lib/cockpit-create-connector.mjs";
import { verifyDecisionLifecycle } from "./lib/cockpit-decisions.mjs";
import { verifyDescriptionEvidence } from "./lib/cockpit-description-evidence.mjs";
import { verifyDetailAction } from "./lib/cockpit-detail-action.mjs";
import { verifyEdgeStates } from "./lib/cockpit-edge-states.mjs";
import { verifyEnginePages } from "./lib/cockpit-engine-pages.mjs";
import { verifyFirstClickOpens } from "./lib/cockpit-first-click.mjs";
import { assertFirstSendIsNeverLost } from "./lib/cockpit-first-send.mjs";
import {
  verifyListPagination,
  verifyNotificationActions,
  verifyReviewCloseHistory,
} from "./lib/cockpit-functional-navigation.mjs";
import { selectFunctionalJourneys } from "./lib/cockpit-functional-selection.mjs";
import { verifyGateDiagnosis } from "./lib/cockpit-gate-diagnosis.mjs";
import { verifyChatReviewCard, verifyGrantDialog } from "./lib/cockpit-grant-dialog.mjs";
import { verifyHookHolds } from "./lib/cockpit-hook-holds.mjs";
import { standAt } from "./lib/cockpit-identity.mjs";
import { verifyIdentityEvidence } from "./lib/cockpit-identity-evidence.mjs";
import { verifyInstallationPages } from "./lib/cockpit-installation.mjs";
import {
  API_KEYS,
  CONNECTIONS,
  conversation,
  ENGINE_SETTINGS,
  mockApi,
  OAUTH_CLIENTS,
  REAL_OAUTH_CLIENTS,
  runConnectorId,
  uuid,
} from "./lib/cockpit-journey-fixtures.mjs";
import { verifyKnowledgeDetailEvidence } from "./lib/cockpit-knowledge-detail-evidence.mjs";
import { verifyKnowledgeHistoryProposalsEvidence } from "./lib/cockpit-knowledge-history-proposals-evidence.mjs";
import { verifyKnowledgeTotals } from "./lib/cockpit-knowledge-totals.mjs";
import { verifyKnowledgeWriteEvidence } from "./lib/cockpit-knowledge-write-evidence.mjs";
import { verifyLoadFailures } from "./lib/cockpit-load-failures.mjs";
import { verifyManagementEvidence } from "./lib/cockpit-management-evidence.mjs";
import { verifyPeopleLoadsPerTab } from "./lib/cockpit-people-tabs.mjs";
import { startPreviewServer } from "./lib/cockpit-preview-server.mjs";
import { verifyRunDialog } from "./lib/cockpit-run-dialog.mjs";
import { verifyRunSheet, verifyRunsOverCatalog } from "./lib/cockpit-run-sheet.mjs";
import { verifyScheduleHolds } from "./lib/cockpit-schedule-holds.mjs";
import { verifySessionExpiry } from "./lib/cockpit-session-expiry.mjs";
import { verifyTemplateLists } from "./lib/cockpit-template-lists.mjs";
import { verifyWorkflowAuthorities } from "./lib/cockpit-workflow-authorities.mjs";
import { verifyWorkflowHistoryEvidence } from "./lib/cockpit-workflow-history-evidence.mjs";
import { verifyWorkflowPage } from "./lib/cockpit-workflow-page.mjs";
import { verifyWorkflowPreview } from "./lib/cockpit-workflow-preview.mjs";

const capture = async () => {};
const locale = "de";
const journeys = [
  [
    "verifyReviewCloseHistory",
    (page, stand) => verifyReviewCloseHistory(page, stand, "functional/review-history"),
  ],
  [
    "verifyNotificationActions",
    (page, stand) => verifyNotificationActions(page, stand, "functional/notifications"),
  ],
  [
    "verifyWorkflowPagination",
    (page, stand) =>
      verifyListPagination(page, stand, "functional/workflows-pagination", "workflows"),
  ],
  [
    "verifyAuditPagination",
    (page, stand) => verifyListPagination(page, stand, "functional/audit-pagination", "audit"),
  ],
  [
    "verifyRunsOverCatalog",
    (page, stand) => verifyRunsOverCatalog(page, stand, "functional/runs-over-catalog"),
  ],
  [
    "verifyApiAccess",
    (page, stand) =>
      verifyApiAccess(page, stand, locale, {
        realClients: REAL_OAUTH_CLIENTS,
        deadClients: OAUTH_CLIENTS.filter(
          (item) => !item.disabled_at && item.live_connections === 0,
        ).length,
        disabledClients: OAUTH_CLIENTS.filter((item) => item.disabled_at).length,
        activeKeys: API_KEYS.filter((item) => !item.revoked_at).length,
        revokedKeys: API_KEYS.filter((item) => item.revoked_at).length,
        grantsToRenew: CONNECTIONS.filter((item) =>
          ["expiring", "expired", "unreadable"].includes(item.state),
        ).length,
      }),
  ],
  [
    "verifyEnginePages",
    (page) =>
      verifyEnginePages(page, { locale, scheme: "light" }, "functional/engine-pages", capture, {
        functionalOnly: true,
      }),
  ],
  [
    "verifyInstallationPages",
    (page, stand) =>
      verifyInstallationPages(page, stand, locale, capture, {
        settingRows: ENGINE_SETTINGS.map((item) => ({
          path: item.path,
          scope: item.meta.scope,
          source: item.meta.source,
          description: item.meta.description ?? null,
        })),
      }),
  ],
  [
    "verifyFirstClickOpens",
    (page, stand) => verifyFirstClickOpens(page, stand, "functional/first-click"),
  ],
  [
    "verifyRunSheet",
    (page, stand) => verifyRunSheet(page, stand, uuid, locale, "functional/run-sheet"),
  ],
  ["verifyTemplateLists", (page, stand) => verifyTemplateLists(page, stand, capture)],
  ["verifyWorkflowPage", (page, stand) => verifyWorkflowPage(page, stand, locale, capture)],
  ["verifyConnectorDetail", (page, stand) => verifyConnectorDetail(page, stand, locale, capture)],
  ["verifyCreateConnector", (page, stand) => verifyCreateConnector(page, stand, locale, capture)],
  ["verifyHookHolds", (page, stand) => verifyHookHolds(page, stand, uuid, locale, capture)],
  ["verifyScheduleHolds", (page, stand) => verifyScheduleHolds(page, stand, uuid, locale, capture)],
  [
    "verifyChatActivation",
    (page, stand) => verifyChatActivation(page, stand, conversation, locale, capture),
  ],
  [
    "verifyChatActivity",
    (page, stand) => verifyChatActivity(page, stand, conversation, locale, capture),
  ],
  [
    "verifyChatApprovals",
    (page, stand) => verifyChatApprovals(page, stand, conversation, locale, capture),
  ],
  [
    "verifyChatDecidedApproval",
    (page, stand) => verifyChatDecidedApproval(page, stand, conversation, locale, capture),
  ],
  [
    "verifyChatChoices",
    (page, stand) => verifyChatChoices(page, stand, conversation, locale, capture),
  ],
  [
    "verifyChatHeader",
    (page, stand) => verifyChatHeader(page, stand, conversation, locale, capture),
  ],
  ["verifyChatOAuth", (page, stand) => verifyChatOAuth(page, stand, conversation, locale, capture)],
  ["verifyChatReauth", (page, stand) => verifyChatReauth(page, stand, conversation)],
  [
    "verifyChatReplies",
    (page, stand) => verifyChatReplies(page, stand, conversation, locale, capture),
  ],
  [
    "verifyDecisionLifecycle",
    (page, stand) => verifyDecisionLifecycle(page, stand, uuid, locale, capture),
  ],
  ["verifyDetailAction", (page, stand) => verifyDetailAction(page, stand, uuid, locale, capture)],
  ["verifyEdgeStates", (page, stand) => verifyEdgeStates(page, stand, capture)],
  ["verifyGateDiagnosis", (page, stand) => verifyGateDiagnosis(page, stand, uuid, locale, capture)],
  [
    "verifyChatReviewCard",
    (page, stand) => verifyChatReviewCard(page, stand, conversation, locale, capture),
  ],
  ["verifyGrantDialog", (page, stand) => verifyGrantDialog(page, stand, locale, capture)],
  [
    "verifyCatalogEvidence",
    (page, stand) => verifyCatalogEvidence(page, stand, locale, capture, { tenantId: uuid }),
  ],
  [
    "verifyDescriptionEvidence",
    (page, stand) =>
      verifyDescriptionEvidence(page, stand, locale, capture, { mockApi, recordId: uuid }),
  ],
  [
    "verifyKnowledgeDetailEvidence",
    (page, stand) =>
      verifyKnowledgeDetailEvidence(page, stand, locale, capture, { mockApi, recordId: uuid }),
  ],
  [
    "verifyKnowledgeHistoryProposalsEvidence",
    (page, stand) =>
      verifyKnowledgeHistoryProposalsEvidence(page, stand, locale, capture, {
        mockApi,
        recordId: uuid,
      }),
  ],
  ["verifyKnowledgeTotals", (page, stand) => verifyKnowledgeTotals(page, stand, locale, capture)],
  [
    "verifyKnowledgeWriteEvidence",
    (page, stand) =>
      verifyKnowledgeWriteEvidence(page, stand, locale, capture, { mockApi, recordId: uuid }),
  ],
  ["verifyLoadFailures", (page, stand) => verifyLoadFailures(page, stand, conversation, capture)],
  [
    "verifyManagementEvidence",
    (page, stand) =>
      verifyManagementEvidence(page, stand, locale, capture, { mockApi, tenantId: uuid }),
  ],
  [
    "verifyPeopleLoadsPerTab",
    (page, stand) => verifyPeopleLoadsPerTab(page, stand, "functional/people-tabs"),
  ],
  ["verifyRunDialog", (page, stand) => verifyRunDialog(page, stand, locale, capture)],
  ["verifySessionExpiry", (page, stand) => verifySessionExpiry(page, stand, uuid, locale, capture)],
  [
    "verifyWorkflowAuthorities",
    (page, stand) => verifyWorkflowAuthorities(page, stand, uuid, locale, capture),
  ],
  [
    "verifyWorkflowHistoryEvidence",
    (page, stand) =>
      verifyWorkflowHistoryEvidence(page, stand, locale, capture, { mockApi, recordId: uuid }),
  ],
  [
    "verifyWorkflowPreview",
    (page, stand) => verifyWorkflowPreview(page, stand, uuid, locale, capture),
  ],
  [
    "verifyIdentityEvidence",
    (page, stand) =>
      verifyIdentityEvidence(page, stand, locale, capture, {
        mockApi,
        workflowId: uuid,
        workflowVersionId: "018f4b4a-6d33-7b3a-9c2d-123456789ab8",
        connectorId: runConnectorId,
        secondConnectorId: uuid,
        executionId: uuid,
      }),
  ],
];
const { selected, partial } = selectFunctionalJourneys(
  journeys,
  process.argv.slice(2),
  process.env,
);
const preview = await startPreviewServer();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const stand = standAt({ baseUrl: preview.baseUrl, refuse: (message) => new Error(message) });
  for (const [name, run] of selected) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "de-DE",
    });
    try {
      await context.addInitScript(() => {
        localStorage.setItem("sk-cockpit-locale", "de");
        localStorage.setItem("sk-cockpit-theme", "light");
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/v1/**", mockApi);
      await stand.visit(page, "");
      await run(page, stand);
      if (errors.length) throw new Error(errors.join("; "));
      console.log(`PASS ${name}`);
    } catch (error) {
      throw new Error(`Cockpit functional journey ${name} failed`, { cause: error });
    } finally {
      await context.close();
    }
  }
  if (!partial) {
    await assertFirstSendIsNeverLost(browser, stand);
    console.log("PASS assertFirstSendIsNeverLost");
    await verifyConventionJourneys(browser, preview.baseUrl);
    console.log("PASS verifyConventionJourneys");
  }
  console.log(
    `${partial ? "Targeted cockpit iteration (not the full gate)" : "Cockpit functional gate"} passed: ${selected.length + (partial ? 0 : 2)}`,
  );
} finally {
  await Promise.all([browser?.close(), preview.stop()]);
}
