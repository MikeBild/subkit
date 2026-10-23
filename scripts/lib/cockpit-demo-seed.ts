import { createHash } from "node:crypto";

export const cockpitDemoTenantSlug = "subkit-local-demo";
export const cockpitDemoSetupTenantName = "SubKit Local Demo";
export const cockpitDemoTenantName = "Brennwerk Logistik GmbH";
export const cockpitDemoOwnerName = "Lena Hoffmann";
export const cockpitDemoOwnerEmail = "lena@brennwerk.test";
export const cockpitDemoOwnerSql = `JOIN roles r ON r.id=u.role_id AND r.tenant_id IS NULL AND r.name='admin' WHERE t.slug='${cockpitDemoTenantSlug}' AND u.deleted_at IS NULL ORDER BY (u.email='${cockpitDemoOwnerEmail}') DESC, u.created_at, u.id`;

export const demoCategories = [
  {
    name: "demo",
    purpose: "Safe examples for trying out the workspace.",
    aliases: ["Examples", "Playground"],
  },
  {
    name: "sales",
    purpose: "Customers, orders and sales reports in one place.",
    aliases: ["Customers", "Orders", "CRM"],
  },
  {
    name: "operations",
    purpose: "Approvals, operating rules and incident handling.",
    aliases: ["Administration", "Ops"],
  },
];

export const demoFiles = [
  {
    filename: "Getting-started.md",
    contentType: "text/markdown",
    category: "demo",
    description: "Getting started with the Brennwerk workspace",
    content:
      "# Getting started\n\nAll records in this workspace are synthetic. Open lists and details, change filters, create a draft and review approvals. A reset restores this starting point.\n",
  },
  {
    filename: "Customer-contacts.csv",
    contentType: "text/csv",
    category: "sales",
    description: "Customer contacts export with long company names",
    content:
      "name,email,region\nJana Krüger,jana.krueger@nordhafen.example,Hamburg\nNordhafen Kühllogistik und internationale Speditionsdienste GmbH,dispo@nordhafen.example,München\n",
  },
  {
    filename: "Orders.json",
    contentType: "application/json",
    category: "sales",
    description: "Order export for preview and download",
    content: JSON.stringify(
      {
        orders: [
          { id: "demo-order-a", total: 149.5, currency: "EUR" },
          { id: "demo-order-b", total: 0, currency: "EUR" },
        ],
      },
      null,
      2,
    ),
  },
  {
    filename: "Approval-and-operating-rules.md",
    contentType: "text/markdown",
    category: "operations",
    description:
      "Approval rules for write operations, production changes and incident handling across the dispatch, warehouse and carrier systems",
    content:
      "# Approvals\n\nBefore a write run, review target, effect and environment. The demo API only processes synthetic data inside the local network.\n\n## Incidents\n\nThe status endpoint returns HTTP 503 on purpose.\n",
  },
  {
    filename: "Notes.txt",
    contentType: "text/plain",
    category: "demo",
    description: "Dispatch notes with special characters",
    content:
      "Delivery address: Grüne Straße 12, Köln – 日本語 – English\nMulti-line note for search, rendering and download.\n",
  },
];

export const demoTemplateConnectors = [
  {
    key: "connector-github",
    slug: "github-brennwerk",
    name: "GitHub",
    template: "github",
    templateName: "GitHub (REST)",
    baseUrl: "https://api.github.brennwerk.invalid",
    authType: "bearer",
    needsReauth: false,
    token: "demo-github-token-not-valid",
    category: "operations",
    description: "Issues and releases of the dispatch app. Demo address; it never reaches GitHub.",
  },
  {
    key: "connector-gmail",
    slug: "gmail-dispatch",
    name: "Gmail Disposition",
    template: "google-gmail",
    templateName: "Google Gmail",
    baseUrl: "https://gmail.brennwerk.invalid/gmail/v1",
    authType: "oauth2",
    needsReauth: false,
    token: null,
    category: "sales",
    description: "Mailbox of the dispatch team. Not signed in yet; demo address only.",
  },
  {
    key: "connector-slack",
    slug: "slack-ops",
    name: "Slack Leitstand",
    template: "slack",
    templateName: "Slack",
    baseUrl: "https://slack.brennwerk.invalid/api",
    authType: "bearer",
    needsReauth: false,
    token: "demo-slack-token-not-valid",
    category: "operations",
    description:
      "Posts run alerts to the control room channel. Demo address; it never reaches Slack.",
  },
  {
    key: "connector-hubspot",
    slug: "hubspot-crm",
    name: "HubSpot CRM",
    template: "hubspot",
    templateName: "HubSpot",
    baseUrl: "https://api.hubspot.brennwerk.invalid",
    authType: "bearer",
    needsReauth: true,
    token: "demo-hubspot-token-not-valid",
    category: "sales",
    description: "Deals and companies for key accounts. The demo token was revoked on purpose.",
  },
  {
    key: "connector-openai",
    slug: "openai-assistant",
    name: "OpenAI",
    template: "openai",
    templateName: "OpenAI",
    baseUrl: "http://demo-api:8080/v1",
    authType: "bearer",
    needsReauth: false,
    token: "demo-openai-token-not-valid",
    category: "operations",
    description: "AI answers for workflow steps. Served by the local demo API with fixed replies.",
  },
] as const;

export const workflowDescriptions = [
  "Copies new and changed contacts from the CRM into the customer list every hour.",
  "Collects revenue, carriers and key accounts per region into the weekly sales report.",
  "Checks open orders for missing prices and totals of zero.",
  "Sends the dispatch status to the warehouse. Each run needs an approval.",
  "Calls the carrier status page and reports when it fails.",
  "Draft: exports paid invoices for accounting.",
  "Archived: the old route planning, replaced by the carrier portal.",
  "Turns shipment data into the format of the tracking API.",
  "Counts customers per region for the sales meeting.",
  "Checks every delivery notice for a matching order.",
  "Draft: records returns and asks for the refund decision.",
  "Builds the monthly revenue report. The report structure changed recently.",
];

