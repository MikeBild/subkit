import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cockpitDemoBaseUrl,
  cockpitDemoStateDirectory,
  resolveCockpitDemoInstance,
} from "./lib/cockpit-demo-instance.ts";

type Json = Record<string, unknown>;
const instance = resolveCockpitDemoInstance(process.env, process.cwd());
const base = cockpitDemoBaseUrl(
  instance,
  process.env.SUBKIT_DEMO_URL ?? process.env.SUBKIT_LOCAL_URL ?? instance.baseUrl,
);
if (process.argv.length > 2) throw new Error(`Unknown option: ${process.argv[2]}`);
const directory = cockpitDemoStateDirectory(instance, process.env.SUBKIT_DEMO_STATE_DIR);
const key = readFileSync(resolve(directory, "api-key.txt"), "utf8").trim();
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const suffix = randomUUID().slice(0, 8);
const label = `local-journey-${suffix}`;
const steps: Json[] = [];
const owned: { path: string; id: string }[] = [];
const output = resolve(directory, "local-functional-journey.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  steps.push({ assertion: message, passed: true });
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected JSON object");
  return value as Json;
}
function items(value: Json): Json[] {
  if (!Array.isArray(value.items)) throw new Error("Expected items array");
  return value.items.map(object);
}
async function request(path: string, method = "GET", body?: unknown, statuses = [200]) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: "error",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  steps.push({ method, path, status: response.status, passed: statuses.includes(response.status) });
  if (!statuses.includes(response.status))
    throw new Error(`${method} ${path}: HTTP ${response.status}: ${text.slice(0, 1200)}`);
  return text ? object(JSON.parse(text)) : {};
}
function own(path: string, value: Json) {
  if (typeof value.id !== "string") throw new Error("Created resource ID missing");
  owned.push({ path, id: value.id });
  return value.id;
}
async function main() {
  const tenants = items(await request("/v1/identity/tenants"));
  assert(
    tenants.length === 1 && tenants[0]?.slug === "subkit-local-demo",
    "Dedicated local demo tenant confirmed",
  );
  const connectors = items(await request("/v1/connectors"));
  const connector = connectors.find((row) => row.slug === "demo-connector-0");
  assert(
    connector?.base_url === "http://demo-api:8080",
    "Workflow target is the local fixture API",
  );

  const content = `# ${label}\n\nEin echter lokaler Datei-Rundlauf mit Umlauten: ÄÖÜ.\n`;
  const file = await request(
    "/v1/files/inline",
    "POST",
    {
      filename: `${label}.md`,
      content_type: "text/markdown",
      content_base64: Buffer.from(content).toString("base64"),
    },
    [200, 201],
  );
  const fileId = own("/v1/files", file);
  const download = await fetch(new URL(`/v1/files/${fileId}/content`, base), {
    headers,
    redirect: "error",
  });
  assert(
    download.ok && (await download.text()) === content,
    "Uploaded file bytes downloaded unchanged",
  );
  await request(`/v1/files/${fileId}`, "PATCH", {
    description: `${label} edited`,
    category: "demo",
  });
  assert(
    (await request(`/v1/files/${fileId}`)).description === `${label} edited`,
    "File metadata edit persisted",
  );

  const source = await request(
    "/v1/knowledge-sources/inline",
    "POST",
    {
      name: label,
      slug: label,
      description: "Disposable local functional journey",
      category: "demo",
      content,
      mime_type: "text/markdown",
    },
    [201],
  );
  const sourceId = own("/v1/knowledge-sources", source);
  if (typeof source.file_id === "string" && source.file_id !== fileId)
    owned.push({ path: "/v1/files", id: source.file_id });
  const chunks = await request(`/v1/knowledge-sources/${sourceId}/chunks`);
  assert(
    items(chunks).some((chunk) => String(chunk.content).includes(label)),
    "Knowledge source sections contain uploaded text",
  );
  await request(`/v1/knowledge-sources/${sourceId}`, "PATCH", {
    name: `${label} edited`,
    status: "inactive",
  });
  const editedSource = await request(`/v1/knowledge-sources/${sourceId}`);
  assert(
    editedSource.status === "inactive" && editedSource.name === `${label} edited`,
    "Knowledge edit and deactivation persisted",
  );

  const skill = await request(
    "/v1/skills",
    "POST",
    {
      scope: "global",
      title: label,
      body: "Temporäre lokale Regel: erkläre ausschließlich synthetische Demodaten.",
      description: "Disposable local functional journey",
      category: "demo",
      status: "draft",
      applies_to: "chat",
    },
    [201],
  );
  const skillId = own("/v1/skills", skill);
  await request(`/v1/skills/${skillId}`, "PATCH", { title: `${label} edited` });
  await request(`/v1/skills/${skillId}/activate`, "POST");
  const activeSkill = await request(`/v1/skills/${skillId}`);
  assert(
    activeSkill.status === "active" && activeSkill.title === `${label} edited`,
    "Skill edit and activation persisted",
  );
  await request(`/v1/skills/${skillId}/archive`, "POST");
  assert(
    (await request(`/v1/skills/${skillId}`)).status === "archived",
    "Skill archival persisted",
  );

  const definition = {
    name: label,
    slug: label,
    description: "Disposable read-only local contacts journey",
    category: "demo",
    input_schema: { type: "object" },
    steps: [
      {
        id: "contacts",
        kind: "request",
        connector_id: connector.id,
        method: "GET",
        path: "/contacts",
      },
    ],
  };
  assert(
    (await request("/v1/workflows/validate", "POST", definition)).ok === true,
    "Local workflow definition validates",
  );
  const workflow = await request("/v1/workflows", "POST", definition, [201]);
  const workflowId = own("/v1/workflows", workflow);
  const detail = await request(`/v1/workflows/${workflowId}`);
  const versionId =
    detail.current_version_id ?? detail.prepared_version_id ?? detail.draft_version_id;
  assert(typeof versionId === "string", "Created workflow exposes its persisted version");
  const preview = await request(
    `/v1/workflows/${workflowId}/versions/${versionId}/authority-preview?environment=dev`,
  );
  const prepared = await request("/v1/executions", "POST", {
    source: "saved",
    workflow_id: workflowId,
    version_id: versionId,
    input: {},
    hold_writes: true,
  });
  assert(
    prepared.status === "succeeded" && prepared.hold_writes === true,
    "Held-write preparation executes the local read successfully",
  );
  await request(`/v1/executions/${prepared.execution_id}`);
  const runSteps = await request(`/v1/executions/${prepared.execution_id}/steps`);
  assert(JSON.stringify(runSteps).includes("contacts"), "Real execution exposes the contacts step");
  const grant = await request(
    `/v1/workflows/${workflowId}/execution-authorities`,
    "POST",
    {
      workflow_version_id: versionId,
      expected_manifest_digest: preview.digest,
      execution_environment: "dev",
      valid_from: new Date().toISOString(),
      max_runs: 1,
    },
    [403],
  );
  assert(
    JSON.stringify(grant).includes("human"),
    "API-key credential cannot grant human execution authority",
  );
  await request(
    "/v1/executions",
    "POST",
    {
      source: "saved",
      workflow_id: workflowId,
      version_id: versionId,
      input: {},
      hold_writes: false,
    },
    [409],
  );
  assert(
    items(await request(`/v1/workflows/${workflowId}/execution-authorities`)).length === 0,
    "Refused grant creates no authority",
  );
}

let failure: string | undefined;
try {
  await main();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  for (const resource of owned.reverse()) {
    try {
      await request(`${resource.path}/${resource.id}`, "DELETE", undefined, [200, 204]);
    } catch (error) {
      failure ??= `Cleanup: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  let installation: unknown;
  try {
    const receipt = JSON.parse(readFileSync(resolve(directory, "receipt.json"), "utf8"));
    installation = { image: receipt.image, source: receipt.source, checkedAt: receipt.checkedAt };
  } catch {
    installation = { attribution: "receipt unavailable" };
  }
  writeFileSync(
    output,
    `${JSON.stringify({ checkedAt: new Date().toISOString(), base: base.origin, installation, label, passed: !failure, failure, steps, exclusions: ["No chat/model generation", "No visual assertions/screenshots", "Human grant and authorized live execution require browser-use acceptance"] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(output, 0o600);
}
if (failure) {
  process.stderr.write(`${failure}\nEvidence: ${output}\n`);
  process.exitCode = 1;
} else
  process.stdout.write(
    `Local functional journey passed (${steps.length} checks). Evidence: ${output}\n`,
  );
