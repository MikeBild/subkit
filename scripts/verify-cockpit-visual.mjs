import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { verifyApiAccess } from "./lib/cockpit-api-access.mjs";
import { verifyCatalogEvidence } from "./lib/cockpit-catalog-evidence.mjs";
import { verifyChatActivation } from "./lib/cockpit-chat-activation.mjs";
import { verifyChatActivity } from "./lib/cockpit-chat-activity.mjs";
import { verifyChatApprovals, verifyChatDecidedApproval } from "./lib/cockpit-chat-approvals.mjs";
import { verifyChatChoices } from "./lib/cockpit-chat-choices.mjs";
import { verifyChatHeader } from "./lib/cockpit-chat-header.mjs";
import { assertChatLayout } from "./lib/cockpit-chat-layout.mjs";
import { verifyChatOAuth } from "./lib/cockpit-chat-oauth.mjs";
import { verifyChatReauth } from "./lib/cockpit-chat-reauth.mjs";
import { verifyChatReplies } from "./lib/cockpit-chat-replies.mjs";
import { verifyChatStability } from "./lib/cockpit-chat-stability.mjs";
import { verifyConnectorDetail } from "./lib/cockpit-connector-detail.mjs";
import { verifyCreateConnector } from "./lib/cockpit-create-connector.mjs";
import { verifyDecisionLifecycle } from "./lib/cockpit-decisions.mjs";
import { verifyDescriptionEvidence } from "./lib/cockpit-description-evidence.mjs";
import { verifyDetailAction } from "./lib/cockpit-detail-action.mjs";
import { verifyEdgeStates } from "./lib/cockpit-edge-states.mjs";
import { verifyEnginePages } from "./lib/cockpit-engine-pages.mjs";
import { assertFamilyGeometry } from "./lib/cockpit-family-geometry.mjs";
import { verifyFirstClickOpens } from "./lib/cockpit-first-click.mjs";
import { assertFirstSendIsNeverLost } from "./lib/cockpit-first-send.mjs";
import { verifyGateDiagnosis } from "./lib/cockpit-gate-diagnosis.mjs";
import { verifyChatReviewCard, verifyGrantDialog } from "./lib/cockpit-grant-dialog.mjs";
import { verifyHookHolds } from "./lib/cockpit-hook-holds.mjs";
import { standAt } from "./lib/cockpit-identity.mjs";
import { verifyIdentityEvidence } from "./lib/cockpit-identity-evidence.mjs";
import { verifyInstallationPages } from "./lib/cockpit-installation.mjs";
import {
  API_KEYS,
  ATTENTION_ENGINE_DETAIL,
  ATTENTION_ITEMS,
  assertAuditFixtureActionsAreReal,
  attentionAnswer,
  BLOCKED_WORKFLOW_ID,
  CONNECTIONS,
  conversation,
  ENGINE_SETTINGS,
  focused,
  hostileAuthority,
  mockApi,
  OAUTH_CLIENTS,
  REAL_OAUTH_CLIENTS,
  runConnectorId,
  runWorkflowId,
  SETTINGS_SECTION_COUNT,
  standOn,
  sweepList,
  sweptRoutes,
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
import {
  assertSingleTriggers,
  isSheetView,
  patternMigratedView,
  patternViewRoot,
  TRANSCRIPT,
} from "./lib/cockpit-single-trigger.mjs";
import { verifyTemplateLists } from "./lib/cockpit-template-lists.mjs";
import { watchUnpromptedTooltips } from "./lib/cockpit-unprompted-tooltip.mjs";
import { assertNoVisibleUuids } from "./lib/cockpit-visible-uuids.mjs";
import { verifyWorkflowAuthorities } from "./lib/cockpit-workflow-authorities.mjs";
import { verifyWorkflowHistoryEvidence } from "./lib/cockpit-workflow-history-evidence.mjs";
import { verifyWorkflowPage } from "./lib/cockpit-workflow-page.mjs";
import { verifyWorkflowPreview } from "./lib/cockpit-workflow-preview.mjs";

const spawnedPreview = process.env.COCKPIT_BASE_URL ? null : await startPreviewServer();
const baseUrl = (process.env.COCKPIT_BASE_URL || spawnedPreview.baseUrl).replace(/\/$/, "");
const outputDir = resolve(process.env.COCKPIT_SCREENSHOT_DIR || ".artifacts/cockpit-sweep/local");
function artifactRouteName(route) {
  const [rawPath, query] = route.split("?");
  const name = (rawPath || "overview").replace(/\/[^/]+$/, "-record");
  return query ? `${name}-${query.replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "")}` : name;
}

function markerFor(route) {
  const path = route.split("?")[0];
  if (/^workflows\/.+/.test(path)) return '[data-testid="workflow-invocation"]';
  if (/^connectors\/.+/.test(path)) return '[data-testid="connector-strip-state"]';
  if (/^files\/.+/.test(path)) return '[data-testid="file-sheet"] [data-testid="file-facts"]';
  if (path === "files") return '[data-testid="files-page"]';
  if (/^(knowledge|skills)\/.+/.test(path))
    return `[data-testid="detail-${path.split("/")[0]}"] [data-testid="detail-overview"]`;
  if (path === "chat") return '[data-testid="chat-workspace"]';
  const query = route.split("?")[1] ?? "";
  if (/(^|&)run=/.test(query)) return '[data-testid="run-detail-summary"]';
  if (/(^|&)runs=all/.test(query)) return '[data-testid="resource-runs"]';
  if (path === "")
    return query.startsWith("review=")
      ? '[data-testid="attention-review-body"]'
      : '[data-testid="attention-list"]';
  if (path === "access") return '[data-testid="roles-section"]';
  if (path === "people" && query.startsWith("section="))
    return `[data-testid="${query.slice("section=".length)}-section"]`;
  if (path === "api-access" && query.startsWith("section="))
    return `[data-testid="api-access-section-${query.slice("section=".length)}"]`;
  if (path === "settings" && query === "tab=notifications")
    return '[data-testid="notifications-rules"]';
  if (path === "settings" && query.startsWith("section="))
    return `[data-testid="settings-section-${query.slice("section=".length)}"]`;
  if (["people", "api-access", "settings"].includes(path)) return `[data-testid="admin-${path}"]`;
  if (["workflows", "connectors", "knowledge", "skills", "files"].includes(path))
    return `[data-testid="catalog-${path}"]`;
  return `[data-testid="resource-${path}"]`;
}

function documentThemeMatches(classes, theme) {
  const dark = classes?.split(/\s+/).includes("dark") ?? false;
  return theme === "dark" ? dark : !dark;
}

async function assertNoHorizontalScroll(page, label) {
  const found = await page.evaluate(() => {
    const width = window.innerWidth;
    const inScroller = (node) => {
      for (let up = node.parentElement; up; up = up.parentElement) {
        const x = window.getComputedStyle(up).overflowX;
        if ((x === "auto" || x === "scroll") && up.getBoundingClientRect().right <= width + 1)
          return true;
      }
      return false;
    };
    const containers = [
      ...document.querySelectorAll(
        '[data-testid="page-content"], [data-family-slot="scroll-region"], [data-family-slot="content"], main[data-page-kind]',
      ),
    ]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .flatMap((node) => {
        const frame = node.getBoundingClientRect();
        const inner = frame.left + node.clientWidth;
        const clipped = (el) => {
          for (let up = el.parentElement; up && up !== node; up = up.parentElement) {
            const x = window.getComputedStyle(up).overflowX;
            if (x === "auto" || x === "scroll" || x === "hidden" || x === "clip") return true;
          }
          return false;
        };
        let widest = null;
        for (const child of node.querySelectorAll("*")) {
          const right = child.getBoundingClientRect().right;
          if (right > inner + 1 && !clipped(child) && (!widest || right > widest.right))
            widest = { child, right };
        }
        const name = (el) =>
          el.getAttribute("data-testid") ?? el.getAttribute("data-slot") ?? el.tagName;
        if (widest && widest.right <= width + 1) return [];
        const culprit = widest
          ? ` (${name(widest.child)} reaches ${Math.round(widest.right)}px of ${Math.round(inner)}px)`
          : "";
        return [
          `${node.getAttribute("data-testid") ?? node.tagName} is wider than its frame${culprit}`,
        ];
      });
    const poking = [...document.querySelectorAll("body *")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.right <= width + 1) return false;
        const style = window.getComputedStyle(node);
        if (style.visibility === "hidden" || style.position === "fixed") return false;
        return !inScroller(node);
      })
      .slice(0, 3)
      .map(
        (node) =>
          `${node.getAttribute("data-testid") ?? node.tagName} reaches ${Math.round(node.getBoundingClientRect().right)}px`,
      );
    return [...containers, ...poking];
  });
  if (found.length) throw new Error(`${label} scrolls sideways: ${found.join(", ")}`);
}

async function assertDesktopLayout(page, label) {
  const issues = await page.evaluate(() => {
    const main = document.querySelector('main[data-page-kind="list"]');
    const content = main?.querySelector('[data-family-slot="content"]');
    const problems = [];
    if (main && !content) problems.push("list page has no content slot");
    if (main && content) {
      const mainRect = main.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const inset = (mainRect.width - contentRect.width) / 2;
      if (contentRect.width < mainRect.width * 0.78)
        problems.push(
          `list content uses ${Math.round((contentRect.width / mainRect.width) * 100)}% of available width`,
        );
      if (Math.abs(contentRect.left - mainRect.left - inset) > 10)
        problems.push("list content is not centered in its available width");
    }
    for (const row of document.querySelectorAll("table tbody tr")) {
      const cells = [...row.querySelectorAll("td")];
      const cellTextRects = (cell) => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        const rects = [];
        while (walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const rect of range.getClientRects()) {
            const visible = {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
            for (
              let parent = walker.currentNode.parentElement;
              parent && parent !== cell;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              const bounds = parent.getBoundingClientRect();
              if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
                visible.left = Math.max(visible.left, bounds.left);
                visible.right = Math.min(visible.right, bounds.right);
              }
              if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
                visible.top = Math.max(visible.top, bounds.top);
                visible.bottom = Math.min(visible.bottom, bounds.bottom);
              }
            }
            if (visible.right > visible.left && visible.bottom > visible.top) rects.push(visible);
          }
        }
        return rects;
      };
      const contentCells = cells.filter(
        (cell) => !cell.matches('[data-slot="row-actions"], [data-slot="row-chevron"]'),
      );
      const textRects = contentCells.map(cellTextRects);
      const intersects = (left, right) =>
        left.left < right.right - 2 &&
        left.right > right.left + 2 &&
        left.top < right.bottom - 2 &&
        left.bottom > right.top + 2;
      const overlappingCells = textRects.flatMap((left, index) => {
        const nextIndex = textRects
          .slice(index + 1)
          .findIndex((right) => left.some((a) => right.some((b) => intersects(a, b))));
        if (nextIndex < 0) return [];
        const other = index + nextIndex + 1;
        const pair = left.flatMap((a) =>
          textRects[other].filter((b) => intersects(a, b)).map((b) => [a, b]),
        )[0];
        const [a, b] = pair;
        return [
          `${index}/${other} ${contentCells[index].innerText.trim().slice(0, 48)} / ${contentCells[other].innerText.trim().slice(0, 48)} @${Math.round(a.left)}-${Math.round(a.right)}x${Math.round(a.top)}-${Math.round(a.bottom)}:${Math.round(b.left)}-${Math.round(b.right)}x${Math.round(b.top)}-${Math.round(b.bottom)}`,
        ];
      });
      if (overlappingCells.length)
        problems.push(`text overlaps between table cells ${overlappingCells.join(",")}`);
      const actionCell = row.querySelector('[data-slot="row-actions"]');
      if (!actionCell) continue;
      const actionBounds = actionCell.getBoundingClientRect();
      const controls = [...actionCell.querySelectorAll('button, a[role="button"]')];
      const controlRects = controls.flatMap((control) => {
        const rect = control.getBoundingClientRect();
        return rect.width && rect.height ? [rect] : [];
      });
      if (
        controlRects.some(
          (rect) =>
            rect.left < actionBounds.left - 1 ||
            rect.right > actionBounds.right + 1 ||
            rect.top < actionBounds.top - 1 ||
            rect.bottom > actionBounds.bottom + 1,
        )
      )
        problems.push("action control escapes its table cell");
      if (
        controlRects.some((left, index) =>
          controlRects.slice(index + 1).some((right) => intersects(left, right)),
        )
      )
        problems.push("table action controls overlap");
      if (
        textRects.some((rects) =>
          rects.some((text) => controlRects.some((control) => intersects(text, control))),
        )
      )
        problems.push("table cell text overlaps an action control");
    }
    return [...new Set(problems)];
  });
  if (issues.length) {
    if (process.env.COCKPIT_LAYOUT_DIAGNOSTIC)
      await page.screenshot({
        path: resolve(process.env.COCKPIT_LAYOUT_DIAGNOSTIC),
        fullPage: true,
      });
    throw new Error(`${label} layout geometry failed: ${issues.join(", ")}`);
  }
}