export const demoAiWorkflow = {
  slug: "demo-delivery-notice-summary",
  name: "Lieferavise zusammenfassen",
  description:
    "Liest offene Lieferavise und lässt die KI eine kurze Zusammenfassung für die Disposition schreiben.",
};

const HOUR_MS = 3_600_000;

export function demoAiRuns(now: Date): { key: string; startedAt: Date; tokens: number }[] {
  const week = 7 * 24;
  return [0.5, 0.75, 1].flatMap((hours, index) => [
    {
      key: `ai-run-now-${index}`,
      startedAt: new Date(now.getTime() - hours * HOUR_MS),
      tokens: 12_000,
    },
    {
      key: `ai-run-before-${index}`,
      startedAt: new Date(now.getTime() - (week + hours) * HOUR_MS),
      tokens: 4_000,
    },
  ]);
}

export interface DemoUsage {
  flow: string;
  model: string;
  prompt: number;
  completion: number;
  at: Date;
  person: boolean;
  run: string | null;
}

export const demoUnpricedModel = "mistral-medium-3";

export function demoExtraUsage(now: Date): DemoUsage[] {
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);
  return [
    ...demoAiRuns(now).map((run) => ({
      flow: "workflow_step",
      model: "gpt-5.6-sol",
      prompt: Math.round(run.tokens * 0.8),
      completion: Math.round(run.tokens * 0.2),
      at: new Date(run.startedAt.getTime() + 2_000),
      person: false,
      run: run.key,
    })),
    ...[1.2, 2.4, 3.6].map((hours) => ({
      flow: "summarize",
      model: demoUnpricedModel,
      prompt: 2_400,
      completion: 600,
      at: ago(hours),
      person: true,
      run: null,
    })),
    ...[1.5, 9, 20, 30].map((hours) => ({
      flow: "catalog_describe",
      model: "claude-haiku-4-5",
      prompt: 1_600,
      completion: 200,
      at: ago(hours),
      person: false,
      run: null,
    })),
  ];
}

export function demoMonthlyBudgetTokens(input: {
  usedTokens: number;
  lastSevenDaysTokens: number;
  now: Date;
}): number | null {
  const perDay = input.lastSevenDaysTokens / 7;
  if (perDay <= 0) return null;
  const monthEnd = new Date(input.now.getFullYear(), input.now.getMonth() + 1, 1);
  const remainingDays = (monthEnd.getTime() - input.now.getTime()) / 86_400_000;
  return Math.ceil(input.usedTokens + Math.max(perDay * remainingDays * 0.6, perDay * 0.25));
}

export interface DemoIntakeItem {
  key: string;
  origin: "capture" | "note" | "session";
  title: string;
  body: string;
  note: string;
  capturedAt: string;
  sourceUrl?: string;
  author?: string;
  agent?: string;
  sessionId?: string;
  domains?: string[];
  excerpt?: string;
}

export function demoIntakeItems(now: Date): DemoIntakeItem[] {
  const at = (hours: number) => new Date(now.getTime() - hours * HOUR_MS).toISOString();
  return [
    {
      key: "intake-capture-0",
      origin: "capture",
      title: "Neue Zollregeln für Sendungen in die Schweiz",
      body: "Ab dem nächsten Quartal brauchen Sendungen in die Schweiz eine elektronische Ausfuhranmeldung vor der Abholung. Spediteure lehnen Sendungen ohne Anmeldung am Tor ab.",
      note: "Für das Carrier-Handbuch prüfen.",
      capturedAt: at(5),
      sourceUrl: "https://zoll.example/news/ausfuhr-schweiz",
      author: "Zollnachrichten",
    },
    {
      key: "intake-capture-1",
      origin: "capture",
      title: "Carrier pickup windows change in winter",
      body: "From December, partner carriers pick up between 07:00 and 11:00 only. Late orders move to the next working day.",
      note: "",
      capturedAt: at(26),
      sourceUrl: "https://carrier-news.example/winter-pickup-windows",
      author: "Carrier Network News",
    },
    {
      key: "intake-capture-2",
      origin: "capture",
      title: "Retourenquote im Onlinehandel sinkt",
      body: "Eine Branchenumfrage zeigt, dass klare Größenangaben und Fotos die Retourenquote um bis zu ein Fünftel senken.",
      note: "Vielleicht relevant für den Retouren-Skill.",
      capturedAt: at(50),
      sourceUrl: "https://handel.example/studien/retourenquote",
    },
    {
      key: "intake-note-0",
      origin: "note",
      title: "Rückruf Nordhafen Kühllogistik",
      body: "Frau Krüger bittet bei Kühlware um eine Vorabinfo per E-Mail, sobald die Sendung das Lager verlässt.",
      note: "",
      capturedAt: at(3),
    },
    {
      key: "intake-session-0",
      origin: "session",
      title: "Status API: retry after HTTP 503 instead of failing the run",
      body: "The carrier status page answers HTTP 503 during its nightly maintenance. A single retry after 30 seconds avoids most failed health checks.",
      note: "",
      capturedAt: at(8),
      agent: "claude-code",
      sessionId: "demo-session-status-retry",
      domains: ["operations"],
      excerpt:
        "Observed three failed health checks between 02:00 and 02:10; each passed on the next try.",
    },
    {
      key: "intake-session-1",
      origin: "session",
      title: "Angebote immer mit Netto- und Bruttopreis nennen",
      body: "Kunden fragen bei Angeboten regelmäßig nach dem Bruttopreis. Antworten nennen künftig beide Preise und die Währung.",
      note: "",
      capturedAt: at(30),
      agent: "codex",
      sessionId: "demo-session-price-format",
      domains: ["sales"],
      excerpt: "Two customer replies asked for the gross price after an offer listed net only.",
    },
  ];
}

