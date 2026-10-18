import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { deleteOwnedConversation } from "./lib/cockpit-chat-cleanup.mjs";
import { recoverOwnedConversationReceipts } from "./lib/cockpit-chat-recovery.mjs";
import { installChatConversationCapture } from "./lib/cockpit-chat-sse.mjs";
import { cockpitDemoDatabaseGeneration } from "./lib/cockpit-demo-database-generation.mjs";
import {
  assertCockpitDemoMarker,
  cockpitDemoBaseUrl,
  cockpitDemoStateDirectory,
  readCockpitDemoMarker,
  resolveCockpitDemoInstance,
} from "./lib/cockpit-demo-instance.ts";
import {
  assertLocalChatResponseModel,
  cleanupLocalWorkflow,
  finalizeLocalVerification,
  redactLocalVerificationError,
} from "./lib/cockpit-demo-verification.ts";
import { verifySessionLearningReview } from "./lib/cockpit-session-learning-journey.mjs";
import { shouldLoadBrowserWorkflowCleanup } from "./lib/cockpit-workflow-cleanup-scope.mjs";
import { verifyLocalChatWorkspace } from "./lib/cockpit-workspace-journey.mjs";

const instance = resolveCockpitDemoInstance(process.env, process.cwd());
const base = cockpitDemoBaseUrl(instance, process.env.SUBKIT_DEMO_URL ?? instance.baseUrl);
const flags = new Set(process.argv.slice(2));
const workspaceOnly = flags.has("--workspace-only");
const readOnly = flags.has("--read-only");
const chatOnly = flags.has("--chat-only");
const mockChat = flags.has("--mock-chat");
const workflowOnly = flags.has("--workflow-only");
const cleanupOnly = flags.has("--cleanup-only");
const sessionLearningsOnly = flags.has("--session-learnings-only");
if (
  [...flags].some(
    (arg) =>
      ![
        "--read-only",
        "--chat-only",
        "--mock-chat",
        "--workflow-only",
        "--cleanup-only",
        "--workspace-only",
        "--session-learnings-only",
      ].includes(arg),
  ) ||
  (flags.size > 1 && !(flags.size === 2 && (chatOnly || sessionLearningsOnly) && mockChat))
)
  throw new Error(
    "Usage: bun scripts/verify-local-cockpit-browser.mjs [--read-only|--chat-only|--workflow-only|--cleanup-only|--workspace-only|--session-learnings-only] [--mock-chat] (mock chat may be combined with --chat-only or --session-learnings-only)",
  );
const directory = cockpitDemoStateDirectory(instance, process.env.SUBKIT_DEMO_STATE_DIR);
const key = (await readFile(resolve(directory, "api-key.txt"), "utf8")).trim();
if (!key) throw new Error("Local demo API key is missing");
const build = JSON.parse(await readFile(resolve(directory, "build.json"), "utf8"));
if (!/^[a-f0-9]{64}$/.test(build.source) || !/^sha256:[a-f0-9]{64}$/.test(build.image))
  throw new Error("Current local demo build receipt is missing source or image identity");
const marker = readCockpitDemoMarker(instance);
assertCockpitDemoMarker(marker, instance);
if (marker.source !== build.source || marker.image !== build.image)
  throw new Error("Current local demo instance and build receipts do not match");
const demoState = JSON.parse(await readFile(resolve(directory, "state.json"), "utf8"));
if (!/^[0-9a-f-]{36}$/i.test(demoState.tenantId ?? ""))
  throw new Error("Current local demo database tenant identity is missing");
const selectedDatabaseGeneration = cockpitDemoDatabaseGeneration(instance, process.cwd());
const databaseGeneration = createHash("sha256")
  .update(
    JSON.stringify({
      project: instance.project,
      apiPort: instance.apiPort,
      dbPort: instance.dbPort,
      tenantId: demoState.tenantId,
      source: build.source,
      image: build.image,
      database: selectedDatabaseGeneration,
    }),
  )
  .digest("hex");