async function assertViewport(page, label) {
  const geometry = await page.evaluate(() => {
    const content = document.querySelector('[data-testid="page-content"]');
    if (!(content instanceof HTMLElement)) throw new Error("page content missing");
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
      contentWidth: content.scrollWidth,
      contentClientWidth: content.clientWidth,
      contentBottom: content.getBoundingClientRect().bottom,
    };
  });
  if (
    geometry.bodyWidth > geometry.viewportWidth + 1 ||
    geometry.contentWidth > geometry.contentClientWidth + 1
  )
    throw new Error(`${label} has horizontal overflow`);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="dialog"]')].every((sheet) =>
        sheet.getAnimations().every((animation) => animation.playState !== "running"),
      ),
    undefined,
    { timeout: 5_000 },
  );
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"]')].flatMap((sheet) => {
      const edge = sheet.getBoundingClientRect().right;
      return [...sheet.querySelectorAll("*")]
        .filter((node) => {
          if (node.getBoundingClientRect().right <= edge + 1) return false;
          for (let up = node.parentElement; up && up !== sheet; up = up.parentElement) {
            const x = window.getComputedStyle(up).overflowX;
            if (x === "auto" || x === "scroll") return false;
          }
          return true;
        })
        .slice(0, 3)
        .map(
          (node) =>
            `${node.getAttribute("data-testid") ?? node.tagName} "${(node.textContent ?? "").trim().slice(0, 40)}"`,
        );
    }),
  );
  if (clipped.length)
    throw new Error(`${label} has a sheet cut off at its edge: ${clipped.join(", ")}`);
  if (
    geometry.bodyHeight > geometry.viewportHeight + 1 ||
    geometry.contentBottom > geometry.viewportHeight + 1
  )
    throw new Error(`${label} grows beyond the viewport`);
}

async function assertOpenOnce(page, label) {
  if (await page.locator('[data-testid^="data-table-open-"]').count())
    throw new Error(`${label}: a row still carries an "Öffnen" button`);
  if (await page.locator('[data-family-collection-row="true"][tabindex="0"]').count())
    throw new Error(`${label}: a row is a tab stop beside its own link`);
  let open = page.locator('[data-testid="data-table-row-link-0"]');
  if (!(await open.isVisible().catch(() => false)))
    open = page.locator('[data-testid="data-table-mobile-row-link-0"]');
  if (!(await open.isVisible().catch(() => false)))
    throw new Error(`${label}: the first run names itself with no link`);
  const href = await open.getAttribute("href");
  if (!href || !/^\/cockpit\?(?:[^#]*&)?run=[^&#]+/.test(href))
    throw new Error(`${label}: the run link leads to ${href}, not to the run's own address`);
  const before = await page.evaluate(() => window.history.length);
  await open.focus();
  await page.keyboard.press("Enter");
  await page
    .locator('[data-testid="run-detail-summary"]')
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(async () => {
      const sheet = await page
        .locator('[role="dialog"]')
        .last()
        .innerText()
        .catch(() => "");
      throw new Error(
        `${label}: Enter on the run's link opened no run (${page.url()}): ${sheet.slice(0, 300)}`,
      );
    });
  const after = await page.evaluate(() => window.history.length);
  if (after - before !== 1)
    throw new Error(
      `${label}: Enter on the run's link added ${after - before} history entries — the record opened more than once`,
    );
  await page.goBack();
  await page.locator('[data-testid="run-detail"]').waitFor({ state: "hidden" });
  await page.locator('[data-testid="resource-runs"]').waitFor({ state: "visible" });
}

async function assertOverviewHostile(page, label, language) {
  const shape = await page.evaluate(() => {
    const entries = [
      ...document.querySelectorAll('[data-testid="attention-list"] [data-attention-id]'),
    ].filter((entry) => entry.getClientRects().length > 0);
    return {
      ids: entries.map((entry) => entry.getAttribute("data-attention-id")),
      primaries: entries.map((entry) => entry.querySelectorAll('[data-testid$="-primary"]').length),
      secondaries: entries.map(
        (entry) => entry.querySelectorAll('[data-testid$="-secondary"]').length,
      ),
      text: document.querySelector('[data-testid="attention-page"]')?.innerText ?? "",
      status: document.querySelectorAll('[data-testid="attention-status"]').length,
      calm: document.querySelectorAll('[data-testid="attention-calm"]').length,
      unread: document.querySelector('[data-testid="attention-unread"]')?.textContent ?? null,
      badge: document.querySelector('[data-testid="nav-overview-count"]')?.textContent ?? null,
    };
  });
  const expected = ATTENTION_ITEMS.map((item) => item.id);
  if (shape.ids.join("|") !== expected.join("|"))
    throw new Error(`${label}: entries ${shape.ids.join(", ")} — the engine sent ${expected}`);
  if (shape.primaries.some((count) => count !== 1))
    throw new Error(`${label}: an entry without exactly one primary action`);
  if (shape.secondaries.some((count) => count > 1))
    throw new Error(`${label}: an entry with more than one secondary link`);
  if (shape.badge !== null && Number(shape.badge) !== expected.length)
    throw new Error(`${label}: the badge says ${shape.badge}, the list holds ${expected.length}`);
  if (shape.calm || shape.status)
    throw new Error(`${label}: "all done" or a status line beside open entries`);
  if (!shape.unread?.includes(language === "de" ? "Betriebssignale" : "operating signals"))
    throw new Error(`${label}: the failed source is not named (${shape.unread})`);
  if (shape.text.includes(ATTENTION_ENGINE_DETAIL))
    throw new Error(`${label}: the engine's wording stands on the list`);
  const blocked = await page.evaluate((id) => {
    const entry = [...document.querySelectorAll(`[data-attention-id="workflow:${id}"]`)].find(
      (node) => node.getClientRects().length > 0,
    );
    const row = entry?.closest('tr, [data-testid*="mobile-row"]');
    return {
      text: row?.textContent ?? "",
      action: entry?.querySelector('[data-testid$="-primary"]')?.textContent?.trim() ?? "",
    };
  }, BLOCKED_WORKFLOW_ID);
  const wants =
    language === "de"
      ? { sentence: "blockiert", action: "Vorbereitung ausführen", refused: "Freigeben" }
      : { sentence: "blocked", action: "Run the preparation", refused: "Approve" };
  if (!blocked.text.includes(wants.sentence) || !blocked.text.includes("send_notification_email"))
    throw new Error(`${label}: the blocked version does not name its step (${blocked.text})`);
  if (blocked.action !== wants.action || blocked.action === wants.refused)
    throw new Error(`${label}: the blocked version offers "${blocked.action}"`);
  await assertOperationsBar(page, label);
}

async function assertOperationsBar(page, label) {
  await page.locator('[data-testid="operations-bar"] [data-figure-state]').first().waitFor();
  const shape = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="operations-bar"]');
    const figures = [...(bar?.querySelectorAll("[data-figure-state]") ?? [])];
    const below = document.querySelector(
      '[data-testid="attention-list"], [data-testid="attention-calm"]',
    );
    return {
      count: figures.length,
      rows: new Set(figures.map((figure) => Math.round(figure.getBoundingClientRect().top))).size,
      columns: new Set(figures.map((figure) => Math.round(figure.getBoundingClientRect().left)))
        .size,
      height: Math.max(...figures.map((figure) => figure.getBoundingClientRect().height)),
      belowTop: below ? below.getBoundingClientRect().top : null,
      links: [...(bar?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href")),
      innerHeight: window.innerHeight,
      phone: window.innerWidth < 640,
      overflow: bar ? bar.scrollWidth > bar.clientWidth + 1 : false,
      budget: (bar?.querySelector('[data-testid="operations-figure-budget"]')?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      pressure:
        bar
          ?.querySelector('[data-testid="operations-figure-budget"]')
          ?.getAttribute("data-budget-pressure") ?? null,
    };
  });
  if (shape.count !== 4)
    throw new Error(`${label}: the operations bar holds ${shape.count} figures`);
  const grids = shape.phone
    ? [[2, 2]]
    : [
        [1, 4],
        [2, 2],
      ];
  if (!grids.some(([rows, columns]) => shape.rows === rows && shape.columns === columns))
    throw new Error(
      `${label}: the figures stand in ${shape.rows}×${shape.columns}, not ${grids
        .map((grid) => grid.join("×"))
        .join(" or ")}`,
    );
  if (shape.overflow) throw new Error(`${label}: the operations bar scrolls sideways`);
  if (shape.height > 96)
    throw new Error(`${label}: a figure is ${shape.height}px tall, not compact`);
  if (shape.belowTop !== null && shape.belowTop > shape.innerHeight)
    throw new Error(`${label}: the bar pushes what needs the reader below the first screen`);
  for (const href of shape.links)
    if (!/runs_from=|ts_from=|health=not_ok|\/usage(\?window=24h)?$/.test(href ?? ""))
      throw new Error(`${label}: a figure links to ${href}, not to the list of its window`);
  if (!/412[,.]87/.test(shape.budget ?? ""))
    throw new Error(
      `${label}: the usage figure does not lead with the month's money: "${shape.budget}"`,
    );
  if (!/95\s*%/.test(shape.budget ?? "") || shape.pressure !== "critical")
    throw new Error(`${label}: the budget figure reads "${shape.budget}" (${shape.pressure})`);
}

async function assertUsageOrigins(page, label) {
  await page.locator('[data-testid="usage-origin"]:visible').first().waitFor();
  const shape = await page.evaluate(() => ({
    origins: [...document.querySelectorAll('[data-testid="usage-origin"]')]
      .filter((cell) => cell.getClientRects().length > 0)
      .map((cell) => ({
        origin: cell.getAttribute("data-origin"),
        text: (cell.textContent ?? "").trim(),
      })),
    sections: [
      ...document.querySelectorAll(
        '[data-testid="usage-origins"], [data-testid="usage-breakdown"], [data-testid="usage-models"]',
      ),
    ].map((section) => section.getAttribute("data-testid")),
    breakdown: (
      document.querySelector('[data-testid="usage-breakdown"]')?.textContent ?? ""
    ).trim(),
  }));
  const origins = shape.origins.map((row) => row.origin).sort();
  const expected = [
    "authoring",
    "chat",
    "knowledge",
    "other",
    "reviews",
    "summaries",
    "workflowRuns",
  ];
  if (origins.join("|") !== expected.join("|"))
    throw new Error(`${label}: the origin table holds ${origins.join(", ")}`);
  if (shape.origins[0]?.origin !== "chat")
    throw new Error(`${label}: the origin table does not lead with the largest, chat`);
  const other = shape.origins.find((row) => row.origin === "other");
  if (!other?.text.includes("some_future_flow"))
    throw new Error(`${label}: "Sonstiges" does not name the flow it holds: "${other?.text}"`);
  if (shape.sections.join("|") !== "usage-origins|usage-breakdown|usage-models")
    throw new Error(`${label}: the usage sections stand as ${shape.sections.join(", ")}`);
  if (/Keinem zuzuordnen|Not attributable/.test(shape.breakdown))
    throw new Error(`${label}: the workflow table still carries the catch-all row`);
}

async function assertReviewCloseLeavesNoTrail(page, label) {
  const open = page
    .locator('[data-testid="attention-list"] [data-attention-verb="review"]:visible')
    .first();
  const sheet = page.locator('[data-testid="attention-review"]');
  await stand.visit(page, "usage");
  await stand.visit(page, "");
  await open.click();
  await sheet.waitFor({ state: "visible" });
  await page.locator('[data-testid="attention-review-close"]').click();
  await sheet.waitFor({ state: "hidden" });
  if (new URL(page.url()).searchParams.get("review"))
    throw new Error(`${label}: the closed sheet is still in the address`);
  await page.goBack();
  await page
    .locator('[data-testid="resource-usage"], [data-testid="admin-usage"]')
    .first()
    .waitFor({
      state: "attached",
      timeout: 10_000,
    })
    .catch(() => {});
  const url = new URL(page.url());
  if ((await sheet.isVisible().catch(() => false)) || url.searchParams.has("review"))
    throw new Error(`${label}: Back after closing reopens the review sheet`);
  if (!url.pathname.endsWith("/usage"))
    throw new Error(
      `${label}: Back after closing lands on ${url.pathname}, not where the reader was`,
    );
}

async function verifyOverviewCalm(page, label, language, capture) {
  const pattern = "**/v1/attention*";
  const calm = (route) => route.fulfill({ json: attentionAnswer({ items: [], failed: [] }) });
  await page.route(pattern, calm);
  try {
    await stand.visit(page, "");
    const list = page.locator('[data-testid="attention"][data-family-state="empty"]');
    await list.waitFor({ state: "visible" });
    const shape = await page.evaluate(() => ({
      badge: document.querySelectorAll('[data-testid="nav-overview-count"]').length,
      text: document.querySelector('[data-testid="attention"]')?.innerText ?? "",
      summary: document.querySelector('[data-testid="overview-summary"]')?.innerText ?? "",
    }));
    if (shape.badge) throw new Error(`${label}: a badge although nothing is open`);
    await assertOperationsBar(page, label);
    if (
      !shape.text.includes(language === "de" ? "Nichts braucht dich gerade" : "Nothing needs you")
    )
      throw new Error(`${label}: the calm state reads "${shape.text}"`);
    if (!/^0\b/.test(shape.summary.trim()))
      throw new Error(`${label}: the summary does not count zero ("${shape.summary}")`);
    await capture();
  } finally {
    await page.unroute(pattern, calm);
  }
}

async function assertUnhealthyConnectorsOnly(page, label) {
  if (!(await page.locator('[data-testid="catalog-health-filter"]').isVisible()))
    throw new Error(`${label}: the health narrowing is not shown as a removable chip`);
  const rows = await page.locator('[data-testid="catalog-connectors"] tbody').innerText();
  for (const shown of ["Mailer", "Legacy CRM"])
    if (!rows.includes(shown)) throw new Error(`${label}: ${shown} is unhealthy and missing`);
  for (const hidden of ["Reporting API", "Warehouse"])
    if (rows.includes(hidden)) throw new Error(`${label}: ${hidden} is listed but not unhealthy`);
}

async function assertNotificationRules(page, label) {
  const machineValues = (index) =>
    page
      .locator(`[data-testid="notifications-rule-${index}"] [data-machine-value="true"]`)
      .allInnerTexts();
  if ((await machineValues(0)).length !== 0)
    throw new Error(`${label}: the seeded rule prints an event as the engine's value`);
  const hostile = (await machineValues(2)).join(" | ");
  if (
    hostile !==
    "vendor.custom_integration.quarterly_reconciliation_completed_with_warnings | billing-*"
  )
    throw new Error(`${label}: the hostile rule marks ${hostile}, not its one unknown event`);
  const clipped = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="notifications-rules"]');
    if (!card) return ["the rules card is missing"];
    const edge = card.getBoundingClientRect().right;
    return [...card.querySelectorAll('[data-testid^="notifications-rule-"]')]
      .filter((rule) => rule.getBoundingClientRect().right > edge + 1)
      .map((rule) => rule.getAttribute("data-testid"));
  });
  if (clipped.length > 0)
    throw new Error(`${label}: rules wider than their card: ${clipped.join(", ")}`);
  const openRow = async (table, index, sheet) => {
    await page
      .locator(
        `[data-testid="${table}-row-link-${index}"], [data-testid="${table}-mobile-row-link-${index}"]`,
      )
      .filter({ visible: true })
      .first()
      .click();
    await page.getByTestId(sheet).waitFor({ state: "visible" });
  };
  const closeSheet = async (sheet) => {
    await page.getByTestId(sheet).locator('[data-slot="sheet-close"]').click();
    await page.getByTestId(sheet).waitFor({ state: "detached" });
  };
  await openRow("notifications-rules-table", 1, "notifications-rule-sheet");
  const ruleSheet = page.getByTestId("notifications-rule-sheet");
  await ruleSheet.getByTestId("action-menu").click();
  if (!(await page.getByTestId("notifications-rule-delete").isEnabled()))
    throw new Error(`${label}: a rule's sheet offers no way to delete it`);
  if (!(await page.getByTestId("notifications-rule-toggle").isVisible()))
    throw new Error(`${label}: a rule's sheet offers no way to pause it`);
  await page.keyboard.press("Escape");
  await page.getByTestId("notifications-rule-edit").click();
  const ruleDialog = page.getByTestId("notifications-rule-dialog");
  await ruleDialog.waitFor({ state: "visible" });
  if (!(await page.getByTestId("notifications-rule-name").inputValue()).trim())
    throw new Error(`${label}: editing a rule does not start from its name`);
  await page.getByTestId("notifications-rule-dialog-cancel").click();
  await ruleDialog.waitFor({ state: "detached" });
  await closeSheet("notifications-rule-sheet");
  await openRow("notifications-channels-table", 1, "notifications-channel-sheet");
  if (!(await page.getByTestId("notifications-channel-delete").isDisabled()))
    throw new Error(`${label}: a channel two rules deliver to can be removed`);
  await closeSheet("notifications-channel-sheet");
  await openRow("notifications-channels-table", 2, "notifications-channel-sheet");
  if (!(await page.getByTestId("notifications-channel-delete").isEnabled()))
    throw new Error(`${label}: an unused channel cannot be removed`);
  await closeSheet("notifications-channel-sheet");
}