export const demoHistory = {
  skill: {
    key: "skill-0",
    bodies: [
      "# Working rule\n\nStart with the result. Keep answers short and name the next step at the end.",
      "# Working rule\n\nStart with the result in one sentence. Use a list for more than two points.\nName the next step at the end and who takes it.",
    ],
  },
  knowledge: {
    key: "knowledge-1",
    contents: [
      "# Approval policy\n\nEvery write run needs an approval for its environment.\n\n## Duration\nAn approval lasts 30 days.\n",
      "# Approval policy\n\nEvery write run needs an approval for its environment.\n\n## Duration\nAn approval lasts 14 days and ends early when the workflow changes its targets.\n\n## Production\nProduction approvals need a second person.\n",
    ],
  },
  file: {
    filename: "Approval-and-operating-rules.md",
    content:
      "# Approvals\n\nBefore a write run, review target, effect and environment. Production changes need a second person.\n\n## Incidents\n\nThe status endpoint returns HTTP 503 on purpose. Retry once before you escalate.\n",
  },
} as const;

export const demoStarterWorkflows: Record<string, string> = {
  "demo-httpbin-echo": "Sends a sample request to an echo service and shows the answer.",
  "demo-github-public-repos": "Lists public repositories of an organisation on GitHub.",
  "demo-open-meteo-weather": "Reads the weather forecast for the warehouse location.",
};

export function createCockpitDemoCatalogRepairSql(tenantId: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const tenant = quote(tenantId);
  const statements = [
    `UPDATE files f SET description=k.description, category='platform', description_source='human', category_source='human' FROM knowledge_sources k WHERE f.tenant_id=${tenant} AND k.tenant_id=f.tenant_id AND f.deleted_at IS NULL AND k.deleted_at IS NULL AND f.filename=k.slug || '.md' AND k.slug LIKE 'sk-ref-%' AND nullif(k.description,'') IS NOT NULL AND (f.description_source='llm' OR f.category_source='llm');`,
    ...Object.entries(demoStarterWorkflows).map(
      ([slug, description]) =>
        `UPDATE workflows SET description=${quote(description)}, category='demo', description_source='human', category_source='human' WHERE tenant_id=${tenant} AND slug=${quote(slug)} AND deleted_at IS NULL AND (description_source='llm' OR category_source='llm');`,
    ),
    `DELETE FROM catalog_categories c WHERE c.tenant_id=${tenant} AND c.name IN ('mock-category','sk') AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.tenant_id=c.tenant_id AND w.category=c.name AND w.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM connectors n WHERE n.tenant_id=c.tenant_id AND n.category=c.name AND n.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM knowledge_sources k WHERE k.tenant_id=c.tenant_id AND k.category=c.name AND k.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM skills s WHERE s.tenant_id=c.tenant_id AND s.category=c.name) AND NOT EXISTS (SELECT 1 FROM files f WHERE f.tenant_id=c.tenant_id AND f.category=c.name AND f.deleted_at IS NULL);`,
  ];
  return `BEGIN;\n${statements.join("\n")}\nCOMMIT;\n`;
}

export const cockpitDemoManifest = {
  connectors: 6 + demoTemplateConnectors.length,
  workflows: 13,
  executions: 30,
  intakeItems: 6,
  conversations: 8,
  knowledgeSources: 6,
  knowledgeChunks: 12,
  skills: 8,
  skillProposals: 6,
  additionalUsers: 3,
  auditEntries: 32,
  usageEntries: 37,
  files: demoFiles.length,
  categoryMetadata: demoCategories.length,
  limitations: [
    "Past runs and usage are synthetic.",
    "Approvals are not faked; local workflows can be approved manually.",
    "External OAuth, MCP and delivery services are not set up.",
    "Template connectors point at .invalid hosts with fake tokens; the OpenAI connector answers from the local demo API.",
  ],
};

