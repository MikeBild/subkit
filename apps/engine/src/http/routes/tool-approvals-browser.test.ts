import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { type Browser, chromium } from "playwright";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import { toolApprovals } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { consumeApproval, requestApproval } from "../../tools/approval.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

const nextId = createDeterministicUuidFactory(0x707262);
let server: HttpTestServer;
let browser: Browser;
let requester: ResolvedPrincipal;
let cookie: { name: string; value: string };

beforeAll(async () => {
  server = await createHttpTestServer("approval-portal-browser");
  await setConfigKey("server.public_base_url", server.baseUrl, { force: true });
  const login = await issueBrowserSession({
    db: server.db,
    tenantId: server.tenantId,
    userId: server.userId,
    redirectTo: server.baseUrl,
    via: "approval_browser_test",
  });
  const first = login.headers.get("set-cookie")?.split(";", 1)[0];
  const separator = first?.indexOf("=") ?? -1;
  if (!first || separator < 1) throw new Error("missing test browser session");
  cookie = { name: first.slice(0, separator), value: first.slice(separator + 1) };
  requester = {
    provider: "api_key",
    kind: "system_account",
    id: server.systemAccountId,
    tenant_id: server.tenantId,
    roles: [],
  };
  browser = await chromium.launch({ headless: true });
  await mkdir(".artifacts/approval-portal", { recursive: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.cleanup();
});

async function approvalRow(id: string) {
  const [row] = await server.db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, server.tenantId), eq(toolApprovals.id, id)));
  return row;
}

for (const locale of ["de", "en"] as const) {
  for (const width of [390, 1280]) {
    test(`real portal ${locale}/${width}: language, keyboard, decision and reload`, async () => {
      const id = nextId();
      const result = await requestApproval({
        db: server.db,
        principal: requester,
        approval_id: id,
        tool: "wf_ledger_example",
        surface: "mcp",
        via: "mcp",
        reason: "held_writes",
        execution_mode: "dev",
        args: { confidential: "must-not-render" },
        preview: {
          would_write: [
            {
              step: "post_entries",
              method: "POST",
              url: "https://ledger.example.test/entries?token=hidden-value",
            },
          ],
        },
      });
      if (!result.approval_url) throw new Error("test approval URL missing");
      const context = await browser.newContext({
        locale,
        viewport: { width, height: 900 },
        colorScheme: width === 390 ? "dark" : "light",
        javaScriptEnabled: false,
      });
      try {
        await context.addCookies([{ ...cookie, url: server.baseUrl }]);
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === server.baseUrl
            ? route.continue()
            : route.abort(),
        );
        const page = await context.newPage();
        const response = await page.goto(result.approval_url);
        expect(response?.status()).toBe(200);
        expect(await page.locator("html").getAttribute("lang")).toBe(locale);
        expect(await page.locator("body").innerText()).not.toContain("must-not-render");
        expect(await page.locator("body").innerText()).not.toContain("hidden-value");
        expect(await page.locator("body").innerText()).toContain("ledger.example.test/entries");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        const before = await approvalRow(id);
        await page
          .getByRole("button", { name: locale === "de" ? "English" : "Deutsch", exact: true })
          .click();
        expect(await page.locator("html").getAttribute("lang")).toBe(locale === "de" ? "en" : "de");
        expect((await approvalRow(id))?.granted_at).toBeNull();
        expect((await approvalRow(id))?.expires_at).toEqual(before?.expires_at);
        await page
          .getByRole("button", { name: locale === "de" ? "Deutsch" : "English", exact: true })
          .click();
        await page.locator("summary").focus();
        await page.keyboard.press("Enter");
        expect(await page.locator("details").getAttribute("open")).not.toBeNull();
        const action = page.getByRole("button", {
          name: locale === "de" ? "Diese Aktion einmalig freigeben" : "Authorize this action once",
          exact: true,
        });
        await action.focus();
        expect(await action.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
          "none",
        );
        expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({
          path: `.artifacts/approval-portal/${locale}-${width}-pending.png`,
          fullPage: true,
        });
        await page.keyboard.press("Enter");
        await page
          .getByRole("heading", { name: locale === "de" ? "Freigegeben" : "Approved", exact: true })
          .waitFor();
        expect(await page.locator("h1").innerText()).toBe(
          locale === "de" ? "Freigegeben" : "Approved",
        );
        const approved = await approvalRow(id);
        expect(approved?.granted_by_user_id).toBe(server.userId);
        expect(approved?.consumed_at).toBeNull();
        await page.goto(result.approval_url);
        expect(await page.locator("form").count()).toBe(0);
        const claimed = await consumeApproval({
          db: server.db,
          principal: requester,
          approval_id: id,
          tool: "wf_ledger_example",
          surface: "mcp",
          via: "mcp",
          execution_mode: "dev",
        });
        expect(claimed.ok).toBe(true);
        await page.reload();
        expect(await page.locator("h1").innerText()).toBe(
          locale === "de"
            ? "Freigabe verbraucht — Ergebnis unbekannt"
            : "Approval consumed — outcome unknown",
        );
        expect(await page.locator("form").count()).toBe(0);
        expect(await page.locator("body").innerText()).not.toContain("ledger.example.test");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `.artifacts/approval-portal/${locale}-${width}-consumed.png`,
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    }, 30_000);
  }
}