const ENDLESS_LISTS = {
  workflows: { path: "/v1/workflows", firstPage: 25, paging: "offset" },
  audit: { path: "/v1/audit-log", firstPage: 50, paging: "cursor" },
};

async function assertEndlessList(page, label, route) {
  const list = ENDLESS_LISTS[route];
  const desktop = await page.locator('[data-testid="data-table-desktop"]').isVisible();
  const row = (index) =>
    page.locator(`[data-testid="data-table-${desktop ? "row" : "mobile-row"}-${index}"]`);
  await row(0).waitFor();
  if ((await row(list.firstPage).count()) > 0) {
    const filled = await page.evaluate((mobile) => {
      const scope = document.querySelector(
        `[data-testid="data-table-${mobile ? "mobile" : "desktop"}"]`,
      );
      for (let box = scope; box; box = box.parentElement)
        if (
          /auto|scroll/.test(getComputedStyle(box).overflowY) &&
          box.scrollHeight > box.clientHeight
        )
          return true;
      return document.documentElement.scrollHeight > window.innerHeight;
    }, !desktop);
    if (!filled)
      throw new Error(
        `${label}: row ${list.firstPage + 1} loaded before scrolling, yet the list still does not fill the screen`,
      );
    return;
  }
  const followUps = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname !== list.path) return;
    const follows =
      list.paging === "offset"
        ? url.searchParams.get("offset") === String(list.firstPage)
        : Boolean(url.searchParams.get("cursor"));
    if (follows) followUps.push(url.search);
  };
  page.on("request", onRequest);
  try {
    for (let attempt = 0; attempt < 20 && (await row(list.firstPage).count()) === 0; attempt += 1) {
      await page.evaluate((mobile) => {
        const scope = document.querySelector(
          `[data-testid="data-table-${mobile ? "mobile" : "desktop"}"]`,
        );
        for (let box = scope; box; box = box.parentElement)
          if (/auto|scroll/.test(getComputedStyle(box).overflowY)) box.scrollTop = box.scrollHeight;
        window.scrollTo(0, document.documentElement.scrollHeight);
      }, !desktop);
      await page.waitForTimeout(150);
    }
  } finally {
    page.off("request", onRequest);
  }
  if (followUps.length === 0)
    throw new Error(`${label}: scrolling to the end asked the engine for no next page`);
  if ((await row(list.firstPage).count()) === 0)
    throw new Error(
      `${label}: row ${list.firstPage + 1} never appeared after scrolling to the end`,
    );
}

async function assertAuditActionChip(page, label) {
  if (!(await page.locator('[data-testid="audit-action-filter"]').isVisible()))
    throw new Error(`${label}: the verbs the link narrowed to are not shown as a chip`);
}

async function assertRunDetail(page, label, language) {
  const facts = page.locator('[data-testid="run-detail-summary"]');
  if (!(await facts.isVisible()))
    throw new Error(`${label} opened no run sheet — the address rendered the bare list`);
  const titleLink = page.locator('[data-testid="run-detail-workflow-link"]');
  await titleLink.waitFor();
  const titleHref = await titleLink.getAttribute("href");
  if (titleHref !== `/cockpit/workflows/${runWorkflowId}`)
    throw new Error(`${label} run title leads to ${titleHref}, not to its workflow`);
  const outcome = page.locator('[data-testid="run-detail-outcome"]');
  await outcome.waitFor();
  const sentence = (await outcome.innerText()).trim();
  const expected =
    language === "de"
      ? "Abgebrochen bei Schritt „write_products“ – Ursache: Anmeldung abgelehnt. Zuvor abgeschlossen: 2 von 3 Schritten."
      : "Stopped at step “write_products” — cause: Sign-in rejected. Completed before that: 2 of 3 steps.";
  if (sentence !== expected)
    throw new Error(`${label} states the outcome as ${JSON.stringify(sentence)}`);
  const failure = page.locator('[data-testid="run-detail-error"]');
  if (!(await failure.isVisible()))
    throw new Error(`${label} hides the error of a run whose last step failed`);
  const errorCount = await page
    .locator('[data-testid="run-detail"]')
    .evaluate(
      (sheet, needle) =>
        [...sheet.querySelectorAll("pre")].filter((node) =>
          (node.textContent ?? "").includes(needle),
        ).length,
      "outside the folder boundary its step declares",
    );
  if (errorCount !== 1)
    throw new Error(`${label} shows the run's error ${errorCount} times, not once`);
  const remedy = page.locator('[data-testid="run-detail-cause-remedy"]');
  await remedy.waitFor();
  const remedyHref = await remedy.getAttribute("href");
  if (remedyHref !== `/cockpit/connectors/${runConnectorId}`)
    throw new Error(`${label} remedy leads to ${remedyHref}, not to the connector to sign in to`);
  const remedyText = (await remedy.innerText()).trim();
  if (remedyText !== (language === "de" ? "Neu anmelden" : "Sign in again"))
    throw new Error(`${label} remedy reads ${JSON.stringify(remedyText)}`);
  const audit = await page.locator('[data-testid="run-detail-audit"]').getAttribute("href");
  if (!audit?.startsWith("/cockpit/audit?resource_type=execution&resource_id="))
    throw new Error(`${label} offers no way into the audit trail (${audit})`);
  const toggle = page.locator('[data-testid="run-detail-payload-toggle"]');
  await toggle.waitFor();
  if (await page.locator('[data-testid="run-detail-result"]').isVisible())
    throw new Error(`${label} opens the payload drawer by itself`);
  const toggleText = (await toggle.innerText()).trim();
  if (toggleText === (language === "de" ? "Ergebnis" : "Result"))
    throw new Error(`${label} labels an earlier step's output as the failed run's result`);
  await toggle.click();
  const result = page.locator('[data-testid="run-detail-result"]');
  await result.waitFor();
  const shown = (await result.innerText()).trim();
  const body = shown.split("\n").slice(1).join("\n").trim();
  if (body === "null" || body === "undefined")
    throw new Error(
      `${label} prints '${body}' as the run's result — a step that produced nothing has no result section`,
    );
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  const openStep = async (index) => {
    await page
      .locator(
        wide
          ? `[data-testid="run-detail-step-list-row-${index}"] td >> nth=1`
          : `[data-testid="run-detail-step-list-mobile-row-${index}"]`,
      )
      .click();
    await page.getByTestId("run-step-identities").waitFor();
  };
  await openStep(0);
  const identity = await page.getByTestId("run-step-identities").innerText();
  if (
    !identity.includes("report-reader-fixture") ||
    !identity.includes("https://identity.example.test")
  )
    throw new Error(`${label}: the dispatched credential identity is missing from its step`);
  await page.getByTestId("run-step-close").click();
  await page.getByTestId("run-step-sheet").waitFor({ state: "hidden" });
  await openStep(1);
  const undocumented = await page.getByTestId("run-step-identities").innerText();
  if (
    !undocumented.includes(language === "de" ? "nicht dokumentiert" : "not documented") ||
    undocumented.includes("report-reader-fixture")
  )
    throw new Error(
      `${label}: a step without a credential snapshot inherits another step's identity`,
    );
  await page.getByTestId("run-step-close").click();
  await page.getByTestId("run-step-sheet").waitFor({ state: "hidden" });
  const rerunOf = new URL(page.url()).searchParams.get("run");
  let reruns = 0;
  const countRerun = (request) => {
    if (request.method() === "POST" && request.url().includes("/rerun")) reruns += 1;
  };
  page.on("request", countRerun);
  try {
    await page.locator('[data-testid="run-rerun-open"]').click();
    for (let attempt = 0; attempt < 40 && reruns === 0; attempt += 1) await page.waitForTimeout(50);
    if (await page.getByRole("alertdialog").count())
      throw new Error(`${label} asks again before running again; the dummy starts the run`);
  } finally {
    page.off("request", countRerun);
  }
  if (reruns !== 1) throw new Error(`${label} one click on rerun sent ${reruns} runs`);
  await page
    .waitForURL((url) => url.searchParams.get("run") !== rerunOf, { timeout: 2_000 })
    .catch(() => undefined);
  if (new URL(page.url()).searchParams.get("run") !== rerunOf) {
    await page.goBack();
    await page.waitForURL((url) => url.searchParams.get("run") === rerunOf);
  }
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await result.waitFor({ state: "hidden" });
}