export function cockpitDemoId(tenantId: string, name: string): string {
  const h = createHash("sha256").update(`cockpit-demo:${tenantId}:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createCockpitDemoSeedSql(tenantId: string, adminUserId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(tenantId) || !uuid.test(adminUserId))
    throw new Error("Demo seed requires UUID identities");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const id = (name: string) => cockpitDemoId(tenantId, name);
  const statements: string[] = [];
  const repairs: string[] = [
    `UPDATE tenants SET display_name=${quote(cockpitDemoTenantName)} WHERE id=${quote(tenantId)} AND slug=${quote(cockpitDemoTenantSlug)} AND display_name=${quote(cockpitDemoSetupTenantName)};`,
    `UPDATE users SET email=${quote(cockpitDemoOwnerEmail)} WHERE id=${quote(adminUserId)} AND tenant_id=${quote(tenantId)} AND (email LIKE '%@localhost.test' OR email='lena@brennwerk.example') AND NOT EXISTS (SELECT 1 FROM users other WHERE other.tenant_id=${quote(tenantId)} AND other.email=${quote(cockpitDemoOwnerEmail)});`,
    `UPDATE users SET display_name=${quote(cockpitDemoOwnerName)} WHERE id=${quote(adminUserId)} AND tenant_id=${quote(tenantId)} AND display_name IS NULL;`,
  ];
  for (const category of demoCategories) {
    repairs.push(
      `INSERT INTO catalog_categories (tenant_id,name,purpose,purpose_source,aliases) VALUES (${quote(tenantId)},${quote(category.name)},${quote(category.purpose)},'human',${quote(JSON.stringify(category.aliases))}::jsonb) ON CONFLICT (tenant_id,name) DO UPDATE SET purpose=EXCLUDED.purpose,purpose_source=EXCLUDED.purpose_source,aliases=EXCLUDED.aliases,purpose_pending=false,revision=catalog_categories.revision+1 WHERE catalog_categories.revision=1 AND catalog_categories.purpose IS NULL AND catalog_categories.purpose_source IS NULL AND catalog_categories.redirect_to IS NULL AND catalog_categories.aliases='[]'::jsonb;`,
    );
  }
  const insert = (table: string, row: Record<string, unknown>) => {
    const values = Object.values(row).map((value) =>
      value === null
        ? "NULL"
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : quote(typeof value === "string" ? value : JSON.stringify(value)),
    );
    if (
      typeof row.id === "string" &&
      typeof row.description === "string" &&
      row.description_source === "human"
    ) {
      repairs.push(
        `UPDATE ${table} SET description=${quote(row.description)}, description_source='human' WHERE tenant_id=${quote(tenantId)} AND id=${quote(row.id)} AND description_source='llm' AND (description=${quote(row.description)} OR description LIKE 'Mock description: %');`,
      );
    }
    statements.push(
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${values.join(",")}) ON CONFLICT DO NOTHING;`,
    );
  };
  const now = new Date();
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  const metadata = (category: string, description: string) => ({
    category,
    description,
    description_source: "human",
    category_source: "human",
  });
  const connectorNames = [
    "CRM contacts",
    "Sales reporting API",
    "Dispatch write API",
    "Status API",
    "Warehouse ERP",
    "Carrier tracking API",
  ];
  const connectorSlugs = [
    "crm-contacts",
    "sales-reporting-api",
    "dispatch-write-api",
    "status-api",
    "warehouse-erp",
    "carrier-tracking-api",
  ];
  const connectorDescriptions = [
    "Reads customer contacts from the local CRM sample service.",
    "Delivers order totals and the weekly sales figures.",
    "Sends dispatch updates to the warehouse; every write needs an approval.",
    "Checks the status page of the carrier network. It answers with HTTP 503 on purpose.",
    "Stock levels from the warehouse ERP. Switched off until the migration is done.",
    "Tracks shipments at the partner carrier. The access token has expired.",
  ];
  connectorNames.forEach((name, i) => {
    insert("connectors", {
      id: id(`connector-${i}`),
      tenant_id: tenantId,
      slug: connectorSlugs[i],
      display_name: name,
      driver: "http",
      base_url: "http://demo-api:8080",
      config: {},
      environment: "dev",
      auth_type: i === 5 ? "bearer" : "none",
      enabled: i !== 4,
      health_state: i === 5 ? "needs_reauth" : i === 3 ? "degraded" : "ok",
      health_reason: i === 3 ? "Status endpoint answers with HTTP 503" : null,
      needs_reauth: i === 5,
      auth_failed_reason: i === 5 ? "Access token expired" : null,
      ...metadata(i < 3 ? "sales" : "operations", connectorDescriptions[i] as string),
    });
  });
  for (const connector of demoTemplateConnectors) {
    insert("connectors", {
      id: id(connector.key),
      tenant_id: tenantId,
      slug: connector.slug,
      display_name: connector.name,
      driver: "http",
      base_url: connector.baseUrl,
      config: {},
      environment: "dev",
      auth_type: connector.authType,
      enabled: true,
      health_state: connector.needsReauth ? "needs_reauth" : "ok",
      health_reason: null,
      needs_reauth: connector.needsReauth,
      auth_failed_reason: connector.needsReauth ? "Access token was revoked by the provider" : null,
      template_slug: connector.template,
      template_name: connector.templateName,
      template_source: "builtin",
      template_version: 1,
      ...metadata(connector.category, connector.description),
    });
  }
  const workflowNames = [
    "CRM contact sync",
    "Weekly sales report for all regions, carriers and key accounts",
    "Order check",
    "Dispatch update",
    "Status API health check",
    "Invoice export",
    "Route planning",
    "Shipment data transform",
    "Customers by region",
    "Delivery notice check",
    "Returns intake",
    "Monthly revenue report",
  ];
  workflowNames.forEach((name, i) => {
    const draft = i === 5 || i === 10;
    const description = workflowDescriptions[i] as string;
    const connector = i === 4 ? 3 : i === 3 ? 2 : i % 2;
    const steps =
      i === 10
        ? []
        : i === 7
          ? [
              {
                id: "fetch-contacts",
                kind: "transform",
                language: "javascript",
                expression: "return input;",
              },
            ]
          : [
              {
                id: "fetch-contacts",
                kind: "request",
                connector_id: id(`connector-${connector}`),
                method: i === 3 ? "POST" : "GET",
                path: i === 4 ? "/fail" : i === 3 ? "/echo" : i % 2 ? "/report" : "/contacts",
                ...(i === 3
                  ? { body: { message: "Dispatch update from the demo workspace" } }
                  : {}),
              },
            ];
    insert("workflows", {
      id: id(`workflow-${i}`),
      tenant_id: tenantId,
      slug: `demo-workflow-${i}`,
      name,
      lifecycle: draft ? "draft" : i === 6 ? "archived" : "active",
      last_executed_at: i < 5 ? ago(i + 0.01) : null,
      health_state: i === 11 ? "degraded" : "ok",
      health_reason: i === 11 ? "Response structure changed; review the report step" : null,
      ...metadata(i < 4 ? "sales" : "operations", description),
    });
    insert("workflow_versions", {
      id: id(`version-${i}`),
      tenant_id: tenantId,
      workflow_id: id(`workflow-${i}`),
      version: 1,
      author_user_id: adminUserId,
      dag: { name, slug: `demo-workflow-${i}`, description, steps },
      note: "Initial version",
    });
    statements.push(
      `UPDATE workflows SET ${draft ? "draft_version_id" : "current_version_id"}=${quote(id(`version-${i}`))} WHERE tenant_id=${quote(tenantId)} AND id=${quote(id(`workflow-${i}`))};`,
    );
  });
  const aiDag = {
    name: demoAiWorkflow.name,
    slug: demoAiWorkflow.slug,
    description: demoAiWorkflow.description,
    steps: [
      {
        id: "read-notices",
        kind: "request",
        connector_id: id("connector-1"),
        method: "GET",
        path: "/orders",
      },
      {
        id: "ask-ai",
        kind: "request",
        connector_id: id("connector-openai"),
        method: "POST",
        path: "/chat/completions",
        side_effects: "read",
        body: {
          model: "gpt-5.6-sol",
          messages: [
            {
              role: "user",
              content:
                "Fasse die offenen Lieferavise in drei Sätzen zusammen. Summarize the open delivery notices in three sentences.",
            },
          ],
        },
      },
    ],
  };
  insert("workflows", {
    id: id("workflow-ai"),
    tenant_id: tenantId,
    slug: demoAiWorkflow.slug,
    name: demoAiWorkflow.name,
    lifecycle: "active",
    last_executed_at: ago(0.5),
    health_state: "ok",
    health_reason: null,
    ...metadata("operations", demoAiWorkflow.description),
  });
  insert("workflow_versions", {
    id: id("version-ai"),
    tenant_id: tenantId,
    workflow_id: id("workflow-ai"),
    version: 1,
    author_user_id: adminUserId,
    dag: aiDag,
    note: "Initial version",
  });
  statements.push(
    `UPDATE workflows SET current_version_id=${quote(id("version-ai"))} WHERE tenant_id=${quote(tenantId)} AND id=${quote(id("workflow-ai"))};`,
  );
  for (const run of demoAiRuns(now)) {
    insert("executions", {
      id: id(run.key),
      tenant_id: tenantId,
      workflow_id: id("workflow-ai"),
      workflow_version_id: id("version-ai"),
      status: "succeeded",
      request_source: "schedule",
      execution_mode: "dev",
      input: { demo: true },
      started_at: run.startedAt.toISOString(),
      finished_at: new Date(run.startedAt.getTime() + 4_000).toISOString(),
      created_at: run.startedAt.toISOString(),
      failure: null,
    });
  }
  for (const usage of demoExtraUsage(now)) {
    insert("llm_usage", {
      tenant_id: tenantId,
      flow: usage.flow,
      model: usage.model,
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      cache_read_tokens: 0,
      total_tokens: usage.prompt + usage.completion,
      latency_ms: 1_200,
      result: "success",
      actor_type: usage.person ? "user" : "system",
      user_id: usage.person ? adminUserId : null,
      execution_id: usage.run ? id(usage.run) : null,
      conversation_id: null,
      created_at: usage.at.toISOString(),
      month_bucket: usage.at.getUTCFullYear() * 100 + usage.at.getUTCMonth() + 1,
    });
  }
  demoIntakeItems(now).forEach((item) => {
    const snapshot =
      item.origin === "session"
        ? {
            title: item.title,
            captured_at: item.capturedAt,
            body: item.body,
            origin: "session",
            agent: item.agent,
            session_id: item.sessionId,
            repo: null,
            domains: item.domains,
            evidence_excerpt: item.excerpt,
            learning_kind: "practice",
            scope: "global",
          }
        : item.origin === "capture"
          ? {
              title: item.title,
              source_url: item.sourceUrl,
              ...(item.author ? { source_author: item.author } : {}),
              captured_at: item.capturedAt,
              body: item.body,
              origin: "capture",
            }
          : { title: item.title, captured_at: item.capturedAt, body: item.body, origin: "note" };
    insert("intake_items", {
      id: id(item.key),
      tenant_id: tenantId,
      client_request_id: id(`${item.key}-request`),
      original_snapshot: snapshot,
      title: item.title,
      body: item.body,
      note: item.note,
      state: "collected",
      collected_by_type: "user",
      collected_by_id: adminUserId,
      creation_request_digest: createHash("sha256")
        .update(`cockpit-demo:${item.key}`)
        .digest("hex"),
      category: "inbox",
      created_at: item.capturedAt,
      updated_at: item.capturedAt,
    });
  });
  for (let i = 0; i < 24; i++) {
    const wf = i % 5;
    const failed = wf === 4;
    const status = i === 22 ? "aborted" : i === 23 ? "timed_out" : failed ? "failed" : "succeeded";
    insert("executions", {
      id: id(`execution-${i}`),
      tenant_id: tenantId,
      workflow_id: id(`workflow-${wf}`),
      workflow_version_id: id(`version-${wf}`),
      status,
      request_source: i % 2 ? "ui" : "api",
      execution_mode: "dev",
      input: { demo: true },
      started_at: ago(i + 0.01),
      finished_at: ago(i),
      created_at: ago(i + 0.02),
      failure:
        status === "failed" || status === "timed_out"
          ? {
              step_id: "fetch-contacts",
              error_code: status === "timed_out" ? "TIMEOUT" : "HTTP_ERROR",
              error_message: "Status API answered with HTTP 503",
            }
          : null,
    });
    insert("execution_steps", {
      id: id(`step-${i}`),
      tenant_id: tenantId,
      execution_id: id(`execution-${i}`),
      step_key: "fetch-contacts",
      step_index: 0,
      kind: "request",
      status,
      input_preview: { demo: true },
      output_preview: failed
        ? null
        : { data: [{ id: "example", name: "Jana Krüger" }], synthetic: true },
      duration_ms: 125 + i * 17,
      started_at: ago(i + 0.01),
      finished_at: ago(i),
      error: failed
        ? { code: "HTTP_ERROR", message: "Status endpoint answered with HTTP 503" }
        : null,
    });
    insert("audit_log", {
      id: id(`audit-${i}`),
      tenant_id: tenantId,
      actor_type: i % 3 ? "user" : "system",
      actor_id: i % 3 ? adminUserId : null,
      action: i % 4 === 0 ? "workflow.created" : "execution.completed",
      resource_type: i % 4 === 0 ? "workflow" : "execution",
      resource_id: id(i % 4 === 0 ? `workflow-${wf}` : `execution-${i}`),
      result: failed ? "error" : "success",
      ts: ago(i),
      metadata: { source: "ui", synthetic: true },
      reason: "Synthetic demo record",
    });
    const created = new Date(ago(i * 7));
    const flow = ["converse", "workflow_step", "generate", "summarize", "judge"][i % 5];
    insert("llm_usage", {
      tenant_id: tenantId,
      flow,
      model: i % 2 ? "claude-haiku-4-5" : "gpt-5.6-sol",
      prompt_tokens: 1800 + i * 500,
      completion_tokens: 350 + i * 20,
      cache_read_tokens: i % 3 === 0 ? 900 : 0,
      total_tokens: 2150 + i * 520,
      latency_ms: 850 + i * 10,
      result: i === 7 ? "error" : "success",
      actor_type: "user",
      user_id: adminUserId,
      execution_id: flow === "workflow_step" ? id(`execution-${i}`) : null,
      conversation_id:
        flow === "converse" || flow === "generate" ? id(`conversation-${i % 7}`) : null,
      created_at: created.toISOString(),
      month_bucket: created.getUTCFullYear() * 100 + created.getUTCMonth() + 1,
    });
  }
  for (let i = 0; i < 7; i++) {
    insert("conversations", {
      id: id(`conversation-${i}`),
      tenant_id: tenantId,
      owner_id: adminUserId,
      status: i === 1 ? "awaiting_input" : i === 6 ? "abandoned" : "active",
      title: [
        "Getting started with Brennwerk",
        "Prepare the sales report",
        "Carrier comparison",
        "Review CRM contacts",
        "Invoice export draft",
        "Why did the status check fail?",
        "Old shipping question",
      ][i],
      surface: "cockpit",
      origin_client: "cockpit",
      turn_count: 1,
      created_at: ago(i),
      updated_at: ago(i),
    });
    for (const [j, text] of [
      "Show me how to get started with this workspace.",
      i === 1
        ? "Which period should the sales report cover?"
        : "This is a synthetic example conversation. You can keep asking here.\n\n| Task | Check |\n|---|---|\n| Open a list | Filter and sort |\n| Open details | Long names, umlauts and status |\n\nChanges stay in this demo workspace.",
    ].entries())
      insert("conversation_messages", {
        id: id(`message-${i}-${j}`),
        tenant_id: tenantId,
        conversation_id: id(`conversation-${i}`),
        role: j ? "assistant" : "user",
        content: { text },
        created_at: ago(i + (j ? 0 : 0.01)),
      });
  }
  insert("conversation_elicitations", {
    id: id("elicitation"),
    tenant_id: tenantId,
    conversation_id: id("conversation-1"),
    parent_message_id: id("message-1-1"),
    tool_name: "ask_user_form",
    summary: "Choose the sales report period",
    input: {
      question: "Which period should the sales report cover?",
      fields: [{ name: "period", label: "Period", type: "text", required: true }],
    },
    expires_at: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
  });
  insert("conversation_hidden", {
    tenant_id: tenantId,
    conversation_id: id("conversation-6"),
    user_id: adminUserId,
  });
  const knowledgeDescriptions = [
    "Signed framework contracts with carriers and key accounts.",
    "Who approves which write operation, and when an approval runs out.",
    "Answers for the customer service team about delivery times and claims.",
    "Price lists from previous years, kept for reference only.",
    "Handling rules for carriers: pickup windows, labels and hazardous goods.",
    "Tariff sheet import from the carrier portal. The last import failed.",
  ];
  for (let i = 0; i < 6; i++) {
    const name = [
      "Contract archive",
      "Approval policy",
      "Customer service FAQ for carriers, warehouses and key accounts in all regions",
      "Price list archive",
      "Carrier handbook",
      "Tariff sheet import",
    ][i] as string;
    const content = `# ${name}\n\nThis knowledge source contains synthetic demo content only.\n\n## Usage\nContacts and orders come from the local demo API. Write actions need a matching approval.\n`;
    insert("knowledge_sources", {
      id: id(`knowledge-${i}`),
      tenant_id: tenantId,
      name,
      slug: `demo-knowledge-${i}`,
      source_type: "text",
      source_uri: `text:demo-knowledge-${i}`,
      version: String(1 + (i === 1 ? demoHistory.knowledge.contents.length : 0)),
      status: i < 3 ? "active" : i === 3 ? "inactive" : i === 4 ? "processing" : "error",
      ...(i === 0 ? { created_at: ago(340), updated_at: ago(170) } : {}),
      last_error: i === 5 ? "Import failed: source document unavailable" : null,
      chunk_count: 2,
      bytes_total: Buffer.byteLength(content),
      ...metadata(i % 2 ? "operations" : "sales", knowledgeDescriptions[i] as string),
    });
    insert("knowledge_source_versions", {
      id: id(`knowledge-version-${i}`),
      tenant_id: tenantId,
      knowledge_source_id: id(`knowledge-${i}`),
      version: 1,
      content: { kind: "document", filename: `${name}.md`, mime: "text/markdown", text: content },
      content_hash: createHash("sha256").update(content).digest("hex"),
      author_user_id: adminUserId,
      ...(i === 0 ? { created_at: ago(338) } : i === 1 ? { created_at: ago(240) } : {}),
    });
    if (i === 1)
      demoHistory.knowledge.contents.forEach((text, index) => {
        insert("knowledge_source_versions", {
          id: id(`knowledge-version-${i}-${index + 2}`),
          tenant_id: tenantId,
          knowledge_source_id: id(`knowledge-${i}`),
          version: index + 2,
          content: { kind: "document", filename: `${name}.md`, mime: "text/markdown", text },
          content_hash: createHash("sha256").update(text).digest("hex"),
          author_user_id: index === 0 ? id("user-0") : adminUserId,
          note: index === 0 ? "Shorter approval duration" : "Second person for production",
          created_at: ago(index === 0 ? 120 : 20),
        });
      });
    for (let j = 0; j < 2; j++)
      insert("knowledge_chunks", {
        id: id(`chunk-${i}-${j}`),
        tenant_id: tenantId,
        knowledge_source_id: id(`knowledge-${i}`),
        ordinal: j,
        title: j ? "Usage" : name,
        content: `${content}\nSection ${j + 1}`,
        byte_size: Buffer.byteLength(content),
        fingerprint: createHash("sha256").update(`${content}:${j}`).digest("hex"),
      });
    insert("skill_candidates", {
      id: id(`candidate-${i}`),
      tenant_id: tenantId,
      scope: "global",
      pattern_kind: i % 2 ? "failure_pattern" : "success_pattern",
      title: [
        "Structure long answers and ask for all missing business details at once",
        "Use CRM contacts as the customer source",
        "Name concrete next steps after a failure",
        "Review write operations before running them",
        "Include shipment IDs in summaries",
        "Always answer in bullet lists",
      ][i],
      body: "Apply this rule the next time a matching task comes up.",
      evidence: {
        summary: "Observed in recent conversations",
        conversation_id: id("conversation-0"),
      },
      confidence: i % 2 ? "medium" : "high",
      status: i === 4 ? "approved" : i === 5 ? "rejected" : "proposed",
      fingerprint: `cockpit-demo-candidate-${i}`,
      proposed_by_user_id: adminUserId,
    });
  }
  const skillDescriptions = [
    "Short answers with the result first and the next step last.",
    "Name target, effect and environment before any write run.",
    "Use the CRM as the only source for customer contacts.",
    "Builds the contact report for the CRM contact sync workflow.",
    "How to escalate delays, missing customs papers and carrier disputes.",
    "Draft: how returns are booked and who confirms a refund.",
    "Archived: discount rules from the previous price list.",
    "Address formats for Germany, Switzerland and Austria.",
  ];
  for (let i = 0; i < 8; i++)
    insert("skills", {
      id: id(`skill-${i}`),
      tenant_id: tenantId,
      slug: `demo-skill-${i}`,
      scope: i === 2 ? "connector" : i === 3 ? "workflow" : "global",
      connector_id: i === 2 ? id("connector-0") : null,
      workflow_id: i === 3 ? id("workflow-0") : null,
      title: [
        "Summarize answers clearly",
        "Check approvals before writes",
        "Use CRM contacts",
        "Prepare the contact report",
        "Escalation rules for delayed shipments, missing customs documents and carrier disputes",
        "Returns handling",
        "Pricing rules",
        "Address formats for Köln, Zürich and Graz",
      ][i],
      body: "# Working rule\n\nUse only the existing synthetic demo data. Explain results clearly and ask for missing details. Approval limits stay in place.",
      lifecycle: i === 5 ? "draft" : i === 6 ? "archived" : "active",
      source: "manual",
      applies_to: i % 3 === 0 ? "chat" : i % 3 === 1 ? "authoring" : "both",
      ...metadata(i % 2 ? "operations" : "sales", skillDescriptions[i] as string),
    });
  insert("roles", {
    id: id("reviewer-role"),
    tenant_id: tenantId,
    name: "Dispatch reviewer",
    description: "Read access to workflows, connectors, runs and knowledge",
  });
  statements.push(
    `INSERT INTO role_permissions (role_id,permission_id) SELECT ${quote(id("reviewer-role"))},id FROM permissions WHERE name IN ('workflow:read','connector:read','execution:read','knowledge:read','skill:read') ON CONFLICT DO NOTHING;`,
  );
  insert("roles", {
    id: id("archive-editor-role"),
    tenant_id: tenantId,
    name: "Knowledge editor",
    description: "Maintains the contract archive",
  });
  statements.push(
    `INSERT INTO role_permissions (role_id,permission_id) SELECT ${quote(id("archive-editor-role"))},id FROM permissions WHERE name IN ('knowledge:read','knowledge:write','audit:read') ON CONFLICT DO NOTHING;`,
  );
  ["active", "invited", "disabled"].forEach((status, i) => {
    insert("users", {
      id: id(`user-${i}`),
      tenant_id: tenantId,
      email: ["jonas@brennwerk.example", "miriam@brennwerk.example", "tobias@brennwerk.example"][i],
      display_name: ["Jonas Weber", "Miriam Schulz", "Tobias Krüger"][i],
      role_id: id(i === 0 ? "archive-editor-role" : "reviewer-role"),
      status,
      created_at: ago(400),
    });
  });
  insert("api_keys", {
    id: id("audit-demo-key"),
    tenant_id: tenantId,
    user_id: id("user-0"),
    prefix: `demo${tenantId.replaceAll("-", "").slice(0, 12)}`,
    token_sha256: "0".repeat(64),
    credential_origin: "cli_oauth_session",
    name: "Jonas Weber CLI",
    scopes: ["*"],
    created_at: ago(300),
  });
  insert("conversations", {
    id: id("archive-conversation"),
    tenant_id: tenantId,
    owner_id: adminUserId,
    status: "committed",
    title: "Reactivate the contract archive",
    surface: "mcp",
    origin_client: "mcp",
    turn_count: 1,
    created_at: ago(171),
    updated_at: ago(170),
  });
  insert("conversation_messages", {
    id: id("archive-message"),
    tenant_id: tenantId,
    conversation_id: id("archive-conversation"),
    role: "user",
    content: { text: "Reactivate the contract archive." },
    created_at: ago(171),
  });
  insert("conversation_tool_calls", {
    id: id("archive-tool-call"),
    tenant_id: tenantId,
    conversation_id: id("archive-conversation"),
    parent_message_id: id("archive-message"),
    tool: "update_knowledge_source",
    input: { id: id("knowledge-0"), status: "active" },
    output: { updated: true, id: id("knowledge-0") },
    outcome: "success",
    created_at: ago(170),
  });
  const archiveEvents = [
    {
      action: "knowledge_source.created",
      actor: adminUserId,
      source: "ui",
      origin: "ui",
      execution: "ui",
      result: "success",
      hours: 340,
      before: null,
      after: { name: "Contract archive", status: "processing" },
    },
    {
      action: "knowledge_source.ingested",
      actor: null,
      source: "queue",
      origin: "ui",
      execution: "queue",
      result: "success",
      hours: 338,
      before: { name: "Contract archive", status: "processing" },
      after: { name: "Contract archive", status: "active" },
    },
    {
      action: "knowledge_source.updated",
      actor: id("user-0"),
      source: "api",
      origin: "api",
      execution: "api",
      result: "success",
      hours: 290,
      before: { name: "Contract archive", status: "active" },
      after: { name: "Contract archive", status: "inactive" },
    },
    {
      action: "knowledge_source.refreshed",
      actor: null,
      source: "queue",
      origin: "api",
      execution: "queue",
      result: "error",
      hours: 288,
      before: null,
      after: null,
    },
    {
      action: "knowledge_source.updated",
      actor: adminUserId,
      source: "chat",
      origin: "mcp",
      execution: "tool-chain",
      result: "success",
      hours: 170,
      before: { name: "Contract archive", status: "inactive" },
      after: { name: "Contract archive", status: "active" },
    },
    {
      action: "knowledge_source.analyzed",
      actor: null,
      source: "queue",
      origin: "mcp",
      execution: "queue",
      result: "success",
      hours: 168,
      before: null,
      after: null,
    },
    {
      action: "knowledge_source.updated",
      actor: id("user-1"),
      source: "api",
      origin: "api",
      execution: "api",
      result: "denied",
      hours: 20,
      before: null,
      after: null,
    },
  ] as const;
  archiveEvents.forEach((event, index) => {
    insert("audit_log", {
      id: id(`archive-audit-${index}`),
      tenant_id: tenantId,
      actor_type: event.actor ? "user" : "system",
      actor_id: event.actor,
      action: event.action,
      resource_type: "knowledge_source",
      resource_id: id("knowledge-0"),
      result: event.result,
      ts: ago(event.hours),
      trace_id: id(`archive-client-trace-${Math.floor(index / 2)}`).replaceAll("-", ""),
      before: event.before,
      after: event.after,
      metadata: {
        synthetic: true,
        request_source: event.source,
        origin_source: event.origin,
        execution_source: event.execution,
        audit_trace_id: id(`archive-trace-${Math.floor(index / 2)}`).replaceAll("-", ""),
        ...([4, 5].includes(index) ? { conversation_id: id("archive-conversation") } : {}),
        ...([2, 3].includes(index)
          ? {
              audit_used_api_key_id: id("audit-demo-key"),
              audit_access_type: "api_key",
              audit_credential_origin: "cli_oauth_session",
            }
          : {}),
      },
    });
  });
  insert("groups", {
    id: id("group"),
    tenant_id: tenantId,
    name: "Dispatch team",
    description: "Dispatch and customer service",
  });
  insert("group_members", { group_id: id("group"), user_id: id("user-0"), added_by: adminUserId });
  insert("group_role_assignments", { group_id: id("group"), role_id: id("reviewer-role") });
  insert("notification_rules", {
    id: id("notification-rule"),
    tenant_id: tenantId,
    name: "Failed run alerts",
    event_pattern: "execution.failed",
    severity: "warn",
    target_workspace_id: "local-demo",
    target_channel_id: "local-demo",
    active: false,
  });
  insert("audit_log", {
    id: id("seed-complete"),
    tenant_id: tenantId,
    actor_type: "user",
    actor_id: adminUserId,
    action: "demo.seeded",
    resource_type: "tenant",
    resource_id: tenantId,
    result: "success",
    metadata: cockpitDemoManifest,
  });
  const starterSlugs = ["demo-httpbin-echo", "demo-github-public-repos", "demo-open-meteo-weather"]
    .map(quote)
    .join(",");
  repairs.push(
    `UPDATE workflows w SET description=v.dag->>'description', description_source='human' FROM workflow_versions v WHERE w.tenant_id=${quote(tenantId)} AND v.tenant_id=w.tenant_id AND v.workflow_id=w.id AND v.id=w.current_version_id AND v.version=1 AND w.slug IN (${starterSlugs}) AND w.deleted_at IS NULL AND w.description_source='llm' AND nullif(v.dag->>'description','') IS NOT NULL AND (w.description LIKE 'Mock description: %' OR w.description=v.dag->>'description');`,
  );
  repairs.push(
    `UPDATE workflows w SET category='demo', category_source='human' FROM workflow_versions v WHERE w.tenant_id=${quote(tenantId)} AND v.tenant_id=w.tenant_id AND v.workflow_id=w.id AND v.id=w.current_version_id AND v.version=1 AND w.slug IN (${starterSlugs}) AND w.deleted_at IS NULL AND w.category_source='llm' AND w.category IN ('mock-category','other');`,
  );
  const workflowIds = workflowNames.map((_, i) => quote(id(`workflow-${i}`))).join(",");
  repairs.push(
    `UPDATE workflows w SET last_executed_at=(SELECT max(e.started_at) FROM executions e WHERE e.tenant_id=w.tenant_id AND e.workflow_id=w.id) WHERE w.tenant_id=${quote(tenantId)} AND w.id IN (${workflowIds}) AND w.last_executed_at IS NULL AND EXISTS (SELECT 1 FROM executions e WHERE e.tenant_id=w.tenant_id AND e.workflow_id=w.id AND e.started_at IS NOT NULL);`,
  );
  return `BEGIN;\nDO $cockpit_demo$ BEGIN\nPERFORM pg_advisory_xact_lock(hashtext('cockpit-demo'), hashtext(${quote(tenantId)}));\nIF NOT EXISTS (SELECT 1 FROM tenants WHERE id=${quote(tenantId)} AND slug=${quote(cockpitDemoTenantSlug)}) THEN RAISE EXCEPTION 'Refusing to seed a non-demo tenant'; END IF;\nIF NOT EXISTS (SELECT 1 FROM users WHERE id=${quote(adminUserId)} AND tenant_id=${quote(tenantId)}) THEN RAISE EXCEPTION 'Demo owner does not belong to tenant'; END IF;\n${repairs.join("\n")}\nIF EXISTS (SELECT 1 FROM audit_log WHERE id=${quote(id("seed-complete"))} AND tenant_id=${quote(tenantId)}) THEN RETURN; END IF;\n${statements.join("\n")}\nEND $cockpit_demo$;\nCOMMIT;\n`;
}