const receipt = {
  startedAt: new Date().toISOString(),
  base: base.origin,
  installation: { source: build.source, image: build.image },
  checks: [],
  chat: null,
};
const chatRunId = randomUUID();
const chatOwnershipPath = resolve(directory, `browser-chat-ownership-${chatRunId}.json`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "de-DE",
});
const errors = [];
const authenticationValues = new Set([key]);
const redact = (error) => redactLocalVerificationError(error, authenticationValues);
let ownedWorkflow = null;
let sessionIdentity = null;
let sessionHeaders = null;
let writeHeaders = null;
let ownedConversation = null;
try {
  await context.exposeBinding("__subkitCaptureOwnedConversation", async (_source, value) => {
    if (typeof value?.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id)) {
      const captured = {
        schema: "subkit-local-chat-ownership-v1",
        id: value.id,
        runId: chatRunId,
        instance: `${instance.project}:${instance.apiPort}:${instance.dbPort}`,
        databaseGeneration,
        tenantId: sessionIdentity?.tenantId ?? null,
        ownerId: sessionIdentity?.ownerId ?? null,
      };
      if (!captured.tenantId || !captured.ownerId)
        throw new Error("Conversation capture has no authenticated tenant and owner");
      const temporaryPath = `${chatOwnershipPath}.tmp`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporaryPath, `${JSON.stringify(captured)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, chatOwnershipPath);
      ownedConversation = captured;
    }
  });
  await context.exposeBinding("__subkitConversationCaptureFailure", (_source, reason) => {
    errors.push(`Conversation ownership capture failed: ${redact(reason)}`);
  });
  await context.addInitScript(() => {
    localStorage.setItem("sk-cockpit-locale", "de");
    localStorage.setItem("sk-cockpit-theme", "light");
  });
  await context.addInitScript(installChatConversationCapture, { timeoutMs: 5000 });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(redact(error)));
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
  const sessionCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "subkit_session",
  );
  if (!sessionCookie) throw new Error("Browser login did not establish a session cookie");
  authenticationValues.add(sessionCookie.value);
  sessionHeaders = { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  const bootstrap = await context.request.get(`${base.origin}/v1/cockpit/bootstrap`, {
    headers: sessionHeaders,
  });
  if (!bootstrap.ok()) throw new Error(`Authenticated bootstrap failed: ${bootstrap.status()}`);
  const session = await bootstrap.json();
  if (session.tenant?.id !== demoState.tenantId || !session.principal?.id)
    throw new Error("Browser session does not match the selected local demo database tenant");
  sessionIdentity = { tenantId: session.tenant.id, ownerId: session.principal.id };
  if (typeof session.csrf_token === "string") authenticationValues.add(session.csrf_token);
  writeHeaders = {
    origin: base.origin,
    "x-subkit-client": "cockpit",
    "x-subkit-csrf": session.csrf_token,
  };
  if (cleanupOnly) {
    const recovery = await recoverOwnedConversationReceipts({
      directory,
      instance: `${instance.project}:${instance.apiPort}:${instance.dbPort}`,
      databaseGeneration,
      tenantId: sessionIdentity.tenantId,
      ownerId: sessionIdentity.ownerId,
      readDirectory: readdir,
      readFile,
      lstat,
      unlink,
      cleanup: (id, ownedReceipt) =>
        deleteOwnedConversation({
          id,
          receipt: ownedReceipt,
          selectedInstance: {
            key: `${instance.project}:${instance.apiPort}:${instance.dbPort}`,
            databaseGeneration,
          },
          currentInstance: {
            key: `${instance.project}:${instance.apiPort}:${instance.dbPort}`,
            databaseGeneration,
          },
          tenantId: sessionIdentity.tenantId,
          ownerId: sessionIdentity.ownerId,
          headers: { ...writeHeaders, ...sessionHeaders },
          request: {
            delete: (path, options) => context.request.delete(`${base.origin}${path}`, options),
            post: (path, options) => context.request.post(`${base.origin}${path}`, options),
          },
        }),
    });
    receipt.chatCleanupRecovery = recovery;
    errors.push(...recovery.failures.map(redact));
    console.log(`PASS local conversation cleanup recovery: ${recovery.cleaned} removed`);
  }
  receipt.checks.push("browser-api-key-login");
  console.log("PASS browser-api-key-login");
  const shouldLoadWorkflowCleanup = shouldLoadBrowserWorkflowCleanup({
    readOnly,
    chatOnly: chatOnly || sessionLearningsOnly,
    workspaceOnly,
    cleanupOnly,
    apiReceiptPresent: existsSync(resolve(directory, "local-functional-journey.json")),
    browserReceiptPresent: existsSync(resolve(directory, "browser-workflow-functional.json")),
  });
  if (shouldLoadWorkflowCleanup) {
    const apiReceipt = JSON.parse(
      await readFile(resolve(directory, "local-functional-journey.json"), "utf8"),
    );
    const origin = new URL(apiReceipt.base);
    const owned = apiReceipt.retainedWorkflow;
    if (
      !apiReceipt.passed ||
      apiReceipt.installation?.source !== receipt.installation.source ||
      apiReceipt.installation?.image !== receipt.installation.image ||
      origin.protocol !== base.protocol ||
      origin.port !== base.port ||
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
      !/^local-journey-[a-f0-9]+$/.test(apiReceipt.label) ||
      !owned?.id
    )
      throw new Error("Successful local API ownership receipt with retained workflow is required");
    const path = `/v1/workflows/${encodeURIComponent(owned.id)}`;
    const getJson = async (path) => {
      const response = await context.request.get(`${base.origin}${path}`, {
        headers: sessionHeaders,
      });
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
    ownedWorkflow = {
      owned,
      path,
      getJson,
      authorityId: prior?.workflow?.authorityId,
      writeHeaders,
      sessionHeaders,
    };
  }
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
  for (const [route, marker] of chatOnly ||
  workflowOnly ||
  cleanupOnly ||
  workspaceOnly ||
  sessionLearningsOnly
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
  if (!readOnly && !workflowOnly && !cleanupOnly && !workspaceOnly && !sessionLearningsOnly) {
    if (mockChat) {
      const settings = await Promise.all(
        ["llm.provider", "llm.fallback_provider", "llm.fallback_model"].map((path) =>
          context.request.get(`${base.origin}/v1/settings/${path}`, { headers: sessionHeaders }),
        ),
      );
      for (const response of settings)
        if (!response.ok()) throw new Error(`Cannot verify mock chat route: ${response.status()}`);
      const [provider, fallbackProvider, fallbackModel] = await Promise.all(
        settings.map((response) => response.json()),
      );
      if (
        provider.value !== "mock" ||
        fallbackProvider.value ||
        (fallbackModel.value !== "" && fallbackModel.value !== null)
      )
        throw new Error("Mock chat verification requires a mock-only local demo route");
    }
    await page.goto(`${base.origin}/cockpit/chat/new`);
    const prompt = mockChat
      ? "Lokaler Mock-Funktionstest. Bestätige kurz den Testtext 'Lokaler Browser-Chat funktioniert' und verwende keine Werkzeuge oder Datenänderungen."
      : "Lokaler Funktionstest. Antworte ausschließlich mit: Lokaler Browser-Chat funktioniert. Verwende keine Werkzeuge und ändere keine Daten.";
    await page.getByTestId("chat-composer-input").fill(prompt);
    await page.getByTestId("chat-composer-submit").click();
    await page.waitForURL(
      (url) => /\/cockpit\/chat\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith("/new"),
      { timeout: 90000 },
    );
    const id = ownedConversation?.id;
    if (!id) throw new Error("No server-originated conversation ownership receipt was captured");
    let assistant = null;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const response = await context.request.get(`${base.origin}/v1/conversations/${id}`, {
        headers: sessionHeaders,
      });
      if (!response.ok()) throw new Error(`New conversation read failed: ${response.status()}`);
      const body = await response.json();
      const assistantIndex = body.messages?.findIndex(
        (message) =>
          message.role === "assistant" &&
          message.parts?.some(
            (part) =>
              part.type === "text" &&
              part.text?.includes("Lokaler Browser-Chat funktioniert") &&
              (!mockChat || part.text.startsWith("Acknowledged:")),
          ),
      );
      assistant =
        assistantIndex >= 0
          ? { message: body.messages[assistantIndex], index: assistantIndex }
          : null;
      if (assistant) break;
      if (body.last_turn_error)
        throw new Error(`Chat failed: ${body.last_turn_error.code ?? "unknown"}`);
      await page.waitForTimeout(1000);
    }
    if (!assistant)
      throw new Error(
        mockChat
          ? "Mock provider assistant response did not arrive"
          : "Real provider assistant response did not arrive",
      );
    assertLocalChatResponseModel(assistant.message.model, mockChat);
    const assistantBubble = page.getByTestId(`chat-message-${assistant.index}`);
    await assistantBubble.waitFor({ state: "visible" });
    if (!(await assistantBubble.innerText()).includes("Lokaler Browser-Chat funktioniert"))
      throw new Error("Assistant chat response is not visible in the transcript");
    receipt.chat = {
      conversationId: id,
      assistantModel: assistant.message.model,
      mode: mockChat ? "mock" : "provider",
      passed: true,
    };
    receipt.checks.push(
      mockChat ? "mock-provider-chat-send-and-response" : "real-provider-chat-send-and-response",
    );
    console.log(`PASS ${mockChat ? "mock-provider" : "real-provider"}-chat-send-and-response`);
  }
  if (!readOnly && !chatOnly && !workflowOnly && !cleanupOnly && !workspaceOnly) {
    const review = await verifySessionLearningReview({
      page,
      request: context.request,
      origin: base.origin,
      sessionHeaders,
      writeHeaders,
      apiKey: key,
      mockChat,
    });
    receipt.sessionLearningReview = review.result;
    if (review.errors.length) throw new Error(review.errors.join("; "));
    receipt.checks.push(
      "session-learnings-review-deterministic",
      ...(mockChat ? [] : ["session-learnings-review-real-model"]),
    );
    console.log(
      `PASS session learnings review (deterministic${mockChat ? "; real model skipped in mock mode" : " and real model"})`,
    );
  }
  if (ownedWorkflow && !cleanupOnly) {
    const { owned, path, getJson } = ownedWorkflow;
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
    ownedWorkflow.authorityId = grant.id;
    if (!ownedWorkflow.authorityId) throw new Error("Human browser grant returned no authority id");
    receipt.workflow.authorityId = ownedWorkflow.authorityId;
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
    if (!runResponse.ok()) throw new Error(`Approved browser run failed: ${runResponse.status()}`);
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
  if (errors.length) throw new Error(errors.join("; "));
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = redact(error);
} finally {
  if (ownedWorkflow) {
    const { path, authorityId, writeHeaders, sessionHeaders } = ownedWorkflow;
    const failures = await cleanupLocalWorkflow({
      ...(authorityId
        ? {
            revoke: async () => {
              const revoked = await context.request.post(
                `${base.origin}${path}/execution-authorities/${encodeURIComponent(authorityId)}/revoke`,
                { headers: { ...writeHeaders, ...sessionHeaders } },
              );
              receipt.workflow.revoked = revoked.ok();
              if (!revoked.ok())
                throw new Error(`Owned authority cleanup failed: ${revoked.status()}`);
            },
          }
        : {}),
      remove: async () => {
        const removed = await context.request.delete(`${base.origin}${path}`, {
          headers: { ...writeHeaders, ...sessionHeaders },
        });
        receipt.workflow.deleted = removed.ok();
        if (!removed.ok()) throw new Error(`Owned workflow cleanup failed: ${removed.status()}`);
      },
    });
    errors.push(...failures.map(redact));
  }
  if (ownedConversation) {
    try {
      const currentBuild = JSON.parse(await readFile(resolve(directory, "build.json"), "utf8"));
      const currentMarker = readCockpitDemoMarker(instance);
      assertCockpitDemoMarker(currentMarker, instance);
      if (
        currentMarker.source !== currentBuild.source ||
        currentMarker.image !== currentBuild.image
      ) {
        errors.push("Owned conversation cleanup failed: local build identity changed");
      } else {
        const currentState = JSON.parse(await readFile(resolve(directory, "state.json"), "utf8"));
        const currentDatabaseGeneration = cockpitDemoDatabaseGeneration(instance, process.cwd());
        const currentGeneration = createHash("sha256")
          .update(
            JSON.stringify({
              project: instance.project,
              apiPort: instance.apiPort,
              dbPort: instance.dbPort,
              tenantId: currentState.tenantId,
              source: currentBuild.source,
              image: currentBuild.image,
              database: currentDatabaseGeneration,
            }),
          )
          .digest("hex");
        const result = await deleteOwnedConversation({
          id: ownedConversation.id,
          receipt: ownedConversation,
          selectedInstance: {
            key: `${instance.project}:${instance.apiPort}:${instance.dbPort}`,
            databaseGeneration,
          },
          currentInstance: {
            key: `${instance.project}:${instance.apiPort}:${instance.dbPort}`,
            databaseGeneration: currentGeneration,
          },
          tenantId: currentState.tenantId,
          ownerId: sessionIdentity?.ownerId,
          headers: { ...writeHeaders, ...sessionHeaders },
          request: {
            delete: (path, options) => context.request.delete(`${base.origin}${path}`, options),
            post: (path, options) => context.request.post(`${base.origin}${path}`, options),
          },
        });
        receipt.chat = {
          ...(receipt.chat ?? {}),
          conversationId: ownedConversation.id,
          deleted: true,
          alreadyMissing: result.alreadyMissing,
        };
        await unlink(chatOwnershipPath).catch(() => {});
      }
    } catch (error) {
      errors.push(`Owned conversation cleanup failed: ${redact(error)}`);
    }
  }
  if (errors.length) {
    receipt.passed = false;
    receipt.cleanupErrors = errors.map(redact);
  }
  receipt.finishedAt = new Date().toISOString();
  const receiptPath = resolve(
    directory,
    workspaceOnly
      ? "browser-workspace-functional.json"
      : cleanupOnly
        ? "browser-cleanup-functional.json"
        : chatOnly
          ? mockChat
            ? "browser-chat-mock-functional.json"
            : "browser-chat-functional.json"
          : workflowOnly
            ? "browser-workflow-functional.json"
            : readOnly
              ? "browser-navigation-functional.json"
              : sessionLearningsOnly
                ? "browser-session-learnings-functional.json"
                : "browser-functional.json",
  );
  const finalizationErrors = await finalizeLocalVerification({
    saveReceipt: async (cleanupFailures) => {
      if (cleanupFailures.length) {
        receipt.passed = false;
        receipt.cleanupErrors = [...errors, ...cleanupFailures].map(redact);
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(receiptPath, `${redact(JSON.stringify(receipt, null, 2))}\n`, {
        mode: 0o600,
      });
      await chmod(receiptPath, 0o600);
    },
    closeContext: () => context.close(),
    closeBrowser: () => browser.close(),
  });
  errors.push(...finalizationErrors.map(redact));
}
if (receipt.error || errors.length)
  throw new Error([receipt.error, ...errors].filter(Boolean).map(redact).join("; "));