async function assertWorkflowDetail(page, label, language) {
  if (await page.locator('[data-testid="workflow-health-badge"]').count())
    throw new Error(`${label}: a badge beside the title repeats the strip`);
  const strip = page.locator('[data-testid="workflow-automation"]');
  await strip.waitFor();
  await page.locator('[data-testid="workflow-automation-state"]').waitFor();
  const stripActions = await strip
    .locator(
      '[data-testid="workflow-automation-action"], [data-testid="workflow-automation-recheck"], [data-testid="workflow-automation-failed-retry"]',
    )
    .count();
  if (stripActions > 1)
    throw new Error(`${label}: the status strip offers ${stripActions} actions, not one`);
  const stripText = await strip.innerText();
  if (stripText.includes("consecutive"))
    throw new Error(`${label}: the strip passes the engine's wording off as its own`);
  const failing = (await strip.getAttribute("data-strip")) === "failing";
  if (failing) {
    const expected = language === "de" ? "Ursache: Anmeldung abgelehnt" : "cause: Sign-in rejected";
    if (!stripText.includes(expected))
      throw new Error(`${label} states the workflow's cause as ${JSON.stringify(stripText)}`);
    if (!(await page.locator('[data-testid="workflow-automation-action"]').isVisible()))
      throw new Error(`${label} shows red with no way to the cause`);
  }
  const tabs = await page
    .locator('[data-testid="workflow-tabs-list"] [role="tab"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  const expectedTabs = ["use", "history", "structure", "approvals"].map(
    (tab) => `workflow-tabs-tab-${tab}`,
  );
  if (JSON.stringify(tabs) !== JSON.stringify(expectedTabs))
    throw new Error(`${label}: the tabs are ${JSON.stringify(tabs)}`);
  if (!(await page.locator('[data-testid="workflow-invocation"]').isVisible()))
    throw new Error(`${label}: "Verwenden" does not open on the call`);
  if (await page.locator('[data-testid="workflow-io"]').isVisible())
    throw new Error(`${label}: input and output stand open instead of folded`);
  if (
    await page
      .locator(
        '[data-testid="workflow-tab-dag"], [data-family-slot="detail-context"], [data-testid="agent-panel"]',
      )
      .count()
  )
    throw new Error(`${label} still carries the old tabs, the governance row or the agent panel`);
  const opened = async (tab, marker) => {
    await page.locator(`[data-testid="workflow-tabs-tab-${tab}"]`).click();
    await page.locator(marker).filter({ visible: true }).first().waitFor({ state: "visible" });
    if (new URL(page.url()).searchParams.get("tab") !== tab)
      throw new Error(`${label}: the tab "${tab}" is not in the address`);
  };
  await opened(
    "history",
    '[data-testid="workflow-runs-row-0"], [data-testid="workflow-runs-mobile-row-0"]',
  );
  let runLink = page.locator('[data-testid="workflow-runs-row-link-0"]');
  if (!(await runLink.isVisible().catch(() => false)))
    runLink = page.locator('[data-testid="workflow-runs-mobile-row-link-0"]');
  const runHref = await runLink.getAttribute("href");
  if (!runHref?.startsWith(`/cockpit/workflows/${uuid}?`) || !runHref.includes("run="))
    throw new Error(`${label}: a run leads to ${runHref}, not to its sheet on this page`);
  await opened("structure", '[data-testid="workflow-steps"]');
  if (!(await page.locator('[data-testid="workflow-technical"]').isVisible()))
    throw new Error(`${label}: "Technische Angaben" is missing from "Aufbau"`);
  await opened("approvals", '[data-testid="workflow-approvals-summary"]');
  if (await page.locator('[data-testid="authority-headline"]').count())
    throw new Error(`${label} shows an earlier approval before anyone asked for it`);
  const history = page.locator('[data-testid="workflow-former-grants-toggle"]');
  await history.click();
  let first = page.locator('[data-testid="workflow-former-approvals-row-link-0"]');
  if (!(await first.isVisible().catch(() => false)))
    first = page.locator('[data-testid="workflow-former-approvals-mobile-row-link-0"]');
  await first.click();
  const headline = page.locator('[data-testid="authority-headline"]');
  await headline.waitFor();
  const headlineText = await headline.innerText();
  for (const expectedPart of language === "de"
    ? ["Produktion", "gültig bis", "bis zu 24 Läufe"]
    : ["Production", "valid until", "up to 24 runs"])
    if (!headlineText.includes(expectedPart))
      throw new Error(
        `${label} authority headline ${JSON.stringify(headlineText)} lacks ${expectedPart}`,
      );
  const headlineTitle = await headline.locator("[title]").first().getAttribute("title");
  if (headlineTitle !== hostileAuthority.id)
    throw new Error(`${label} authority id is not kept on the headline's title`);
  await page.locator('[data-testid="authority-sheet-close"]').click();
  await page.locator('[data-testid="authority-sheet"]').waitFor({ state: "hidden" });
  await page.locator('[data-testid="workflow-tabs-tab-use"]').click();
  await page.locator('[data-testid="workflow-invocation"]').waitFor({ state: "visible" });
}

async function assertChat(page, label) {
  await assertChatLayout(page, label, { openList: true });
  const layout = await page.evaluate(() => {
    const rect = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`${testId} missing`);
      return element.getBoundingClientRect().toJSON();
    };
    const scrollbar = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`${selector} missing`);
      const style = getComputedStyle(element);
      return { gutter: style.scrollbarGutter, width: style.scrollbarWidth };
    };
    return {
      transcript: rect("chat-transcript"),
      composerArea: rect("chat-composer-area"),
      composer: rect("chat-composer"),
      composerSubmit: rect("chat-composer-submit"),
      main: rect("chat-main"),
      headerColumn: document
        .querySelector('[data-testid="chat-header-column"] > div')
        ?.getBoundingClientRect()
        .toJSON(),
      tools: rect("chat-composer-tools"),
      attach: rect("chat-attach"),
      transcriptColumn: document
        .querySelector('[data-slot="message-scroller-content"]')
        ?.getBoundingClientRect()
        .toJSON(),
      scrollbars: {
        header: scrollbar('[data-testid="chat-header-column"]'),
        transcript: scrollbar('[data-slot="message-scroller-viewport"]'),
        composer: scrollbar('[data-testid="chat-composer-area"]'),
      },
      inputStyle: (() => {
        const input = document.querySelector('[data-testid="chat-composer-input"]');
        if (!(input instanceof HTMLElement)) throw new Error("chat-composer-input missing");
        const style = getComputedStyle(input);
        return {
          paddingLeft: Number.parseFloat(style.paddingLeft),
          paddingTop: Number.parseFloat(style.paddingTop),
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      })(),
    };
  });
  if (layout.transcript.height < 120) throw new Error(`${label} transcript collapsed`);
  if (layout.transcript.bottom > layout.composerArea.top + 1)
    throw new Error(`${label} transcript overlaps composer`);
  if (layout.composerArea.bottom > layout.main.bottom + 1)
    throw new Error(`${label} composer is outside Chat`);
  if (layout.transcript.width < layout.main.width - 4)
    throw new Error(`${label} transcript does not span the conversation column`);
  if (layout.tools.top < layout.composer.top + 40)
    throw new Error(`${label} the composer's toolbar does not stand under its field`);
  if (
    Math.abs(layout.composerSubmit.width - 32) > 1 ||
    Math.abs(layout.composerSubmit.height - 32) > 1
  )
    throw new Error(`${label} composer submit control is not 32px square`);
  const submitRightInset = layout.composer.right - layout.composerSubmit.right;
  const submitBottomInset = layout.composer.bottom - layout.composerSubmit.bottom;
  if (Math.abs(submitRightInset - 8) > 1 || Math.abs(submitBottomInset - 8) > 1)
    throw new Error(`${label} composer submit control is not inset by 8px`);
  if (Math.abs(layout.attach.left - layout.composer.left - 8) > 1)
    throw new Error(`${label} the attach control does not open the toolbar on the left`);
  if (
    Math.abs(layout.inputStyle.paddingLeft - 8) > 1 ||
    Math.abs(layout.inputStyle.lineHeight - 24) > 1
  )
    throw new Error(`${label} composer input spacing is not 8px with 24px leading`);
  if (!layout.headerColumn || !layout.transcriptColumn)
    throw new Error(`${label} shared chat columns are missing`);
  for (const [area, scrollbar] of Object.entries(layout.scrollbars)) {
    if (scrollbar.gutter !== "stable both-edges" || scrollbar.width !== "thin")
      throw new Error(`${label} ${area} scrollbar style is ${JSON.stringify(scrollbar)}`);
  }
  for (const column of [layout.headerColumn, layout.transcriptColumn]) {
    if (
      Math.abs(column.left - layout.composer.left) > 2 ||
      Math.abs(column.right - layout.composer.right) > 2
    )
      throw new Error(
        `${label} header, transcript, and composer columns do not align: ` +
          `header=${layout.headerColumn.left}/${layout.headerColumn.right}, ` +
          `transcript=${layout.transcriptColumn.left}/${layout.transcriptColumn.right}, ` +
          `composer=${layout.composer.left}/${layout.composer.right}`,
      );
  }
  const composerInput = page.locator('[data-testid="chat-composer-input"]');
  const oneLine = (await page.locator('[data-testid="chat-composer"]').boundingBox())?.height ?? 0;
  await composerInput.fill("first line\nsecond line\nthird line\nfourth line");
  const multiline = await page.evaluate(() => {
    const rect = (testId) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLElement)) throw new Error(`${testId} missing`);
      return element.getBoundingClientRect().toJSON();
    };
    return { composer: rect("chat-composer"), submit: rect("chat-composer-submit") };
  });
  if (multiline.composer.height <= oneLine)
    throw new Error(`${label} multiline composer did not grow`);
  if (Math.abs(multiline.composer.bottom - multiline.submit.bottom - 8) > 1)
    throw new Error(`${label} multiline submit control is not bottom-aligned`);
  await composerInput.fill("");
  await page.locator('[data-testid="chat-attach-input"]').setInputFiles({
    name: "notizen.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Notizen\n\nZwei Punkte für den Wochenbericht."),
  });
  const chip = page.locator('[data-testid="chat-attachment-0"]');
  await chip.waitFor({ state: "visible" });
  const chipBox = await chip.boundingBox();
  const fieldBox = await composerInput.boundingBox();
  if (!chipBox || !fieldBox || chipBox.y >= fieldBox.y)
    throw new Error(`${label} the attached file does not stand above the field`);
  await page.locator('[data-testid="chat-attachment-0-open"]').click();
  const preview = page.locator('[data-testid="chat-attachment-preview-body"]');
  await preview.waitFor({ state: "visible" });
  await preview
    .getByText("Zwei Punkte")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => {
      throw new Error(`${label} the attachment preview does not show the file`);
    });
  await page.locator('[data-testid="chat-attachment-preview-close"]').click();
  await preview.waitFor({ state: "hidden" });
  await page.locator('[data-testid="chat-attachment-0-remove"]').click();
  await chip.waitFor({ state: "detached" });
  const assistantMetadata = await page
    .locator('[data-testid="chat-message-1-metadata"]')
    .textContent();
  if (!assistantMetadata.includes("provider/model-v1"))
    throw new Error(`${label} assistant metadata is ${JSON.stringify(assistantMetadata)}`);
  const identifiers = await page.evaluate(() => {
    const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    const messages = [...document.querySelectorAll('[data-cockpit-ui="chat-message"]')];
    const inCode = messages.some((message) =>
      [...message.querySelectorAll("pre, code")].some((element) =>
        (element.textContent ?? "").includes(ID),
      ),
    );
    const inProse = messages.some((message) => {
      const clone = message.cloneNode(true);
      for (const element of [...clone.querySelectorAll("pre, code")]) element.remove();
      return (clone.textContent ?? "").includes(ID);
    });
    return { inCode, inProse };
  });
  if (!identifiers.inCode) throw new Error(`${label} rewrote an identifier inside a payload`);
  if (identifiers.inProse) throw new Error(`${label} prints an identifier in prose`);
  await openConversationList(page);
  const listText = await page.locator('[data-testid="conversation-item-0"]').innerText();
  if (listText.includes('{"tool"')) throw new Error(`${label} exposes a raw tool payload`);
  await closeConversationList(page);
  const assistantWidths = await page
    .locator('[data-testid^="chat-message-"][data-testid$="-content"]')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  if (assistantWidths.some((width) => width > layout.main.width - 24))
    throw new Error(`${label} message content reaches outside its readable column`);
}

