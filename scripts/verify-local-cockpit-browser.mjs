import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { verifyLocalChatWorkspace } from "./lib/cockpit-workspace-journey.mjs";

const base = new URL(
  process.env.SUBKIT_DEMO_URL ?? `http://localhost:${process.env.SUBKIT_TEST_PORT ?? "3000"}`,
);
if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
  throw new Error("Local cockpit verification requires a loopback HTTP address");
const flags = new Set(process.argv.slice(2));
const workspaceOnly = flags.has("--workspace-only");
const readOnly = flags.has("--read-only");
const chatOnly = flags.has("--chat-only");
const workflowOnly = flags.has("--workflow-only");
const cleanupOnly = flags.has("--cleanup-only");
if (
  [...flags].some(
    (arg) =>
      ![
        "--read-only",
        "--chat-only",
        "--workflow-only",
        "--cleanup-only",
        "--workspace-only",
      ].includes(arg),
  ) ||
  flags.size > 1
)
  throw new Error(
    "Usage: bun scripts/verify-local-cockpit-browser.mjs [--read-only|--chat-only|--workflow-only|--cleanup-only|--workspace-only]",
  );
const directory = resolve(".artifacts/cockpit-demo");
const key = (await readFile(resolve(directory, "api-key.txt"), "utf8")).trim();
if (!key) throw new Error("Local demo API key is missing");
const receipt = { startedAt: new Date().toISOString(), base: base.origin, checks: [], chat: null };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "de-DE",
});
const errors = [];
try {
  await context.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base.origin}/cockpit/`, { waitUntil: "domcontentloaded" });
  if (!(await page.locator('input[name="api_key"]').count())) {
    await page.locator('a[href*="provider=api-key"]').click();
  }
  await page.locator('input[name="api_key"]').fill(key);
  const [login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/v1/identity/login/start",
    ),
    page.locator('button[type="submit"]').click(),
  ]);
  if (login.status() >= 400) throw new Error(`Browser login failed: HTTP ${login.status()}`);
  await page.waitForURL(`${base.origin}/cockpit/**`);
  const bootstrap = await context.request.get(`${base.origin}/v1/cockpit/bootstrap`);
  if (!bootstrap.ok()) throw new Error(`Authenticated bootstrap failed: ${bootstrap.status()}`);
  const session = await bootstrap.json();
  const writeHeaders = {
    origin: base.origin,
    "x-subkit-client": "cockpit",
    "x-subkit-csrf": session.csrf_token,
  };
  receipt.checks.push("browser-api-key-login");
  console.log("PASS browser-api-key-login");
  const pages = [
    ["", "attention-page"],
    ["workflows", "catalog-workflows"],
    ["connectors", "catalog-connectors"],
    ["knowledge", "catalog-knowledge"],
    ["skills", "catalog-skills"],
    ["files", "files-page"],
    ["chat", "chat-workspace"],
    ["usage", "resource-usage"],
    ["audit", "resource-audit"],
    ["people", "admin-people"],
    ["api-access", "admin-api-access"],
    ["settings", "admin-settings"],
  ];
  for (const [route, marker] of chatOnly || workflowOnly || cleanupOnly || workspaceOnly
    ? []
    : pages) {
    if (route) {
      await page.locator(`a[href="/cockpit/${route}"]`).first().click();
    } else {
      await page.goto(`${base.origin}/cockpit/`);
    }
    await page.getByTestId(marker).waitFor({ state: "visible" });
    if (["workflows", "connectors", "knowledge", "skills", "files"].includes(route)) {
      const links = page.locator(`a[href^="/cockpit/${route}/"]:not([href$="/new"])`);
      await links.first().waitFor({ state: "visible" });
      const href = await links.first().getAttribute("href");
      await links.first().click();
      await page.waitForURL(`${base.origin}${href}`);
      const detail = route === "files" ? "file-facts" : `detail-${route}`;
      await page.getByTestId(detail).waitFor({ state: "visible" });
      receipt.checks.push(`${route}-detail`);
      if (route === "files") {
        await page.getByTestId("file-sheet-close").click();
        await page.getByTestId("file-sheet").waitFor({ state: "hidden" });
      }
    }
    receipt.checks.push(route || "overview");
    console.log(`PASS live ${route || "overview"}`);
  }
  if (workspaceOnly) {
    receipt.checks.push(...(await verifyLocalChatWorkspace(page, base.origin)));
    console.log("PASS live chat workspace draft and context retention");
  }
  if (!readOnly && !workflowOnly && !cleanupOnly && !workspaceOnly) {
    await page.goto(`${base.origin}/cockpit/chat/new`);
    const prompt =
      "Lokaler Funktionstest. Antworte ausschließlich mit: Lokaler Browser-Chat funktioniert. Verwende keine Werkzeuge und ändere keine Daten.";
    await page.getByTestId("chat-composer-input").fill(prompt);
    await page.getByTestId("chat-composer-submit").click();
    await page.waitForURL(
      (url) => /\/cockpit\/chat\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"),
      { timeout: 90000 },
    );
    const id = new URL(page.url()).pathname.split("/").at(-1);
    let assistant = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const response = await context.request.get(`${base.origin}/v1/conversations/${id}`);
      if (!response.ok()) throw new Error(`New conversation read failed: ${response.status()}`);
      const body = await response.json();
      assistant = body.messages?.find(
        (message) =>
          message.role === "assistant" &&
          message.parts?.some(
            (part) =>
              part.type === "text" && part.text?.includes("Lokaler Browser-Chat funktioniert"),
          ),
      );
      if (assistant) break;
      if (body.last_turn_error)
        throw new Error(`Chat failed: ${body.last_turn_error.code ?? "unknown"}`);
      await page.waitForTimeout(1000);
    }
    if (!assistant) throw new Error("Real provider assistant response did not arrive");
    await page
      .getByTestId("chat-transcript")
      .getByText("Lokaler Browser-Chat funktioniert.", { exact: true })
      .waitFor({ state: "visible" });
    receipt.chat = { conversationId: id, assistantModel: assistant.model, passed: true };
    receipt.checks.push("real-provider-chat-send-and-response");
    console.log("PASS real-provider-chat-send-and-response");
  }
  if (!readOnly && !chatOnly && !workspaceOnly) {
    const apiReceipt = JSON.parse(
      await readFile(resolve(directory, "local-functional-journey.json"), "utf8"),
    );
    const origin = new URL(apiReceipt.base);
    const owned = apiReceipt.retainedWorkflow;
    if (
      !apiReceipt.passed ||
      origin.protocol !== base.protocol ||
      origin.port !== base.port ||
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
      !/^local-journey-[a-f0-9]+$/.test(apiReceipt.label) ||
      !owned?.id
    )
      throw new Error("Successful local API ownership receipt with retained workflow is required");
    const path = `/v1/workflows/${encodeURIComponent(owned.id)}`;
    const getJson = async (path) => {
      const response = await context.request.get(`${base.origin}${path}`);
      if (!response.ok()) throw new Error(`Local workflow read failed: ${response.status()}`);
      return response.json();
    };
    const workflow = await getJson(path);
    const name = workflow.name ?? workflow.workflow?.name;
    if (name !== apiReceipt.label)
      throw new Error("Retained workflow ownership name no longer matches");
    const preview = await getJson(
      `${path}/versions/${owned.versionId}/authority-preview?environment=dev`,
    );
    if (
      !preview.manifest?.effects?.length ||
      preview.manifest.effects.some(
        (effect) =>
          effect.target !== "http://demo-api:8080/contacts" ||
          effect.operation !== "GET" ||
          effect.effect !== "read" ||
          effect.environment !== "dev",
      )
    )
      throw new Error("Owned workflow boundary is no longer the local fixture GET");
    receipt.workflow = { id: owned.id, boundary: "GET http://demo-api:8080/contacts" };
    const prior = cleanupOnly
      ? JSON.parse(await readFile(resolve(directory, "browser-workflow-functional.json"), "utf8"))
      : null;
    if (prior && prior.workflow?.id !== owned.id)
      throw new Error("Cleanup receipt workflow mismatch");
    let authorityId = prior?.workflow?.authorityId;
    try {
      if (!cleanupOnly) {
        await page.goto(`${base.origin}/cockpit/workflows/${owned.id}`);
        await page.getByTestId("workflow-automation-action").click();
        await page.getByTestId("authority-grant-review").waitFor({ state: "visible" });
        const picker = page.getByTestId("authority-environment");
        if (await picker.isVisible()) {
          await picker.click();
          await page.getByTestId("authority-environment-dev").click();
        }
        await page.getByTestId("authority-limit-seven-days").click();
        const granted = page.waitForResponse(
          (response) =>
            response.url().endsWith(`${path}/execution-authorities`) &&
            response.request().method() === "POST",
        );
        await page.getByTestId("authority-grant-confirm").click();
        const grantResponse = await granted;
        if (!grantResponse.ok())
          throw new Error(`Human browser grant failed: ${grantResponse.status()}`);
        const grant = await grantResponse.json();
        authorityId = grant.id;
        if (!authorityId) throw new Error("Human browser grant returned no authority id");
        receipt.workflow.authorityId = authorityId;
        receipt.checks.push("human-browser-workflow-grant");
        await page.getByTestId("authority-grant-dialog").waitFor({ state: "hidden" });
        await page.reload();
        await page.getByTestId("workflow-run-open").click();
        await page.getByTestId("workflow-run-dialog").waitFor({ state: "visible" });
        const executed = page.waitForResponse(
          (response) =>
            response.url().endsWith("/v1/executions") && response.request().method() === "POST",
        );
        await page.getByTestId("workflow-run-submit").click();
        const runResponse = await executed;
        if (!runResponse.ok())
          throw new Error(`Approved browser run failed: ${runResponse.status()}`);
        const run = await runResponse.json();
        if (!run.execution_id) throw new Error("Approved browser run returned no execution id");
        let execution;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          execution = await getJson(`/v1/executions/${run.execution_id}`);
          if (
            ["succeeded", "completed", "failed"].includes(
              execution.status ?? execution.execution?.status,
            )
          )
            break;
          await page.waitForTimeout(1000);
        }
        if (!["succeeded", "completed"].includes(execution.status ?? execution.execution?.status))
          throw new Error("Approved local workflow did not complete successfully");
        receipt.workflow.executionId = run.execution_id;
        receipt.checks.push("approved-browser-workflow-execution");
        console.log("PASS human-browser-grant-and-local-workflow-run");
      }
    } finally {
      if (authorityId) {
        const revoked = await context.request.post(
          `${base.origin}${path}/execution-authorities/${authorityId}/revoke`,
          { headers: writeHeaders },
        );
        if (!revoked.ok()) errors.push(`Owned authority cleanup failed: ${revoked.status()}`);
        receipt.workflow.revoked = revoked.ok();
      }
      const removed = await context.request.delete(`${base.origin}${path}`, {
        headers: writeHeaders,
      });
      if (!removed.ok()) errors.push(`Owned workflow cleanup failed: ${removed.status()}`);
      receipt.workflow.deleted = removed.ok();
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = error.message.replaceAll(key, "[redacted]");
  throw error;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(
    resolve(
      directory,
      workspaceOnly
        ? "browser-workspace-functional.json"
        : cleanupOnly
          ? "browser-cleanup-functional.json"
          : chatOnly
            ? "browser-chat-functional.json"
            : workflowOnly
              ? "browser-workflow-functional.json"
              : readOnly
                ? "browser-navigation-functional.json"
                : "browser-functional.json",
    ),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  await context.close();
  await browser.close();
}
