import { createHash } from "node:crypto";

export const demoCategories = [
  {
    name: "demo",
    purpose: "Beispiele zum sicheren Ausprobieren der lokalen Installation.",
    aliases: ["Beispiele", "Übung"],
  },
  {
    name: "vertrieb",
    purpose: "Kunden, Bestellungen und Umsatzberichte gemeinsam bearbeiten.",
    aliases: ["Kunden", "Verkauf", "Sales"],
  },
  {
    name: "betrieb",
    purpose: "Freigaben, Betriebsregeln und die Bearbeitung von Fehlern.",
    aliases: ["Administration", "Operations"],
  },
];

export const demoFiles = [
  {
    filename: "Willkommen-im-lokalen-Cockpit.md",
    contentType: "text/markdown",
    category: "demo",
    description: "Einstieg und manuelle Testaufgaben",
    content:
      "# Lokales Cockpit\n\nAlle Beispieldaten sind synthetisch. Öffne Listen und Details, ändere Filter, erstelle einen Entwurf und prüfe Freigaben. Der Reset stellt diesen Ausgangszustand wieder her.\n",
  },
  {
    filename: "Kundenliste-mit-langen-Namen.csv",
    contentType: "text/csv",
    category: "vertrieb",
    description: "Kleine CSV-Datei mit Umlauten und langen Werten",
    content:
      "name,email,region\nAnna Beispiel,anna@example.test,Berlin\nBüro für nachhaltige Produktentwicklung und internationale Zusammenarbeit,team@example.test,München\n",
  },
  {
    filename: "Bestellungen.json",
    contentType: "application/json",
    category: "vertrieb",
    description: "Strukturierte Beispieldaten für Vorschau und Download",
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
    filename: "Freigabe-und-Betriebsregeln.md",
    contentType: "text/markdown",
    category: "betrieb",
    description:
      "Langer Titel und mehrzeilige Beschreibung zur manuellen Prüfung von Listen, Detailansichten und schmalen Fenstern",
    content:
      "# Freigaben\n\nVor einem schreibenden Lauf müssen Ziel, Wirkung und Umgebung geprüft werden. Die Demo-API verarbeitet ausschließlich synthetische Daten im lokalen Compose-Netz.\n\n## Fehler\n\nDer Fehler-Endpunkt liefert absichtlich HTTP 503.\n",
  },
  {
    filename: "Notizen.txt",
    contentType: "text/plain",
    category: "demo",
    description: "Einfacher Text mit Sonderzeichen",
    content:
      "Äpfel, Öl, Grüße – 日本語 – English\nMehrzeilige Notiz für Suche, Darstellung und Download.\n",
  },
];