async function openConversationList(page) {
  const list = page.locator('[data-testid="conversation-list"]');
  if (!(await list.isVisible())) {
    await page.locator('[data-testid="conversation-list-trigger"]').click();
    await list.waitFor({ state: "visible" });
  }
}

async function closeConversationList(page) {
  const trigger = page.locator('[data-testid="conversation-list-trigger"]');
  if (!(await trigger.isVisible())) return;
  if ((await trigger.getAttribute("aria-expanded")) !== "true") return;
  await trigger.click();
  await page.locator('[data-testid="conversation-list"]').waitFor({ state: "hidden" });
}

async function assertHeadingAlignment(page, label, route = null, wide = false) {
  const view = route === null ? null : patternMigratedView(route);
  if (view !== null) await assertPatternLayout(page, label, view, wide);
  const measured = await page.evaluate(() => {
    const heading = document.querySelector('[data-testid="page-content"] h1');
    if (!heading) return null;
    const trigger = heading.parentElement?.querySelector('[data-testid="sidebar-trigger"]');
    const lead = trigger instanceof HTMLElement ? trigger : heading;
    const scope = '[data-testid="page-content"]';
    const body = document.querySelector(
      [
        '[data-testid$="-context"]',
        "article",
        '[data-slot="card"]',
        '[data-slot="table-container"]',
        "section",
        "p",
      ]
        .map((selector) => `${scope} ${selector}`)
        .join(", "),
    );
    const h = heading.getBoundingClientRect();
    const gap =
      trigger instanceof HTMLElement
        ? Math.round(h.left - trigger.getBoundingClientRect().right)
        : null;
    if (!body) return { offset: null, gap };
    const a = lead.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    if (b.width === 0 || b.top < h.bottom) return { offset: null, gap };
    return { offset: Math.round(b.left - a.left), gap };
  });
  if (measured === null) return;
  if (measured.gap !== null && (measured.gap < 0 || measured.gap > 16))
    throw new Error(`${label} sets its heading ${measured.gap}px away from the sidebar toggle`);
  if (measured.offset !== null && Math.abs(measured.offset) > 2) {
    throw new Error(`${label} indents its content ${measured.offset}px against its own title row`);
  }
}

const SHEET_WIDTHS = { default: 576, wide: 1024 };

async function assertPatternLayout(page, label, view, wide) {
  const sheet = isSheetView(view);
  const shape = await page.evaluate(
    ({ sheet, widths }) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const clean = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const content = document.querySelector('[data-testid="page-content"]');
      const sheets = [...document.querySelectorAll("[data-sheet-size]")]
        .filter(visible)
        .map((element) => ({
          size: element.getAttribute("data-sheet-size"),
          width: Math.round(element.getBoundingClientRect().width),
          cap: widths[element.getAttribute("data-sheet-size") ?? ""] ?? null,
        }));
      if (sheet) return { sheets, sheetOnly: true };
      const inPage = (selector) =>
        content
          ? [...content.querySelectorAll(selector)].filter(
              (element) => visible(element) && !element.closest('[role="dialog"]'),
            )
          : [];
      const h1s = inPage("h1");
      const h1 = h1s[0];
      const title = clean(h1?.textContent);
      const tab = inPage(
        '[role="tab"][aria-selected="true"], [data-slot="page-tabs"] [aria-current="page"]',
      )[0];
      const tabLabel = clean(tab?.textContent);
      const repeats = inPage('h2, h3, h4, h5, h6, [data-slot="page-back"]')
        .map((element) => clean(element.textContent))
        .filter((text) => text && (text === title || (tabLabel && text === tabLabel)));
      const edges = [
        '[data-slot="page-back"]',
        '[data-testid="page-title-row"]',
        '[data-slot="status-strip"]',
        '[role="tablist"], [data-slot="page-tabs"]',
        '[data-slot="summary-line"]',
        '[data-slot="table-container"]',
      ]
        .map((selector) => [selector, inPage(selector)[0]])
        .filter(([, element]) => element)
        .map(([selector, element]) => [selector, Math.round(element.getBoundingClientRect().left)]);
      const actions = inPage('[data-slot="page-actions"]')[0];
      const centre = (element) => {
        const box = element.getBoundingClientRect();
        return box.top + box.height / 2;
      };
      const filled = [
        ...document.querySelectorAll('button[data-variant="default"], a[data-variant="default"]'),
      ].filter(
        (element) =>
          visible(element) &&
          !element.closest('[role="dialog"], [role="alertdialog"], [data-sheet-size]'),
      );
      return {
        sheetOnly: false,
        sheets,
        h1Count: h1s.length,
        repeats,
        edges,
        actionOffset:
          h1 && actions && actions.children.length > 0
            ? Math.round(centre(actions) - centre(h1))
            : null,
        filled: filled.map(
          (element) => clean(element.textContent) || element.getAttribute("data-testid"),
        ),
      };
    },
    { sheet, widths: SHEET_WIDTHS },
  );
  for (const open of shape.sheets) {
    if (open.cap === null)
      throw new Error(
        `${label}: a sheet has the size "${open.size}" — only default and wide exist`,
      );
    if (open.width > open.cap + 1)
      throw new Error(
        `${label}: a ${open.size} sheet is ${open.width}px wide, not at most ${open.cap}px`,
      );
  }
  if (sheet && shape.sheets.length !== 1)
    throw new Error(`${label}: ${shape.sheets.length} run sheets are open, not one`);
  if (shape.sheetOnly) return;
  if (shape.h1Count !== 1)
    throw new Error(`${label}: ${shape.h1Count} h1 elements on the page, not exactly one`);
  if (shape.repeats.length > 0)
    throw new Error(
      `${label}: a heading repeats the title or the open tab — ${JSON.stringify(shape.repeats)}`,
    );
  const lefts = shape.edges.map(([, left]) => left);
  if (lefts.length > 1 && Math.max(...lefts) - Math.min(...lefts) > 2)
    throw new Error(
      `${label}: the page's blocks start at different x — ${JSON.stringify(shape.edges)}`,
    );
  if (wide && shape.actionOffset !== null && Math.abs(shape.actionOffset) > 2)
    throw new Error(
      `${label}: the page actions sit ${shape.actionOffset}px off the title's centre`,
    );
  if (shape.filled.length > 1)
    throw new Error(
      `${label}: ${shape.filled.length} filled buttons — ${JSON.stringify(shape.filled)}`,
    );
}

async function assertTables(page, label) {
  const unsafeOverflows = await page
    .locator('[data-slot="table-container"]')
    .evaluateAll((elements) =>
      elements
        .map((element, index) => ({
          index,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: window.getComputedStyle(element).overflowX,
        }))
        .filter(
          (entry) =>
            entry.scrollWidth > entry.clientWidth + 1 &&
            entry.overflowX !== "auto" &&
            entry.overflowX !== "scroll",
        ),
    );
  if (unsafeOverflows.length) throw new Error(`${label} has uncontained table overflow`);
}

async function assertAuthProviderSettings(page, label) {
  const cards = page.locator('[data-testid^="settings-auth-provider-"]').filter({
    has: page.locator('input[data-testid$="-label"]'),
  });
  if ((await cards.count()) !== 2) {
    throw new Error(`${label} does not render both configured authentication provider cards`);
  }
  const callback = await page.locator('[data-testid="settings-auth-providers"] code').innerText();
  if (callback !== "https://subkit.example.com/v1/identity/login/callback") {
    throw new Error(`${label} renders the wrong OIDC callback URL: ${callback}`);
  }
  for (const testId of [
    "settings-auth-provider-1-issuer-url",
    "settings-auth-provider-1-client-id",
    "settings-auth-provider-1-scopes",
    "settings-auth-provider-1-tenant-slug",
  ]) {
    if ((await page.locator(`[data-testid="${testId}"]`).count()) !== 1) {
      throw new Error(`${label} misses ${testId}`);
    }
  }
  if ((await page.locator('[data-testid*="client-secret"]').count()) !== 0) {
    throw new Error(`${label} exposes a client-secret control for a public PKCE provider`);
  }
}

async function assertBlankLists(page, label) {
  const hits = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((element) => element.children.length === 0 && element.closest("pre, code") === null)
      .map((element) => (element.textContent ?? "").trim())
      .filter((text) => /,\s*,/.test(text) || /:\s*,/.test(text) || /,\s*$/.test(text)),
  );
  const found = [...new Set(hits)];
  if (found.length)
    throw new Error(
      `${label} renders a list of blank values: ${found.map((t) => `"${t.slice(0, 90)}"`).join(", ")}`,
    );
}

async function assertInteractiveSelectors(page, label) {
  const missing = await page
    .locator('button, input, textarea, a[href], [role="menuitem"], [role="menuitemradio"]')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
        if (!visible || element.hasAttribute("data-testid")) return [];
        if (element.closest('[data-slot="copy-field"][data-testid]')) return [];
        return [
          `${element.tagName.toLowerCase()}[${element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 32) || "unlabelled"}] ${element.outerHTML.slice(0, 180)}`,
        ];
      }),
    );
  if (missing.length) throw new Error(`${label} has interactives without data-testid: ${missing}`);
}

let framesWritten = 0;
const written = new Map();

let outputReady = false;
async function prepareOutput() {
  if (outputReady) return;
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  outputReady = true;
}

const writtenPaths = new Map();

function claimFrame(path, label) {
  const earlier = writtenPaths.get(path);
  if (earlier !== undefined)
    throw new Error(
      `Frame "${label}" would overwrite "${earlier}" at ${path}. Two photographs under one name leave one file and two counts, and the end-of-run tally can only say the numbers disagree.`,
    );
  writtenPaths.set(path, label);
}

async function shoot(page, label, options) {
  await prepareOutput();
  const path = resolve(outputDir, stand.frameName(page, label));
  claimFrame(path, label);
  await page.screenshot({ animations: "disabled", ...options, path });
  framesWritten += 1;
  written.set(label, path);
}

async function shootSheet(page, label, options) {
  await prepareOutput();
  const path = resolve(outputDir, stand.sheetName(label));
  claimFrame(path, label);
  await page.screenshot({ animations: "disabled", ...options, path });
  framesWritten += 1;
  written.set(label, path);
}

const stand = standAt({
  baseUrl,
  refuse: (sentence, options) => new Error(`Cockpit visual sweep NOT TAKEN — ${sentence}`, options),
  hint: process.env.COCKPIT_BASE_URL
    ? "COCKPIT_BASE_URL names this port; build the cockpit and run a preview on it, or unset it and let the sweep serve its own build."
    : "The sweep started this preview itself over assets/cockpit — a foreign answer here means the port was taken between the probe and the bind.",
});

assertAuditFixtureActionsAreReal();

let browser;
let sweepFailed = false;
let sweepFailure;
try {
  browser = await chromium.launch({ headless: true });
  const errors = [];
  const locales = [
    { name: "de", browser: "de-DE" },
    { name: "en", browser: "en-US" },
  ];
  const variants = locales
    .flatMap((locale) =>
      ["light", "dark"].map((theme) => ({
        ...locale,
        theme,
        artifact: `${locale.name}-${theme}`,
      })),
    )
    .filter((variant) => sweepList("COCKPIT_SWEEP_VARIANTS")?.includes(variant.artifact) ?? true);
  const viewports = [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "wide", width: 1990, height: 1090 },
    { name: "mobile", width: 390, height: 844 },
  ].filter((viewport) => sweepList("COCKPIT_SWEEP_VIEWPORTS")?.includes(viewport.name) ?? true);

  for (const locale of variants) {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        locale: locale.browser,
      });
      await context.addInitScript(
        ({ language, theme }) => {
          localStorage.setItem("sk-cockpit-locale", language);
          localStorage.setItem("sk-cockpit-theme", theme);
        },
        { language: locale.name, theme: locale.theme },
      );
      await context.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.textContent = "::-webkit-scrollbar{width:15px;height:15px}";
          document.head.append(style);
        });
      });
      const tooltips = await watchUnpromptedTooltips(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => {
        const message = `${locale.artifact}/${viewport.name}: ${error.message}`;
        errors.push(message);
        console.error(message);
      });
      page.on("console", (message) => {
        if (message.type() === "error")
          console.error(`${locale.artifact}/${viewport.name}: ${message.text()}`);
      });
      await page.route("**/v1/**", mockApi);
      const headingLeft = new Map();
      for (const route of sweptRoutes) {
        const artifactRoute = artifactRouteName(route);
        await stand.visit(page, route);
        try {
          await page.locator(markerFor(route)).waitFor({ state: "visible" });
        } catch (error) {
          const body = await page
            .locator("body")
            .innerText()
            .catch(() => "body unavailable");
          throw new Error(
            `${locale.artifact}/${viewport.name}/${route} did not mount: ${body.slice(0, 1000)}`,
            { cause: error },
          );
        }
        await page
          .locator('[data-testid="data-table-retry"]')
          .waitFor({ state: "hidden" })
          .catch(() => {});
        for (const errorSelector of [
          '[data-testid="data-table-retry"]',
          '[data-testid="attention-error"]',
        ]) {
          if (
            await page
              .locator(errorSelector)
              .isVisible()
              .catch(() => false)
          )
            throw new Error(
              `${locale.artifact}/${viewport.name}/${route} displays a resource error`,
            );
        }
        const text = await page.locator("body").innerText();
        await assertNoVisibleUuids(
          page.locator("body"),
          `${locale.artifact}/${viewport.name}/${route}`,
        );
        if ((await page.locator("html").getAttribute("lang")) !== locale.name)
          throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong locale`);
        if (!documentThemeMatches(await page.locator("html").getAttribute("class"), locale.theme))
          throw new Error(`${locale.artifact}/${viewport.name}/${route} uses the wrong theme`);
        await assertViewport(page, `${locale.artifact}/${viewport.name}/${route}`);
        await assertTables(page, `${locale.artifact}/${viewport.name}/${route}`);
        await assertHeadingAlignment(
          page,
          `${locale.artifact}/${viewport.name}/${route}`,
          route,
          viewport.width >= 1024,
        );
        await assertFamilyGeometry(
          page,
          `${locale.artifact}/${viewport.name}/${route}`,
          viewport.width,
        );
        const migrated = patternMigratedView(route);
        if (migrated !== null)
          await assertSingleTriggers(page, `${locale.artifact}/${viewport.name}/${route}`, {
            root: patternViewRoot(migrated),
            ...(migrated === "chat" ? { content: TRANSCRIPT.content } : {}),
          });
        await assertInteractiveSelectors(page, `${locale.artifact}/${viewport.name}/${route}`);
        await assertBlankLists(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (route === "")
          await assertOverviewHostile(
            page,
            `${locale.artifact}/${viewport.name}/overview`,
            locale.name,
          );
        if (route.startsWith("connectors?health="))
          await assertUnhealthyConnectorsOnly(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (route === "usage")
          await assertUsageOrigins(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (route === "settings?tab=notifications")
          await assertNotificationRules(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (route.startsWith("audit?") && route.includes("action="))
          await assertAuditActionChip(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (route === "chat")
          await assertChat(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (
          route === "usage" &&
          (await page.locator('[data-family-kpi-id], [data-testid="operations-bar"]').count()) > 0
        )
          throw new Error(
            `${locale.artifact}/${viewport.name}/usage: the operating figures stand here a second time`,
          );
        if (
          route === "workflows" &&
          ((await page.getByTestId("workflow-health-engine-wording").count()) > 0 ||
            /Wortlaut der Engine|Wording from the engine/.test(text))
        )
          throw new Error(
            `${locale.artifact}/${viewport.name}/workflows: a list row repeats the engine's wording`,
          );
        if (route === "?runs=all")
          await assertOpenOnce(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (/^\?run=.+/.test(route))
          await assertRunDetail(page, `${locale.artifact}/${viewport.name}/${route}`, locale.name);
        if (/^workflows\/.+/.test(route))
          await assertWorkflowDetail(
            page,
            `${locale.artifact}/${viewport.name}/${route}`,
            locale.name,
          );
        if (route === "settings?section=auth")
          await assertAuthProviderSettings(page, `${locale.artifact}/${viewport.name}/${route}`);
        if (route === "access") {
          const landed = new URL(page.url());
          if (
            landed.pathname !== "/cockpit/people" ||
            landed.searchParams.get("section") !== "roles"
          )
            throw new Error(
              `${locale.artifact}/${viewport.name}/access lands on ${landed.pathname}${landed.search}, not the roles of /people`,
            );
          const localizedRoles =
            locale.name === "de"
              ? [
                  ["Metrik-Abruf", "Kann Prometheus-Metriken"],
                  ["Portalnutzer", "Portal-Zugriffstoken"],
                ]
              : [
                  ["Metrics scraper", "Can read Prometheus metrics"],
                  ["Portal token user", "portal access tokens"],
                ];
          for (const [name, description] of localizedRoles) {
            if (!text.includes(name))
              throw new Error(
                `${locale.artifact}/${viewport.name}/${route} misses localized built-in role name: ${name}`,
              );
            const label = locale.name === "de" ? `Rolle öffnen: ${name}` : `Open role: ${name}`;
            await page
              .getByRole("button", { name: label, exact: true })
              .filter({ visible: true })
              .click();
            const sheet = page.getByTestId("role-sheet");
            await sheet.waitFor({ state: "visible" });
            const shown = await sheet.innerText();
            if (!shown.includes(name) || !shown.includes(description))
              throw new Error(
                `${locale.artifact}/${viewport.name}/${route} role sheet misses localized built-in role text: ${name} / ${description}`,
              );
            await page.getByTestId("role-sheet-close").click();
            await sheet.waitFor({ state: "hidden" });
          }
        }
        if (route === "" || route === "workflows" || route === "usage")
          headingLeft.set(
            route,
            await page.evaluate(() =>
              Math.round(
                document.querySelector('[data-testid="page-content"] h1')?.getBoundingClientRect()
                  .left ?? -1,
              ),
            ),
          );
        tooltips.assertNone(`${locale.artifact}/${viewport.name}/${route}`);
        await shoot(page, `${locale.artifact}-${viewport.name}-${artifactRoute}`, {
          fullPage: false,
        });
        if (route === "")
          await assertReviewCloseLeavesNoTrail(
            page,
            `${locale.artifact}/${viewport.name}/overview`,
          );
        if (route in ENDLESS_LISTS)
          await assertEndlessList(page, `${locale.artifact}/${viewport.name}/${route}`, route);
      }
      if (!focused && new Set(headingLeft.values()).size !== 1)
        throw new Error(
          `${locale.artifact}/${viewport.name}: page titles start at different x — ${JSON.stringify(Object.fromEntries(headingLeft))}`,
        );
      if (standOn(verifyOverviewCalm))
        await verifyOverviewCalm(
          page,
          `${locale.artifact}/${viewport.name}/overview-calm`,
          locale.name,
          () =>
            shoot(page, `${locale.artifact}-${viewport.name}-overview-calm`, { fullPage: false }),
        );
      if (viewport.name === "desktop")
        if (standOn(verifyInstallationPages))
          await verifyInstallationPages(
            page,
            stand,
            locale.name,
            (state) =>
              shoot(page, `${locale.artifact}-${viewport.name}-installation-${state}`, {
                fullPage: false,
              }),
            {
              settingsSections: SETTINGS_SECTION_COUNT,
              viewport,
              settingRows: ENGINE_SETTINGS.map((item) => ({
                path: item.path,
                scope: item.meta.scope,
                source: item.meta.source,
                description: item.meta.description ?? null,
              })),
            },
          );
      if (standOn(verifyApiAccess))
        await verifyApiAccess(page, stand, locale.name, {
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
        });
      if (standOn(verifyScheduleHolds))
        await verifyScheduleHolds(page, stand, uuid, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-schedule-held-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyHookHolds))
        await verifyHookHolds(page, stand, uuid, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-hook-held-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyChatApprovals))
        await verifyChatApprovals(page, stand, conversation, locale.name, async (state) => {
          await assertChatLayout(
            page,
            `${locale.artifact}/${viewport.name}/chat-approval-${state}`,
          );
          await shoot(page, `${locale.artifact}-${viewport.name}-chat-approval-${state}`, {
            fullPage: false,
          });
        });
      if (standOn(verifyChatDecidedApproval))
        await verifyChatDecidedApproval(page, stand, conversation, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-chat-approval-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyChatChoices))
        await verifyChatChoices(page, stand, conversation, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-chat-choice-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyChatReplies))
        await verifyChatReplies(page, stand, conversation, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-chat-reply-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyChatHeader))
        await verifyChatHeader(page, stand, conversation, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-chat-header-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyChatStability))
        await verifyChatStability(
          page,
          stand,
          conversation,
          locale.name,
          `${locale.artifact}/${viewport.name}/chat-stability`,
        );
      if (standOn(verifyChatReauth)) await verifyChatReauth(page, stand, conversation);
      if (viewport.name === "desktop")
        if (standOn(verifyLoadFailures))
          await verifyLoadFailures(page, stand, conversation, (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-load-failed-${state}`, {
              fullPage: false,
            }),
          );
      if (standOn(verifyChatOAuth)) await verifyChatOAuth(page, stand, conversation, locale.name);
      if (standOn(verifyChatActivation))
        await verifyChatActivation(page, stand, conversation, locale.name);
      if (standOn(verifyChatActivity))
        await verifyChatActivity(page, stand, conversation, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-chat-activity-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyCatalogEvidence))
        await verifyCatalogEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          { tenantId: uuid },
        );
      if (standOn(verifyDescriptionEvidence))
        await verifyDescriptionEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          { mockApi, recordId: uuid },
        );
      if (standOn(verifyKnowledgeDetailEvidence))
        await verifyKnowledgeDetailEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          { mockApi, recordId: uuid },
        );
      if (standOn(verifyKnowledgeHistoryProposalsEvidence))
        await verifyKnowledgeHistoryProposalsEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          { mockApi, recordId: uuid },
        );
      if (standOn(verifyKnowledgeWriteEvidence))
        await verifyKnowledgeWriteEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          { mockApi, recordId: uuid },
        );
      if (standOn(verifyKnowledgeTotals))
        await verifyKnowledgeTotals(page, stand, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-knowledge-totals-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyIdentityEvidence))
        await verifyIdentityEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          {
            mockApi,
            workflowId: uuid,
            workflowVersionId: "018f4b4a-6d33-7b3a-9c2d-123456789ab8",
            connectorId: runConnectorId,
            secondConnectorId: uuid,
            executionId: uuid,
          },
        );
      if (standOn(verifyConnectorDetail))
        await verifyConnectorDetail(page, stand, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: true }),
        );
      if (standOn(verifyCreateConnector))
        await verifyCreateConnector(page, stand, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
        );
      if (standOn(verifyTemplateLists))
        await verifyTemplateLists(page, stand, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
        );
      if (standOn(verifyFirstClickOpens))
        await verifyFirstClickOpens(page, stand, `${locale.artifact}/${viewport.name}/first-click`);
      if (standOn(verifyManagementEvidence))
        await verifyManagementEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          { mockApi, tenantId: uuid },
        );
      if (standOn(verifyPeopleLoadsPerTab))
        await verifyPeopleLoadsPerTab(
          page,
          stand,
          `${locale.artifact}/${viewport.name}/people-tabs`,
        );
      if (standOn(verifyRunSheet))
        await verifyRunSheet(
          page,
          stand,
          uuid,
          locale.name,
          `${locale.artifact}/${viewport.name}/run-sheet`,
        );
      if (standOn(verifyRunsOverCatalog))
        await verifyRunsOverCatalog(
          page,
          stand,
          `${locale.artifact}/${viewport.name}/runs-over-catalog`,
        );
      if (standOn(verifyRunDialog))
        await verifyRunDialog(page, stand, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
        );
      if (standOn(verifyDetailAction))
        await verifyDetailAction(page, stand, uuid, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
        );
      if (standOn(verifyWorkflowPreview))
        await verifyWorkflowPreview(page, stand, uuid, locale.name);
      if (standOn(verifyWorkflowPage))
        await verifyWorkflowPage(page, stand, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
        );
      if (standOn(verifyWorkflowHistoryEvidence))
        await verifyWorkflowHistoryEvidence(
          page,
          stand,
          locale.name,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-${state}`, { fullPage: false }),
          { mockApi, recordId: uuid },
        );
      if (standOn(verifyEnginePages))
        await verifyEnginePages(
          page,
          { locale: locale.name, scheme: locale.theme },
          `${locale.artifact}/${viewport.name}`,
          (state) =>
            shoot(page, `${locale.artifact}-${viewport.name}-engine-${state}`, { fullPage: false }),
        );
      if (standOn(verifyEdgeStates))
        await verifyEdgeStates(page, stand, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-edge-${state}`, { fullPage: false }),
        );
      if (standOn(verifySessionExpiry)) await verifySessionExpiry(page, stand, uuid, locale.name);
      if (standOn(verifyWorkflowAuthorities))
        await verifyWorkflowAuthorities(page, stand, uuid, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-workflow-authority-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyGrantDialog))
        await verifyGrantDialog(page, stand, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-grant-dialog-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyChatReviewCard))
        await verifyChatReviewCard(page, stand, conversation, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-chat-review-card-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyGateDiagnosis))
        await verifyGateDiagnosis(page, stand, uuid, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-gate-diagnosis-${state}`, {
            fullPage: false,
          }),
        );
      if (standOn(verifyDecisionLifecycle))
        await verifyDecisionLifecycle(page, stand, uuid, locale.name, (state) =>
          shoot(page, `${locale.artifact}-${viewport.name}-decisions-${state}`, {
            fullPage: false,
          }),
        );
      if (viewport.name === "desktop" && !focused) {
        for (const resource of ["workflows", "connectors", "knowledge", "skills"]) {
          await stand.visit(page, `${resource}/${uuid}`);
          await page.locator(`[data-testid="detail-${resource}"]`).waitFor({ state: "visible" });
          await assertViewport(page, `${locale.artifact}/desktop/${resource}-detail`);
          await assertTables(page, `${locale.artifact}/desktop/${resource}-detail`);
          await assertInteractiveSelectors(page, `${locale.artifact}/desktop/${resource}-detail`);
          await assertBlankLists(page, `${locale.artifact}/desktop/${resource}-detail`);
          await shoot(page, `${locale.artifact}-desktop-${resource}-detail`, {
            fullPage: false,
          });
        }
        {
          const where = `${locale.artifact}/desktop/skill-proposal`;
          await stand.visit(page, "skills");
          await page.locator('[data-testid="catalog-skills"]').waitFor({ state: "visible" });
          const listed = await page.locator('[data-testid="catalog-skills"]').innerText();
          for (const advisory of ["capabilities", "Recurring failure"])
            if (listed.includes(advisory))
              throw new Error(`${where}: advisory candidate "${advisory}" listed as a proposal`);
          await page.locator('[data-testid="skills-row-link-0"]').click();
          const sheet = page.locator('[data-testid="skill-proposal"]');
          await sheet.waitFor({ state: "visible" });
          for (const part of ["skill-proposal-preview", "skill-proposal-facts"])
            await sheet.locator(`[data-testid="${part}"]`).waitFor({ state: "visible" });
          for (const verb of ["skill-proposal-accept", "skill-proposal-reject"])
            if ((await sheet.locator(`[data-testid="${verb}"]`).count()) !== 1)
              throw new Error(`${where}: expected exactly one ${verb}`);
          await page.waitForTimeout(300);
          await assertInteractiveSelectors(page, where);
          await shoot(page, `${locale.artifact}-desktop-skill-proposal`, { fullPage: false });
          await sheet.locator('[data-testid="skill-proposal-reject"]').click();
          await page
            .locator('[data-testid="skill-proposal-reject-confirm"]')
            .waitFor({ state: "visible" });
          await shoot(page, `${locale.artifact}-desktop-skill-proposal-reject`, {
            fullPage: false,
          });
          await page.keyboard.press("Escape");
          await page
            .locator('[data-testid="skill-proposal-reject-confirm"]')
            .waitFor({ state: "hidden" });
          await page.keyboard.press("Escape");
          await sheet.waitFor({ state: "hidden" });
        }
        {
          const where = `${locale.artifact}/desktop/workflow-drafting-context`;
          await stand.visit(page, `workflows/${uuid}?tab=structure`);
          const section = page.locator('[data-testid="workflow-drafting-context"]');
          await section.waitFor({ state: "visible" });
          await section.locator('[data-testid="workflow-drafting-context-toggle"]').click();
          const notes = section.locator('[data-testid="workflow-drafting-context-notes"]');
          await notes.waitFor({ state: "visible" });
          const shown = await notes.innerText();
          for (const fact of [
            "workflow-drafting-fact-inputs",
            "workflow-drafting-fact-output",
            "workflow-drafting-fact-connectors",
            "workflow-drafting-fact-steps",
            "workflow-drafting-fact-state",
            "workflow-drafting-fact-failure",
          ])
            if ((await notes.locator(`[data-testid="${fact}"]`).count()) !== 1)
              throw new Error(`${where}: the fact "${fact}" is missing`);
          for (const prose of [
            "what it does",
            "consistently",
            "capabilities",
            "interne Referenz",
            "internal reference",
            "Approving",
          ])
            if (shown.includes(prose)) throw new Error(`${where}: a note still reads "${prose}"`);
          if (shown.includes("Umbenannte Antwortfelder"))
            throw new Error(`${where}: a proposal is listed as drafting context`);
          if (shown.includes(uuid)) throw new Error(`${where}: a note shows a raw identifier`);
          if (
            await section.getByRole("button", { name: /annehmen|adopt|ablehnen|reject/i }).count()
          )
            throw new Error(`${where}: drafting context offers a decision`);
          await notes.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          await assertInteractiveSelectors(page, where);
          await shoot(page, `${locale.artifact}-desktop-workflow-drafting-context`, {
            fullPage: false,
          });
        }
        let expandedCards = 0;
        for (const [review, positions] of [
          [`workflow:${uuid}`, [0, 1]],
          ["skills", [0]],
        ]) {
          await stand.visit(page, `?review=${review}`);
          await page.locator('[data-testid="attention-review-body"]').waitFor({ state: "visible" });
          for (const position of positions) {
            const toggle = page.locator(`[data-testid="review-decision-${position}-toggle"]`);
            if (!(await toggle.count())) continue;
            await toggle.first().scrollIntoViewIfNeeded();
            await toggle.first().click();
            await page
              .locator(`[data-testid="review-decision-${position}-detail"]`)
              .waitFor({ state: "visible", timeout: 10_000 });
            await page.waitForTimeout(300);
            await shoot(
              page,
              `${locale.artifact}-desktop-review-${review.split(":")[0]}-${position}-expanded`,
              { fullPage: false },
            );
            expandedCards += 1;
          }
        }
        if (expandedCards === 0) {
          throw new Error(`${locale.artifact}: no decision card exposed an expand toggle`);
        }

        await stand.visit(page, "audit?scope=decisions");
        await page.locator('[data-testid="resource-audit"]').waitFor({ state: "visible" });
        await page.waitForTimeout(300);
        await shoot(page, `${locale.artifact}-desktop-audit-decisions`, {
          fullPage: false,
        });

        await stand.visit(page, "chat");
        await openConversationList(page);
        await page.locator('[data-testid="conversation-item-0"]').waitFor({ state: "visible" });
        await page.waitForTimeout(300);
        await shoot(page, `${locale.artifact}-desktop-chat-list`, {
          fullPage: false,
        });
        if ((await page.getByTestId("conversation-toggle-hidden").count()) !== 0)
          throw new Error(`${locale.artifact}: an empty hidden list still offers a hidden toggle`);
        const hiddenRecord = {
          ...conversation,
          id: "00000000-0000-4000-8000-000000000099",
          title: "Hidden conversation fixture",
          hidden: true,
        };
        const hiddenPattern = "**/v1/conversations?**";
        const hiddenRoute = async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (
            request.method() === "GET" &&
            url.pathname === "/v1/conversations" &&
            url.searchParams.get("hidden") === "only"
          )
            return route.fulfill({ json: { items: [hiddenRecord], total: 1 } });
          return route.fallback();
        };
        await page.route(hiddenPattern, hiddenRoute);
        try {
          await stand.visit(page, `chat/${conversation.id}`);
          await openConversationList(page);
          await page.getByTestId("conversation-toggle-hidden").click();
          await page
            .getByTestId("conversation-item-0")
            .filter({ hasText: hiddenRecord.title })
            .waitFor();
          if ((await page.getByTestId("conversation-hidden-empty").count()) !== 0)
            throw new Error(
              `${locale.artifact}: an existing hidden conversation is reported empty`,
            );
          await shoot(page, `${locale.artifact}-desktop-chat-hidden`, { fullPage: false });
          await page.getByTestId("conversation-toggle-hidden").click();
          await page
            .getByTestId("conversation-item-0")
            .filter({ hasNotText: hiddenRecord.title })
            .waitFor();
        } finally {
          await page.unroute(hiddenPattern, hiddenRoute);
          await stand.visit(page, "chat");
          await openConversationList(page);
        }
        await closeConversationList(page);
        await page.locator('[data-testid="conversation-new"]').click();
        await page.locator('[data-testid="chat-empty"]').waitFor({ state: "visible" });
        if ((await page.getByTestId("chat-summary").count()) !== 0)
          throw new Error(`${locale.artifact}: a new conversation carries a line under its title`);
        const newTitle = locale.name === "de" ? "Neue Unterhaltung" : "New conversation";
        if ((await page.getByTestId("chat-title").innerText()).trim() !== newTitle)
          throw new Error(`${locale.artifact}: a new conversation is not titled "${newTitle}"`);
        const modePicker = page.locator('[data-testid="chat-permission-select"]');
        const autoName = locale.name === "de" ? "Autonom" : "Autonomous";
        const askName = locale.name === "de" ? "Fragt vorher" : "Asks first";
        const defaultMode = locale.name === "de" ? "Systemstandard" : "system default";
        const pillText = async () => ((await modePicker.textContent()) ?? "").trim();
        if ((await pillText()) !== autoName)
          throw new Error(
            `${locale.artifact}: the mode pill reads ${JSON.stringify(await pillText())}, not "${autoName}"`,
          );
        if (
          await page
            .getByTestId("chat-mode-gates")
            .isVisible()
            .catch(() => false)
        )
          throw new Error(`${locale.artifact}: the gate matrix stands permanently in the header`);
        const gatesFor = async () => {
          await page.getByTestId("chat-mode-explain").click();
          const gates = page.getByTestId("chat-mode-gates");
          await gates.waitFor({ state: "visible" });
          const text = await gates.innerText();
          await page.keyboard.press("Escape");
          await gates.waitFor({ state: "hidden" });
          return text;
        };
        const autoGates = await gatesFor();
        await modePicker.click();
        const optionCount = await page.getByRole("option").count();
        if (optionCount !== 3)
          throw new Error(`${locale.artifact}: the mode picker offers ${optionCount} modes, not 3`);
        const defaultOption = page.getByRole("option", { name: autoName, exact: true });
        if (!(await defaultOption.innerText()).includes(defaultMode))
          throw new Error(`${locale.artifact}: the open list does not mark the system default`);
        const described = await page
          .locator('[role="option"] [data-slot="select-item-description"]')
          .count();
        if (described !== 3)
          throw new Error(`${locale.artifact}: ${described} of 3 modes explain themselves`);
        await page.getByRole("option", { name: askName, exact: true }).click();
        if ((await pillText()) !== askName)
          throw new Error(`${locale.artifact}: explicit conservative mode is not selectable`);
        if ((await gatesFor()) === autoGates)
          throw new Error(`${locale.artifact}: "ask" reads the same gates as the default mode`);
        await stand.visit(page, "chat/new");
        await page.locator('[data-testid="chat-empty"]').waitFor({ state: "visible" });
        if ((await pillText()) !== autoName)
          throw new Error(`${locale.artifact}: new chat retains an unintended override`);
        await page.waitForTimeout(300);
        await shoot(page, `${locale.artifact}-desktop-chat-new`, {
          fullPage: false,
        });
        await openConversationList(page);
        await page.locator('[data-testid="conversation-item-0"]').click();
        await page.getByTestId("chat-usage-tokens").waitFor({ state: "visible" });
        if ((await page.getByTestId("chat-permission-select").count()) !== 0)
          throw new Error(`${locale.artifact}: a running conversation offers to change its mode`);
        if (!(await page.getByTestId("chat-permission-mode").innerText()).includes(autoName))
          throw new Error(
            `${locale.artifact}: the running conversation's mode pill is not "${autoName}"`,
          );
        if ((await gatesFor()).length === 0)
          throw new Error(`${locale.artifact}: the running conversation's matrix is empty`);
        const tokensPill = (await page.getByTestId("chat-usage-tokens").innerText()).trim();
        if (tokensPill !== (locale.name === "de" ? "48.210 Chat-Tokens" : "48,210 chat tokens"))
          throw new Error(
            `${locale.artifact}: the tokens pill reads ${JSON.stringify(tokensPill)}`,
          );
        const costText = (await page.getByTestId("chat-usage-cost").innerText()).trim();
        if (!costText.startsWith(locale.name === "de" ? "mind." : "at least"))
          throw new Error(
            `${locale.artifact}: a partly priced cost reads ${JSON.stringify(costText)}`,
          );
        const budgetLink = page.getByTestId("chat-budget");
        if ((await budgetLink.getAttribute("data-budget")) !== "critical")
          throw new Error(`${locale.artifact}: the month at 95 % shows no critical allowance pill`);
        if (!(await budgetLink.getAttribute("href"))?.endsWith("/usage"))
          throw new Error(`${locale.artifact}: the allowance pill does not lead to Nutzung`);
        if ((await page.getByTestId("chat-origin").count()) !== 0)
          throw new Error(`${locale.artifact}: the origin line still stands in the header`);
        const tool = page.locator('[data-testid="chat-message-3-tool-0"]');
        await tool.scrollIntoViewIfNeeded();
        await page.locator('[data-testid="chat-message-3-tool-0-toggle"]').click();
        await shoot(page, `${locale.artifact}-desktop-chat-tool`, {
          fullPage: false,
        });
        await page.locator('[data-testid="chat-context-toggle"]').click();
        await page.locator('[data-testid="chat-context"]').waitFor({ state: "visible" });
        await page
          .locator('[data-testid="chat-context-reference-0"]')
          .waitFor({ state: "visible" });
        if ((await page.locator('[data-testid="chat-context-reference-0"] a').count()) !== 0)
          throw new Error(`${locale.artifact}: unresolved chat reference is still linked`);
        const resolvedReference = page.locator('[data-testid="chat-context-reference-1"] a');
        if ((await resolvedReference.count()) !== 1)
          throw new Error(`${locale.artifact}: resolved chat reference is not linked`);
        if (!(await resolvedReference.getAttribute("href"))?.includes(`/workflows/${uuid}`))
          throw new Error(`${locale.artifact}: resolved chat reference links to the wrong record`);
        await page.waitForTimeout(300);
        await shoot(page, `${locale.artifact}-desktop-chat-context`, {
          fullPage: false,
        });
        await page.locator('[data-testid="chat-context-close"]').click();
        await page.locator('[data-testid="chat-context"]').waitFor({ state: "hidden" });
        await page.locator('[data-testid="chat-composer-input"]').fill("Prüfe @mon");
        await page.locator('[data-testid="chat-mention-popover"]').waitFor({ state: "visible" });
        await page.locator('[data-testid="chat-mention-item-0"]').waitFor({ state: "visible" });
        const pickerHit = await page.evaluate(() => {
          const row = document.querySelector('[data-testid="chat-mention-item-0"]');
          if (!row) return false;
          const r = row.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return Boolean(hit && row.contains(hit));
        });
        if (!pickerHit)
          throw new Error(`${locale.artifact}: the @-picker is in the page but covered or clipped`);
        await shoot(page, `${locale.artifact}-desktop-chat-mention`, {
          fullPage: false,
        });
        await page.keyboard.press("Escape");
        const composerField = page.locator('[data-testid="chat-composer-input"]');
        await composerField.fill("");
        await composerField.pressSequentially("Zeig @rep");
        await page.locator('[data-testid="chat-mention-item-0"]').waitFor({ state: "visible" });
        const firstPick = (await page.getByTestId("chat-mention-item-0").innerText()).replace(
          /\s+/g,
          " ",
        );
        if (!/kategorie\/reporting · 21 workflows/i.test(firstPick))
          throw new Error(
            `${locale.artifact}: the picker's first entry is ${JSON.stringify(firstPick)}, not the reporting category`,
          );
        await page.keyboard.press("Enter");
        if ((await composerField.inputValue()) !== "Zeig @kategorie/reporting ")
          throw new Error(
            `${locale.artifact}: picking a category wrote ${JSON.stringify(await composerField.inputValue())}`,
          );
        await composerField.fill("");
        const chips = page.locator('[data-testid="chat-message-2-text-0-mentions"]');
        await chips.scrollIntoViewIfNeeded();
        await page
          .locator('[data-testid="chat-message-2-text-0-chip-1"]')
          .waitFor({ state: "visible" });
        await page.waitForTimeout(300);
        await shoot(page, `${locale.artifact}-desktop-chat-mention-chips`, {
          fullPage: false,
        });
        await page
          .locator('[data-testid="chat-composer-input"]')
          .fill("Prüfe den Workflow, ohne ihn auszuführen.");
        await page.locator('[data-testid="chat-composer-submit"]').click();
        await page
          .locator('[data-testid="chat-error"]')
          .waitFor({ state: "hidden" })
          .catch(() => {});
        await shoot(page, `${locale.artifact}-desktop-chat-interaction`, {
          fullPage: false,
        });
        await stand.visit(page, "workflows");
        await page.locator('[data-testid="sidebar-trigger"]').hover();
        await page.locator('[data-slot="tooltip-content"]').waitFor({ state: "visible" });
        await page.waitForTimeout(300);
        await shoot(page, `${locale.artifact}-desktop-tooltip`, {
          fullPage: false,
        });
        await page.locator('[data-testid="account-menu-trigger"]').click();
        await page.locator('[data-testid="account-menu"]').waitFor({ state: "visible" });
        await page.waitForTimeout(300);
        await shoot(page, `${locale.artifact}-desktop-account`, {
          fullPage: false,
        });
        await page.locator('[data-testid="account-language-menu"]').hover();
        await page
          .locator('[data-testid="account-language-content"]')
          .waitFor({ state: "visible" });
        await shoot(page, `${locale.artifact}-desktop-account-language`, {
          fullPage: false,
        });
        await page.keyboard.press("Escape");
        await page.locator('[data-testid="account-language-content"]').waitFor({ state: "hidden" });
        await page.keyboard.press("Escape");
        await page.locator('[data-testid="account-menu"]').waitFor({ state: "hidden" });
        await page.locator('[data-testid="account-menu-trigger"]').click();
        await page.locator('[data-testid="account-menu"]').waitFor({ state: "visible" });
        await page.locator('[data-testid="account-theme-menu"]').hover();
        await page.locator('[data-testid="account-theme-content"]').waitFor({ state: "visible" });
        await shoot(page, `${locale.artifact}-desktop-account-theme`, {
          fullPage: false,
        });
      }
      tooltips.assertNone(`${locale.artifact}/${viewport.name}`);
      await context.close();
    }
  }

  for (const locale of focused ? [] : variants) {
    for (const viewport of ["desktop", "mobile"].filter((name) =>
      viewports.some((swept) => swept.name === name),
    )) {
      const contact = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
      });
      const cards = await Promise.all(
        sweptRoutes.map(async (route) => {
          const artifactRoute = artifactRouteName(route);
          const frame = written.get(`${locale.artifact}-${viewport}-${artifactRoute}`);
          if (frame === undefined)
            throw new Error(
              `no frame ${locale.artifact}/${viewport}/${artifactRoute} to build a sheet from`,
            );
          const bytes = await readFile(frame);
          const source = `data:image/png;base64,${bytes.toString("base64")}`;
          return `<figure><img src="${source}" alt=""><figcaption>${artifactRoute}</figcaption></figure>`;
        }),
      );
      await contact.setContent(
        `<style>
      * { box-sizing: border-box }
      body { margin: 0; padding: 16px; background: #e2e8f0; font: 14px system-ui }
      main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px }
      figure { margin: 0; overflow: hidden; border-radius: 8px; background: white; box-shadow: 0 1px 3px #64748b }
      img { display: block; width: 100%; aspect-ratio: ${viewport === "desktop" ? "1.44" : "0.462"}; object-fit: cover; object-position: top }
      figcaption { padding: 8px; font-weight: 600 }
    </style><main>${cards.join("")}</main>`,
        { waitUntil: "load" },
      );
      await shootSheet(contact, `${locale.artifact}-${viewport}-contact-sheet`, {
        fullPage: true,
      });
      await contact.close();
    }
  }
  const RESPONSIVE_WIDTHS = [390, 768, 1024, 1280, 1440, 1920, 2048];
  const migratedRoutes = sweptRoutes.filter((route) => patternMigratedView(route) !== null);
  for (const width of RESPONSIVE_WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      locale: "de-DE",
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      localStorage.setItem("sk-cockpit-locale", "de");
      localStorage.setItem("sk-cockpit-theme", "light");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`responsive/${width}: ${error.message}`));
    await page.route("**/v1/**", mockApi);
    for (const route of migratedRoutes) {
      await stand.visit(page, route);
      await page.locator(markerFor(route)).waitFor({ state: "visible" });
      await assertNoHorizontalScroll(page, `responsive/${width}/${route}`);
      if (width >= 1024) await assertDesktopLayout(page, `responsive/${width}/${route}`);
    }
    await context.close();
  }

  if (standOn(assertFirstSendIsNeverLost)) await assertFirstSendIsNeverLost(browser, stand);
  if (errors.length) throw new Error(errors.join("; "));
  if (framesWritten === 0) await prepareOutput();
  const framesOnDisk = (await readdir(outputDir, { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".png"),
  ).length;
  if (framesOnDisk !== framesWritten)
    throw new Error(
      `Cockpit visual sweep counted ${framesWritten} frames but ${outputDir} holds ${framesOnDisk} ` +
        "PNG files. A screenshot was taken past shoot(), so the number below would not be a " +
        "measurement of this run.",
    );
} catch (error) {
  sweepFailed = true;
  sweepFailure = error;
} finally {
  const results = await Promise.allSettled([browser?.close(), spawnedPreview?.stop()]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    const error = new AggregateError(
      failures.map((result) => result.reason),
      "Cockpit visual sweep resources could not be closed.",
    );
    if (sweepFailed) console.error(error);
    else {
      sweepFailed = true;
      sweepFailure = error;
    }
  }
}
if (sweepFailed) throw sweepFailure;
console.log(
  `Cockpit visual sweep passed: ${framesWritten} screenshots in ${outputDir} ` +
    "(counted at each write and held against the files on disk — not computed from the route table)",
);