export const cockpitDemoManifest = {
  connectors: 6,
  workflows: 12,
  executions: 24,
  conversations: 8,
  knowledgeSources: 6,
  knowledgeChunks: 12,
  skills: 8,
  skillProposals: 6,
  additionalUsers: 3,
  auditEntries: 32,
  usageEntries: 24,
  files: demoFiles.length,
  categoryMetadata: demoCategories.length,
  limitations: [
    "Historische Läufe und Verbrauch sind synthetisch.",
    "Freigaben werden nicht vorgetäuscht; lokale Workflows können manuell freigegeben werden.",
    "Externe OAuth-, MCP- und Versanddienste werden nicht eingerichtet.",
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
  const repairs: string[] = [];
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
    "Lokale Kontakte",
    "Bestellungen und Umsatzberichte",
    "Demo-Schreibziel",
    "Absichtlich gestörter Dienst",
    "Deaktivierte Verbindung",
    "Verbindung mit fehlender Anmeldung",
  ];
  connectorNames.forEach((name, i) => {
    insert("connectors", {
      id: id(`connector-${i}`),
      tenant_id: tenantId,
      slug: `demo-connector-${i}`,
      display_name: name,
      driver: "http",
      base_url: "http://demo-api:8080",
      config: {},
      environment: "dev",
      auth_type: i === 5 ? "bearer" : "none",
      enabled: i !== 4,
      health_state: i === 5 ? "needs_reauth" : i === 3 ? "degraded" : "ok",
      health_reason: i === 3 ? "Synthetischer HTTP-503-Fehler zur manuellen Fehlerprüfung" : null,
      needs_reauth: i === 5,
      auth_failed_reason: i === 5 ? "Synthetischer Anmeldefehler" : null,
      ...metadata(
        i < 3 ? "vertrieb" : "betrieb",
        "Lokaler Beispieldienst ohne externe Daten. Für manuelle Listen-, Detail- und Fehlerprüfungen.",
      ),
    });
  });
  const workflowNames = [
    "Kontakte lesen",
    "Umsatzbericht mit ausführlichem Namen für lange Tabellenzeilen und schmale Fenster",
    "Bestellungen prüfen",
    "Lokalen Schreibvorgang vorbereiten",
    "Absichtlich fehlschlagender Abruf",
    "Entwurf zur gemeinsamen Prüfung",
    "Deaktiviertes Beispiel",
    "Daten umwandeln",
    "Kunden nach Region sortieren",
    "Antwort mit Umlauten prüfen",
    "Leerer Entwurf",
    "Reparatur eines Berichts vorbereiten",
  ];
  workflowNames.forEach((name, i) => {
    const draft = i === 5 || i === 10;
    const connector = i === 4 ? 3 : i === 3 ? 2 : i % 2;
    const steps =
      i === 10
        ? []
        : i === 7
          ? [{ id: "demo", kind: "transform", language: "javascript", expression: "return input;" }]
          : [
              {
                id: "demo",
                kind: "request",
                connector_id: id(`connector-${connector}`),
                method: i === 3 ? "POST" : "GET",
                path: i === 4 ? "/fail" : i === 3 ? "/echo" : i % 2 ? "/report" : "/contacts",
                ...(i === 3 ? { body: { message: "Lokaler Demo-Schreibvorgang" } } : {}),
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
      health_reason: i === 11 ? "Synthetischer Reparaturfall: Antwortstruktur prüfen" : null,
      ...metadata(
        i < 4 ? "vertrieb" : "betrieb",
        "Synthetischer lokaler Workflow. Ausschließlich die lokale Demo-API wird verwendet; Freigaben können im Cockpit geprüft werden.",
      ),
    });
    insert("workflow_versions", {
      id: id(`version-${i}`),
      tenant_id: tenantId,
      workflow_id: id(`workflow-${i}`),
      version: 1,
      author_user_id: adminUserId,
      dag: { name, slug: `demo-workflow-${i}`, steps },
      note: "Lokaler Ausgangszustand für manuelle Tests",
    });
    statements.push(
      `UPDATE workflows SET ${draft ? "draft_version_id" : "current_version_id"}=${quote(id(`version-${i}`))} WHERE tenant_id=${quote(tenantId)} AND id=${quote(id(`workflow-${i}`))};`,
    );
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
              step_id: "demo",
              error_code: status === "timed_out" ? "TIMEOUT" : "HTTP_ERROR",
              error_message: "Synthetischer lokaler Fehler für die manuelle Detailprüfung",
            }
          : null,
    });
    insert("execution_steps", {
      id: id(`step-${i}`),
      tenant_id: tenantId,
      execution_id: id(`execution-${i}`),
      step_key: "demo",
      step_index: 0,
      kind: "request",
      status,
      input_preview: { demo: true },
      output_preview: failed
        ? null
        : { data: [{ id: "example", name: "Anna Beispiel" }], synthetic: true },
      duration_ms: 125 + i * 17,
      started_at: ago(i + 0.01),
      finished_at: ago(i),
      error: failed
        ? { code: "HTTP_ERROR", message: "Demo-Endpunkt liefert absichtlich HTTP 503" }
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
      reason: "Lokaler synthetischer Demodatensatz",
    });
    const created = new Date(ago(i * 7));
    insert("llm_usage", {
      tenant_id: tenantId,
      flow: ["converse", "generate", "judge", "summarize"][i % 4],
      model: i % 2 ? "claude-haiku-4-5" : "gpt-5.6-sol",
      prompt_tokens: 1800 + i * 500,
      completion_tokens: 350 + i * 20,
      total_tokens: 2150 + i * 520,
      latency_ms: 850 + i * 10,
      result: "ok",
      actor_type: "user",
      user_id: adminUserId,
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
        "Willkommen: Lokale Testdaten erkunden",
        "Bericht vorbereiten – eine Angabe fehlt",
        "Lange Antworten und Tabellen im Chat",
        "Kontakte gemeinsam untersuchen",
        "Entwurf ohne Veröffentlichung",
        "Fehlgeschlagenen Abruf verstehen",
        "Ausgeblendete Unterhaltung",
      ][i],
      surface: "cockpit",
      origin_client: "cockpit",
      turn_count: 1,
      created_at: ago(i),
      updated_at: ago(i),
    });
    for (const [j, text] of [
      "Bitte zeige mir, wie ich diesen lokalen Demofall ausprobieren kann.",
      i === 1
        ? "Für welchen Zeitraum soll ich den Bericht vorbereiten?"
        : "Dies ist eine synthetische Beispielunterhaltung. Du kannst hier weiterfragen.\n\n| Aufgabe | Prüfen |\n|---|---|\n| Liste öffnen | Filtern und sortieren |\n| Details ansehen | Lange Namen, Umlaute und Status |\n\nÄnderungen bleiben in der lokalen Testumgebung.",
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
    summary: "Zeitraum für den lokalen Bericht auswählen",
    input: {
      question: "Für welchen Zeitraum soll der Bericht vorbereitet werden?",
      fields: [{ name: "period", label: "Zeitraum", type: "text", required: true }],
    },
    expires_at: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
  });
  insert("conversation_hidden", {
    tenant_id: tenantId,
    conversation_id: id("conversation-6"),
    user_id: adminUserId,
  });
  for (let i = 0; i < 6; i++) {
    const name = [
      "Vertragsarchiv",
      "Freigaben und sichere Ausführung",
      "Kundenservice – Antworten auf häufige Fragen mit sehr langen Überschriften",
      "Inaktive Wissensquelle",
      "Quelle wird eingelesen",
      "Absichtlich fehlerhafte Quelle",
    ][i] as string;
    const content = `# ${name}\n\nDiese Wissensquelle enthält ausschließlich synthetische Demo-Inhalte.\n\n## Lokale Nutzung\nKontakte und Bestellungen stammen aus der lokalen Demo-API. Schreibende Aktionen benötigen eine passende Freigabe.\n`;
    insert("knowledge_sources", {
      id: id(`knowledge-${i}`),
      tenant_id: tenantId,
      name,
      slug: `demo-knowledge-${i}`,
      source_type: "text",
      source_uri: `text:demo-knowledge-${i}`,
      version: "1",
      status: i < 3 ? "active" : i === 3 ? "inactive" : i === 4 ? "processing" : "error",
      ...(i === 0 ? { created_at: ago(340), updated_at: ago(170) } : {}),
      last_error: i === 5 ? "Synthetischer Einlesefehler: Quelldokument nicht verfügbar" : null,
      chunk_count: 2,
      bytes_total: Buffer.byteLength(content),
      ...metadata(
        i % 2 ? "betrieb" : "demo",
        "Lokaler Text für Quellen, Abschnitte, Suche und Wissensdetails",
      ),
    });
    insert("knowledge_source_versions", {
      id: id(`knowledge-version-${i}`),
      tenant_id: tenantId,
      knowledge_source_id: id(`knowledge-${i}`),
      version: 1,
      content: { kind: "document", filename: `${name}.md`, mime: "text/markdown", text: content },
      content_hash: createHash("sha256").update(content).digest("hex"),
      author_user_id: adminUserId,
      ...(i === 0 ? { created_at: ago(338) } : {}),
    });
    for (let j = 0; j < 2; j++)
      insert("knowledge_chunks", {
        id: id(`chunk-${i}-${j}`),
        tenant_id: tenantId,
        knowledge_source_id: id(`knowledge-${i}`),
        ordinal: j,
        title: j ? "Lokale Nutzung" : name,
        content: `${content}\nAbschnitt ${j + 1}`,
        byte_size: Buffer.byteLength(content),
        fingerprint: createHash("sha256").update(`${content}:${j}`).digest("hex"),
      });
    insert("skill_candidates", {
      id: id(`candidate-${i}`),
      tenant_id: tenantId,
      scope: "global",
      pattern_kind: i % 2 ? "failure_pattern" : "success_pattern",
      title: [
        "Lange Antworten besser strukturieren und alle fehlenden fachlichen Angaben gemeinsam erfragen",
        "Lokale Kundendaten sind synthetisch",
        "Bei Fehlern konkrete nächste Schritte nennen",
        "Schreibvorgänge vor Ausführung prüfen",
        "Angenommener Vorschlag",
        "Verworfener Vorschlag",
      ][i],
      body: "Berücksichtige diese lokale Beispielregel beim nächsten passenden Vorgang. Sie dient der manuellen Prüfung von Übernehmen und Verwerfen.",
      evidence: { summary: "Synthetischer Mustervorschlag", conversation_id: id("conversation-0") },
      confidence: i % 2 ? "medium" : "high",
      status: i === 4 ? "approved" : i === 5 ? "rejected" : "proposed",
      fingerprint: `cockpit-demo-candidate-${i}`,
      proposed_by_user_id: adminUserId,
    });
  }
  for (let i = 0; i < 8; i++)
    insert("skills", {
      id: id(`skill-${i}`),
      tenant_id: tenantId,
      slug: `demo-skill-${i}`,
      scope: i === 2 ? "connector" : i === 3 ? "workflow" : "global",
      connector_id: i === 2 ? id("connector-0") : null,
      workflow_id: i === 3 ? id("workflow-0") : null,
      title: [
        "Antworten verständlich zusammenfassen",
        "Freigaben vor Schreibvorgängen prüfen",
        "Lokale Kontakte verwenden",
        "Kontaktbericht vorbereiten",
        "Sehr lange Skill-Bezeichnung zur Prüfung von Spaltenbreiten und überlappenden Bedienelementen",
        "Entwurf einer neuen Regel",
        "Archivierte Regel",
        "Mehrsprachige Antworten mit Ä, Ö und Ü",
      ][i],
      body: "# Lokale Beispielregel\n\nNutze ausschließlich die vorhandenen synthetischen Demodaten. Erkläre Ergebnisse verständlich und frage nach fehlenden Angaben. Freigabegrenzen bleiben erhalten.",
      lifecycle: i === 5 ? "draft" : i === 6 ? "archived" : "active",
      source: "manual",
      applies_to: i % 3 === 0 ? "chat" : i % 3 === 1 ? "authoring" : "both",
      ...metadata(
        i % 2 ? "betrieb" : "demo",
        "Beispielskill für Suche, Kategorien, Geltungsbereich und Bearbeitung",
      ),
    });
  insert("roles", {
    id: id("reviewer-role"),
    tenant_id: tenantId,
    name: "Demo-Prüfer",
    description: "Lokale Leserechte für die manuelle Rollenprüfung",
  });
  statements.push(
    `INSERT INTO role_permissions (role_id,permission_id) SELECT ${quote(id("reviewer-role"))},id FROM permissions WHERE name IN ('workflow:read','connector:read','execution:read','knowledge:read','skill:read') ON CONFLICT DO NOTHING;`,
  );
  insert("roles", {
    id: id("archive-editor-role"),
    tenant_id: tenantId,
    name: "Demo-Wissensbearbeiter",
    description: "Synthetische Bearbeitung des Vertragsarchivs",
  });
  statements.push(
    `INSERT INTO role_permissions (role_id,permission_id) SELECT ${quote(id("archive-editor-role"))},id FROM permissions WHERE name IN ('knowledge:read','knowledge:write','audit:read') ON CONFLICT DO NOTHING;`,
  );
  ["active", "invited", "disabled"].forEach((status, i) => {
    insert("users", {
      id: id(`user-${i}`),
      tenant_id: tenantId,
      email: ["anna@example.test", "ben@example.test", "carla@example.test"][i],
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
    name: "Lokaler Demo-Zugang",
    scopes: ["*"],
    created_at: ago(300),
  });
  insert("conversations", {
    id: id("archive-conversation"),
    tenant_id: tenantId,
    owner_id: adminUserId,
    status: "committed",
    title: "Vertragsarchiv wieder aktivieren",
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
    content: { text: "Aktiviere das synthetische Vertragsarchiv wieder." },
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
      after: { name: "Vertragsarchiv", status: "processing" },
    },
    {
      action: "knowledge_source.ingested",
      actor: null,
      source: "queue",
      origin: "ui",
      execution: "queue",
      result: "success",
      hours: 338,
      before: { name: "Vertragsarchiv", status: "processing" },
      after: { name: "Vertragsarchiv", status: "active" },
    },
    {
      action: "knowledge_source.updated",
      actor: id("user-0"),
      source: "api",
      origin: "api",
      execution: "api",
      result: "success",
      hours: 290,
      before: { name: "Vertragsarchiv", status: "active" },
      after: { name: "Vertragsarchiv", status: "inactive" },
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
      before: { name: "Vertragsarchiv", status: "inactive" },
      after: { name: "Vertragsarchiv", status: "active" },
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
    name: "Lokales Testteam",
    description: "Synthetische Personen und Rollen",
  });
  insert("group_members", { group_id: id("group"), user_id: id("user-0"), added_by: adminUserId });
  insert("group_role_assignments", { group_id: id("group"), role_id: id("reviewer-role") });
  insert("notification_rules", {
    id: id("notification-rule"),
    tenant_id: tenantId,
    name: "Demo-Fehlerhinweise (deaktiviert)",
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
  return `BEGIN;\nDO $cockpit_demo$ BEGIN\nPERFORM pg_advisory_xact_lock(hashtext('cockpit-demo'), hashtext(${quote(tenantId)}));\nIF NOT EXISTS (SELECT 1 FROM tenants WHERE id=${quote(tenantId)} AND slug='subkit-local-demo') THEN RAISE EXCEPTION 'Refusing to seed a non-demo tenant'; END IF;\nIF NOT EXISTS (SELECT 1 FROM users WHERE id=${quote(adminUserId)} AND tenant_id=${quote(tenantId)}) THEN RAISE EXCEPTION 'Demo owner does not belong to tenant'; END IF;\n${repairs.join("\n")}\nIF EXISTS (SELECT 1 FROM audit_log WHERE id=${quote(id("seed-complete"))} AND tenant_id=${quote(tenantId)}) THEN RETURN; END IF;\n${statements.join("\n")}\nEND $cockpit_demo$;\nCOMMIT;\n`;
}
