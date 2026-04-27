# End-to-End Sequenzdiagramme — Kunden-Pipeline

## Kontext

Dieses Dokument beschreibt die komplette Kundenreise durch die subkit-Pipeline — vom Prompt bis zur Ausführung — als eine Sammlung von Mermaid-Sequenzdiagrammen, gruppiert nach Anwendungsfall. Es existiert, weil das System viele bewegliche Teile hat (HTTP-/MCP-/CLI-Oberflächen, Conversation Loop, LLM-Kontextaufbau, Tool-Policies, Drafts, Persistenz, Executions, Driver, Self-Healing, Audit, Notifications) und es kein einzelnes Bild gibt, das alles zusammenführt.

Die Diagramme sind **deskriptiv für den aktuellen Code** (reine Recherche, keine Änderungen). Wo ein Pfad sich verzweigt (Genehmigung, Drift-Reparatur, Quota), wird der Branch explizit gezeigt.

---

## Akteure & Systeme (Legende)

| Akteur | Was er ist | Wo er lebt |
|---|---|---|
| **User** | Menschlicher Kunde (oder Operator) | Browser, Terminal, MCP-Client |
| **CLI** | `sk` Ink-REPL | `apps/sk/src/{ink-app.tsx,ink-repl.ts,engine-client.ts}` |
| **HTTP** | Hono-Routen (Auth, RBAC) | `apps/engine/src/http/routes/*` |
| **MCP** | MCP-Capabilities | `apps/engine/src/mcp/capabilities/*` |
| **Loop** | Conversation-Runtime | `apps/engine/src/conversations/loop.ts` |
| **Ctx** | LLM-Kontext-Assembler | `apps/engine/src/llm/core/context-assembler.ts`, `runtime-context.ts`, `tenant-summary.ts` |
| **Tools** | Tool-Registry + Wrapper | `apps/engine/src/conversations/tools/{index.ts,sdk-wrap.ts,*.ts}` |
| **Policy** | Tool-Policy-Resolver | `apps/engine/src/conversations/tool-policies.ts` |
| **Draft** | Draft-Snapshots | `apps/engine/src/conversations/draft.ts`, `persistence/*` |
| **LLM** | Anthropic-Provider | `apps/engine/src/llm/core/invoke.ts`, Provider |
| **Engine** | Workflow-Execution-Engine | `apps/engine/src/execution/{engine.ts,state.ts,steps/*,pagination.ts,offload.ts}` |
| **Driver** | Connector-Driver | `apps/engine/src/connectors/drivers/{http,graphql,postgres,s3}.ts` |
| **Heal** | Self-Healing | `apps/engine/src/self-healing/{service.ts,drift-detector.ts,classifier.ts,fixture-runner.ts,policy.ts}` |
| **Audit** | Append-Only-Audit | `apps/engine/src/audit/{audit.ts,recorders/*,types.ts}` |
| **Outbox** | Transaktionale Outbox + LISTEN/NOTIFY | `apps/engine/src/db/events.ts`, Listener-Prozess |
| **Notify** | Notifications & Webhooks | `apps/engine/src/notifications/*`, `webhooks/outbound/delivery-worker.ts` |
| **DB** | PostgreSQL | Tabellen pro Nachricht angegeben |
| **External** | Kunden-API / SaaS | über HTTPS |

---

## Übersicht (zusammengefasste End-to-End-Sicht)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant Surf as "CLI / HTTP / MCP"
  participant LP as "Conversation Loop"
  participant Ctx as "Kontext-Assembler"
  participant LLM as "LLM (Anthropic)"
  participant Tools as "Tool-Wrapper"
  participant DB as PostgreSQL
  participant Eng as "Execution Engine"
  participant Drv as Driver
  participant Ext as "Externes API"
  participant Heal as "Self-Healing"
  participant Out as "Outbox / Notify"

  U->>Surf: Prompt "erstelle einen HubSpot-Connector und fuehre ihn aus"
  Surf->>LP: runLoop tenant, actor, message, permission_mode
  LP->>DB: INSERT conversation_messages user
  LP->>Ctx: assembleEnhancedPrompt draft, skills, runtime, tenant snapshot
  Ctx->>DB: SELECT skills, workflows, connectors, drafts, failures
  Ctx-->>LP: stable head + volatile tail Cache-Split
  LP->>LLM: streamText system, messages, tools
  LLM-->>LP: tool_call propose_step or probe_connector_draft
  LP->>Tools: wrap tool execute input
  Tools->>DB: INSERT conversation_tool_calls
  alt policy = confirm_before_execution
    Tools->>DB: INSERT conversation_elicitations
    Tools-->>LP: pause
    LP-->>Surf: events + status awaiting_input
    U->>Surf: Bestaetigung
    Surf->>LP: respondElicitation - runLoop resume
  end
  Tools->>DB: INSERT conversation_drafts Snapshot
  LLM-->>LP: tool_call commit_draft
  Tools->>DB: UPSERT connectors, workflows
  LP-->>Surf: status committed, committed_workflow_id
  U->>Surf: POST /v1/executions workflow_id
  Surf->>Eng: runExecution input, options
  Eng->>DB: INSERT executions queued then UPDATE running
  loop pro Step
    Eng->>Drv: runRequestStep plan
    Drv->>Ext: HTTPS-Request Auth angewandt, Egress geprueft
    Ext-->>Drv: Response
    Drv-->>Eng: StepResult status, output, retry_count
    Eng->>DB: finalize execution_steps + maybeOffload
  end
  Eng->>DB: finalize executions
  Eng->>Out: writeEvent execution.succeeded or failed
  alt failed
    Out->>Heal: Repair-Job dispatchen
    Heal->>LLM: Repair-Flow - PatchProposal
    Heal->>DB: INSERT patch_candidates proposed or auto_applied
  end
  Out->>Notify: dispatchEvent - Channel-Adapter, Webhooks
  Notify-->>U: Slack, Webhook, E-Mail
  Surf-->>U: SSE-Frames - finales RunResult
```

Das ist das Rückgrat. Die folgenden Abschnitte zerlegen jedes Segment in den Detailgrad, den Implementierende benötigen.

---

## Anwendungsfall 1 — Conversation: Prompt → Kontext → Tool → Draft

Wie eine einzelne User-Nachricht zu einem LLM-Turn wird, inklusive Kontextaufbau und einem draft-mutierenden Tool-Call (noch keine externe Schreiboperation).

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant H as "HTTP-Route conversations.ts"
  participant S as "Service service.ts"
  participant LP as "Loop loop.ts"
  participant I as "Intent intent-detector.ts"
  participant K as "Context context-assembler.ts"
  participant Sk as "Skills skills/service.ts"
  participant TS as "Tenant Summary tenant-summary.ts"
  participant LLM as "LLM-Provider"
  participant W as "Tool-Wrapper sdk-wrap.ts"
  participant P as "Policy tool-policies.ts"
  participant T as "Tool z.B. propose_step"
  participant D as "Draft draft.ts persistence"
  participant DB as PostgreSQL
  participant A as Audit

  U->>H: POST /v1/conversations message, permission_mode, runtime_context
  H->>H: requireAuth + Principal-Resolution
  H->>S: createConversation params
  S->>DB: INSERT conversations status=active, draft=empty
  S->>A: CONVERSATION_CREATED
  S->>LP: runLoop conversation_id, user_message

  Note over LP: Phase 1 - Append + Intent
  LP->>DB: INSERT conversation_messages role=user
  LP->>I: detectUserIntent text
  I-->>LP: forceTool, forceNoTools, startNewWorkflow

  Note over LP,K: Phase 2 - Kontextaufbau
  LP->>DB: SELECT loaded_skills, draft, attachments
  LP->>K: detectIntentSkills mimes, text, hasFailedExecution
  K->>DB: SELECT skills WHERE trigger_keywords ILIKE
  LP->>K: assembleEnhancedPrompt draft, skills, runtime, prior_failures
  K->>TS: renderTenantSummaryBlock
  TS->>DB: SELECT workflows max 40, connectors max 40
  K->>K: renderRuntimeContextBlock engine_url, actor, surface
  K->>DB: SELECT connectorEndpointSchemas Doc-Analysis-Summary
  K->>DB: SELECT conversation_tool_calls ok=false letzte 8 + draft warnings letzte 10
  K-->>LP: AssembledContext stable_head, volatile_tail, budget_report

  Note over LP: Phase 3 - Budget-Gate
  LP->>DB: SELECT llm_monthly_token_budget; SUM llm_usage.total_tokens
  LP->>LP: checkBudget, checkAndDecrement

  Note over LP,LLM: Phase 4 - streamText mit gecachten System-Bloecken
  LP->>LLM: streamText system stable+volatile, messages, tools, toolChoice
  LLM-->>W: tool_call propose_step, args

  Note over W: Phase 5 - wrap, policy, execute
  W->>W: Prerequisite-Skill-Gate
  W->>DB: INSERT conversation_tool_calls input
  W->>P: resolveToolMode tool, category, input, overrides, permission_mode
  P-->>W: no_confirm draft_write
  W->>T: execute args
  T->>D: ctx.setDraft next withWorkflowStep
  D->>DB: INSERT conversation_drafts snapshot, version+1
  T->>A: AUDIT tool-spezifisch
  T-->>W: ok=true, data
  W->>DB: UPDATE conversation_tool_calls output
  W-->>LLM: tool_result

  Note over LP: Phase 6 - onStepFinish
  LLM-->>LP: Step beendet Usage
  LP->>DB: INSERT llm_usage pro Step
  LP->>DB: INSERT conversation_messages role=assistant, text
  LP->>DB: UPDATE parent_message_id auf pending tool_calls, elicitations
  LP-->>S: RunLoopResult events, status=active
  S-->>H: events + status
  H-->>U: SSE-Frames
```

**Wichtige Code-Referenzen**

- HTTP-Eintritt: `apps/engine/src/http/routes/conversations.ts:229-300`
- Service create/append: `apps/engine/src/conversations/service.ts:144-376`
- Loop-Body: `apps/engine/src/conversations/loop.ts:229-1167`
- Intent: `apps/engine/src/conversations/intent-detector.ts`
- Kontextaufbau: `apps/engine/src/llm/core/context-assembler.ts:194-540`
- Tenant Snapshot: `apps/engine/src/llm/core/tenant-summary.ts:41-101`
- Runtime Context: `apps/engine/src/llm/runtime-context.ts:14-81`
- Wrapper: `apps/engine/src/conversations/tools/sdk-wrap.ts:150-468`
- Policy-Resolver: `apps/engine/src/conversations/tool-policies.ts:194-452`

---

## Anwendungsfall 2 — Genehmigung / Elicitation Pause-Resume (tenant_write)

Wenn das LLM einen Schreibvorgang vorschlägt, den die Policy als `confirm_before_execution` markiert, erstellt die Loop eine Elicitation, hält an, präsentiert dem User eine strukturierte Rückfrage und nimmt nach der Antwort wieder auf — optional mit Auto-Persist über den Harness.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant H as "HTTP / MCP"
  participant LP as Loop
  participant W as "Tool-Wrapper"
  participant P as Policy
  participant DB as PostgreSQL
  participant AP as "auto-persist.ts"
  participant A as Audit

  Note over LP,W: streamText laeuft, LLM emittiert tenant_write Tool-Call
  LP->>W: execute save_connector_draft, config api_key
  W->>P: resolveToolMode
  P->>P: Inline-Credential-Safeguard config.api_key non-empty
  P-->>W: confirm_before_execution
  W->>DB: INSERT conversation_tool_calls approval_required=true
  W->>DB: INSERT conversation_elicitations tool_name=ask_user_confirm, input.kind=external_write, pending_output
  W->>A: APPROVAL_REQUESTED
  W->>LP: signals.pendingElicitation
  W-->>LP: ok=false, pause=true
  LP->>LP: pausedStopCondition feuert
  LP-->>H: RunLoopResult status=awaiting_input, pending_elicitation_id
  H-->>U: SSE elicit_request + completed

  U->>H: POST /v1/conversations id elicitations eid respond, output confirmed=true, commit_intent kind=save_connector_draft
  H->>LP: respondElicitation
  LP->>DB: UPDATE conversation_elicitations status=resolved, output, decided_at
  LP->>DB: UPDATE conversation_tool_calls.interaction_log state proposed - confirmed
  LP->>AP: maybeAutoPersistFromElicitation elicitation
  alt commit_intent.kind = save_connector_draft
    AP->>DB: saveConnectorAtomic tenant, draft - connectors UPSERT
    AP->>DB: INSERT synthetisches conversation_tool_calls source=harness_auto_persist
    AP->>A: CONNECTOR_SAVED
  end
  LP->>LP: runLoop user_message=null, resume
  LP-->>H: events + status active or committed or awaiting_input
  H-->>U: SSE
```

**Verzweigungen**
- `output.confirmed === false` → State `declined`, kein Auto-Persist, ein synthetisches Decline-Tool-Result wird injiziert, damit das LLM weiterläuft.
- Neue Elicitation kommt, während eine andere noch offen ist → die vorherige wird *superseded*; die alte tool_call-Output wird mit `{ok:false, abandoned:true, reason:"elicitation_superseded"}` rückgefüllt (`elicitations.ts:79-115`).
- `permission_mode=yolo` → Policy kürzt alle Confirms ab (Inline-Credential-Safeguard bleibt aktiv).

**Wichtige Code-Referenzen**
- Policy-Resolution-Stack: `apps/engine/src/conversations/tool-policies.ts:407-452`
- Pre-Execution-Confirm-Gate: `apps/engine/src/conversations/tools/sdk-wrap.ts:362-468`
- Pause Stop-Condition: `apps/engine/src/conversations/loop.ts:169-182`
- Elicitation auflösen + Transition + Auto-Persist: `apps/engine/src/conversations/service.ts:378-end`
- Auto-Persist-Dispatch: `apps/engine/src/conversations/persistence/auto-persist.ts`

---

## Anwendungsfall 3 — Commit: Draft → Tenant-Write (CRUD)

Die `commit_draft`-Familie persistiert den Draft in echte `connectors`-/`workflows`-Zeilen mit standardmäßiger expliziter Bestätigung und setzt den Conversation-Status auf `committed`.

```mermaid
sequenceDiagram
  autonumber
  participant LP as Loop
  participant W as "Tool-Wrapper"
  participant T as "commit_draft Tool"
  participant SC as "save-connector.ts"
  participant DB as PostgreSQL
  participant A as Audit
  participant Ev as Outbox

  LP->>W: execute commit_draft, target=connector or workflow
  W->>W: Policy - confirm_before_execution tenant_write
  Note over W: User bestaetigt via Anwendungsfall 2
  W->>T: execute args, draft
  alt target = connector
    T->>SC: saveConnectorAtomic tenant, draft.connector
    SC->>DB: BEGIN
    SC->>DB: UPSERT connectors Slug-Eindeutigkeit, Tenant-Scope
    SC->>DB: UPSERT credentials verlinkt mit Connector
    SC->>DB: INSERT connector_versions immutable
    SC->>DB: writeEvent connector.committed, payload
    SC->>A: CONNECTOR_COMMITTED
    SC->>DB: COMMIT
  else target = workflow
    T->>DB: BEGIN
    T->>DB: UPSERT workflows
    T->>DB: INSERT workflow_versions version+1, dag
    T->>DB: writeEvent workflow.committed, payload
    T->>A: WORKFLOW_COMMITTED
    T->>DB: COMMIT
  end
  T-->>W: ok=true, committed_workflow_id or connector_id
  W-->>LP: tool_result
  LP->>LP: signals.committed=true
  LP->>LP: committedStopCondition feuert
  LP-->>LP: status=committed
  Ev-->>Ev: LISTEN workflow.chain - Fanout Notifications, Indexer
```

**Wichtige Code-Referenzen**
- Commit-Tool: `apps/engine/src/conversations/tools/commit-draft.ts` (oder ähnlich; in `tools/index.ts:196-301`)
- Atomares Speichern: `apps/engine/src/conversations/persistence/save-connector.ts`
- Outbox: `apps/engine/src/db/events.ts`
- Stop-Condition: `apps/engine/src/conversations/loop.ts:142-161`

---

## Anwendungsfall 4 — Execution: Workflow-Lauf End-to-End (Request-Driver)

POST → enqueue → runExecution → Driver-Call pro Step mit Retries, Pagination, Offload, Audit und finalem Status.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant H as "HTTP-Route executions.ts"
  participant RB as "RBAC evaluator.ts"
  participant E as "Engine engine.ts"
  participant St as "Step-Runner request.ts"
  participant Cr as Credentials
  participant Eg as "Egress-Guard"
  participant Drv as "HTTP-Driver"
  participant Pg as "Pagination"
  participant Of as "Offload"
  participant Ext as "Externes API"
  participant DB as PostgreSQL
  participant A as Audit
  participant Ev as Outbox

  U->>H: POST /v1/executions workflow_id or draft, input, mode
  H->>RB: can tenant, principal, workflow:run, workflow_id
  RB->>DB: resource_grants - groups - role_permissions - portal_token allowlist
  RB-->>H: Decision allow, source
  alt deny
    H-->>U: 403 ForbiddenError
  end
  H->>E: createExecution - INSERT executions status=queued
  E->>Ev: writeEvent execution.queued
  E->>E: enqueue - pg-boss EXECUTION_RUN_QUEUE oder sync

  Note over E: Worker uebernimmt Job
  E->>E: registerAbort execution_id, signal
  E->>DB: UPDATE executions status=running, started_at=now
  E->>Ev: writeEvent execution.started + EXECUTION_STARTED Audit
  E->>DB: SELECT workflow_versions - WorkflowDef validiert

  loop pro Step lineare Iteration
    E->>DB: INSERT execution_steps status=running
    E->>St: runRequestStep ctx, step, scope
    St->>DB: SELECT Connector Env-scoped + Credential
    alt OAuth2 stale
      Cr->>Ext: POST Token-Endpoint Refresh
      Cr->>DB: Credential rotieren
      Cr->>A: CREDENTIAL_OAUTH2_REFRESHED
    end
    St->>Drv: buildRequestPlan step, scope, connector, credential
    Drv->>Eg: assertEgressAllowed url, tenant
    alt blockiert
      Eg-->>Drv: EgressBlockedError
      St-->>E: StepResult status=failed, error.code=egress_blocked
    end
    loop Versuche bis 5
      St->>Pg: readPaginationCheckpoint resume bei Signatur-Match
      St->>Drv: executePlannedHttpRequest
      Drv->>Ext: HTTPS-Request Timeout, Signal
      Ext-->>Drv: Response Status, Headers, Body
      alt 429 oder 5xx idempotent oder Connection-Error
        St->>St: backoffMs attempt + Jitter
        St->>A: recordRequestRetry tenant, workflow, attempt, reason
      else Erfolg oder nicht-retryable
        St->>St: applyResponseFilters filters, body
        St->>Pg: writePaginationCheckpoint alle 50 Seiten
        St->>St: break
      end
    end
    St->>A: CONNECTOR_INVOKED url_host, auth_method, status
    St-->>E: StepResult status, output, retry_count, request_meta
    E->>E: applySelector step.data_selector post-success
    E->>Of: maybeOffload result wenn groesser 10KB
    alt S3 konfiguriert
      Of->>Ext: S3 putObject - s3 bucket key
    else
      Of->>DB: INSERT execution_fixtures kind=offload
    end
    Of-->>E: storage_uri, preview, size
    E->>DB: UPDATE execution_steps finalize
    E->>E: scope step.id = scope_value
  end

  E->>DB: UPDATE executions status=succeeded or failed or timed_out or aborted
  E->>Ev: writeEvent execution.status + EXECUTION_COMPLETED Audit
  E->>E: recordExecutionTerminal Metrik
  E->>E: unregisterAbort
  E-->>H: RunResult execution_id, status, steps, connector_resolutions, warnings
  H-->>U: 200 OK oder 202 wenn async
```

**Wichtige Code-Referenzen**
- HTTP-Route + RBAC: `apps/engine/src/http/routes/executions.ts`, `apps/engine/src/rbac/evaluator.ts:1-120`
- Engine: `apps/engine/src/execution/engine.ts`
- State-Writes: `apps/engine/src/execution/state.ts:32-209`
- Request-Step: `apps/engine/src/execution/steps/request.ts:1-end`
- Pagination: `apps/engine/src/execution/pagination.ts`
- Offload: `apps/engine/src/execution/offload.ts:96-143`
- HTTP-Driver + Auth + Egress: `apps/engine/src/connectors/drivers/http.ts`, `apps/engine/src/connectors/egress-guard.ts`
- Execution-Audit-Recorder: `apps/engine/src/audit/recorders/execution.ts`

---

## Anwendungsfall 5 — Self-Healing: Drift-Detection → Patch-Candidate → Auto-Apply oder Park

Wenn ein Step mit strukturell diagnostizierbarem Drift fehlschlägt (JSONata-Path-Miss, HTTP-Shape-Änderung), weckt der Outbox-Fanout Self-Healing. Das LLM schlägt einen Patch vor, der gegen Fixtures dry-run wird, und je nach Policy entweder auto-applied wird (wenn safe) oder zur Operator-Review geparkt wird.

```mermaid
sequenceDiagram
  autonumber
  participant Ev as "Outbox-Listener"
  participant SH as "Self-Healing service.ts"
  participant DD as "Drift-Detector"
  participant SV as schema_versions
  participant LLM as "LLM Repair-Flow"
  participant CL as "Classifier"
  participant FX as "Fixture-Runner"
  participant Pol as "Policy"
  participant DB as PostgreSQL
  participant A as Audit

  Ev->>SH: execution.failed - Repair-Job execution_id, step_id
  SH->>DB: SELECT execution_steps WHERE id=step_id
  SH->>SV: getLatestShape connector_id, endpoint_id
  SH->>DD: analyzeStepFailure snapshot, lastShape
  alt kein erkennbarer Drift
    DD-->>SH: null
    SH-->>SH: log normaler Fehler, exit
  else Drift-Signal
    DD-->>SH: DriftSignal kind, expression, missing_path
    SH->>LLM: runRepairFlow workflow, failing_step, drift_signal, prior_attempts bis 3
    alt LlmQuotaExhausted oder max Versuche
      SH-->>SH: requeue oder skip
    else
      LLM-->>SH: PatchProposal modifizierter DAG
      SH->>DB: INSERT patch_candidates status=proposed, proposal, drift_signal
      SH->>CL: classifyPatch proposal
      CL-->>SH: classification safe oder unsafe
      SH->>FX: runFixtureDryRun step, proposal, fixtures
      FX->>DB: SELECT execution_fixtures letztes fuer Endpoint
      FX-->>SH: dry_run_passed true oder false
      SH->>Pol: shouldAutoApply policy, classification, dry_run_passed
      alt auto-apply
        SH->>DB: BEGIN
        SH->>DB: INSERT workflow_versions version+1, dag=patched
        SH->>DB: UPDATE patch_candidates status=applied
        SH->>Ev: writeEvent patch.applied
        SH->>A: PATCH_CANDIDATE_AUTO_APPLIED
        SH->>DB: COMMIT
      else parken
        SH->>DB: UPDATE patch_candidates status=proposed bereits
        SH->>Ev: writeEvent patch.proposed
        SH->>A: PATCH_CANDIDATE_PROPOSED
      end
    end
  end
```

**Wichtige Code-Referenzen**
- Pipeline: `apps/engine/src/self-healing/service.ts:69-240`
- Drift: `apps/engine/src/self-healing/drift-detector.ts:49-100`
- Repair-LLM: `apps/engine/src/llm/flows/repair.ts`
- Classifier / Fixtures / Policy: gleiches Verzeichnis
- Crash-Reaper (Boot): `apps/engine/src/execution/recovery.ts` → `EXECUTION_CRASH_RECOVERED`

---

## Anwendungsfall 6 — Discovery & Knowledge-Ingestion

Ein User hängt eine Datei (OpenAPI, Postman, GraphQL-Schema, PDF) an die Conversation an → Discovery parst sie → produziert Vorschläge (Skill-Candidates, Connector-Templates, Knowledge-Sources) → Operator genehmigt → Assets werden ab dem nächsten Turn im Conversation-Kontext verfügbar.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant H as "HTTP / MCP"
  participant Disc as "Discovery"
  participant Parser as "Parser parseFileToChunks"
  participant Synth as "LLM-Synthese Async-Job"
  participant DB as PostgreSQL
  participant A as Audit
  participant Ctx as "Kontext-Assembler zukuenftiger Turn"

  U->>H: Datei an Conversation anhaengen
  H->>Disc: createDiscoveryRun tenant, conversation, file
  Disc->>DB: INSERT discovery_runs status=running
  Disc->>Parser: parseFileToChunks file
  Parser-->>Disc: chunks text, MIME, fingerprints
  Disc->>DB: INSERT discovery_files, discovery_artifacts status=proposed
  Disc->>A: DISCOVERY_RUN_STARTED
  Disc->>Synth: Synthese-Job enqueuen

  Synth->>DB: SELECT discovery_artifacts WHERE status=proposed
  Synth->>Synth: LLM materialisiert Vorschlaege
  Synth->>DB: INSERT UPDATE Artefakte skill_candidates, connector_templates, knowledge_sources, knowledge_chunks dedupliziert
  Synth->>A: DISCOVERY_ARTIFACT_PROPOSED
  Synth->>DB: UPDATE discovery_runs status=ready

  U->>H: Artefakt genehmigen skill_candidate
  H->>DB: UPDATE discovery_artifacts status=approved
  H->>DB: INSERT skills aus Candidate + Version-Bump
  H->>A: SKILL_CANDIDATE_APPROVED + SKILL_CREATED

  Note over Ctx: Beim naechsten Conversation-Turn
  Ctx->>DB: SELECT skills WHERE trigger_keywords ILIKE Auto-Detect
  Ctx->>DB: SELECT knowledge_chunks One-Shot-Flows Semantic-Search
  Ctx-->>Ctx: in Volatile-Tail einbinden, durch Budget begrenzt
```

**Wichtige Code-Referenzen**
- Discovery: `apps/engine/src/connectors/discovery/{index.ts,graphql-introspect.ts,types.ts}`
- Knowledge-Ingestion: `apps/engine/src/knowledge/service.ts:1-263` (Chunk-Dedup bei `:102-106`)
- Skill-Candidates → Skills-Promotion: `apps/engine/src/skills/service.ts:84-156`
- Auto-Detection pro Turn: `apps/engine/src/llm/core/context-assembler.ts:538-683`

---

## Anwendungsfall 7 — RBAC-Gate auf jeder Oberfläche

Derselbe Evaluator unterstützt HTTP, MCP, Webhook, CLI und Tool-Policy-Entscheidungen. Dieses Diagramm zeigt die Entscheidungs-Präzedenz, damit Operatoren verstehen, warum eine Permission-Entscheidung so ausgefallen ist.

```mermaid
sequenceDiagram
  autonumber
  participant Surf as "HTTP / MCP / CLI"
  participant Auth as requireAuth
  participant RB as "can() evaluator.ts"
  participant DB as PostgreSQL
  participant Met as Metriken

  Surf->>Auth: Bearer, API-Key oder Portal-Token extrahieren
  Auth-->>Surf: principal id, tenant_id, role_id, groups, portal_token
  Surf->>RB: can tenant, principal, permission, resource
  RB->>DB: 1. Builtin-Admin-Rolle?
  alt admin
    RB-->>Surf: allow source=builtin_admin
  else
    RB->>DB: 2. resource_grants direkt?
    alt grant
      RB-->>Surf: allow source=resource_grant
    else
      RB->>DB: 3. group_members - group_role_assignments - role_permissions
      alt Gruppe hat Permission
        RB-->>Surf: allow source=group
      else
        RB->>DB: 4. principal.role_id - role_permissions
        alt Rolle hat Permission
          RB-->>Surf: allow source=role
        else
          RB->>DB: 5. portal_tokens.allowed_workflows
          alt Portal erlaubt
            RB-->>Surf: allow source=portal_token_allowlist
          else
            RB-->>Surf: deny reason=permission_denied
          end
        end
      end
    end
  end
  RB->>Met: rbac_checks_total result, permission, source
```

**Wichtige Code-Referenzen**
- Evaluator: `apps/engine/src/rbac/evaluator.ts:1-120`
- HTTP-Gate: `requirePermission("workflow:run")` in `apps/engine/src/http/routes/executions.ts`

---

## Querschnitt: Notifications & Webhooks (out-bound)

Jeder Domain-Write, der den Zustand ändert, schreibt eine Zeile in die transaktionale Outbox in derselben Transaktion. Ein separater Listener fanned Events an Notification-Regeln und outbound Webhooks. Das ist es, was dem Kunden Ergebnisse zurückspielt, wenn die Execution asynchron beendet wird.

```mermaid
sequenceDiagram
  autonumber
  participant Tx as "Domain-Transaktion"
  participant DB as PostgreSQL
  participant Lis as "Outbox-Listener P4"
  participant N as "Notifications"
  participant Wh as "Webhook-Worker"
  participant Ext as "Slack, Teams, Webhook"
  participant A as Audit

  Tx->>DB: BEGIN, UPDATE executions status=succeeded, writeEvent execution.succeeded, COMMIT + NOTIFY
  Lis->>DB: Events seit Cursor pullen LISTEN NOTIFY + Catch-Up
  Lis->>N: dispatchEvent event
  N->>DB: matchRules event
  loop pro Regel
    N->>DB: getOrCreateNotificationChannel
    N->>N: tryAcquire Rate-Limit + canPass Circuit-Breaker
    alt rate-limited oder Breaker offen
      N->>DB: INSERT notification_deliveries status=rate_limited oder breaker_open oder skipped
      N->>A: CHAT_MESSAGE_DENIED
    else
      N->>Ext: chatDeliver oder Webhook signed POST HMAC-SHA256
      Ext-->>N: 2xx, 4xx oder 5xx
      N->>DB: INSERT notification_deliveries status=sent oder failed
      N->>A: CHAT_MESSAGE_SENT oder WEBHOOK_OUTBOUND_DELIVERED oder FAILED
    end
  end
  Lis->>DB: UPDATE outbox_cursors.last_seen_id
```

**Wichtige Code-Referenzen**
- Outbox: `apps/engine/src/db/events.ts`
- Notifications: `apps/engine/src/notifications/service.ts`, Channels in `notifications/channels/webhook.ts`
- Outbound-Delivery: `apps/engine/src/webhooks/outbound/delivery-worker.ts`

---

## Audit & Token-Accounting (Querschnitt)

Jedes Diagramm oben schreibt in `audit_log` (append-only, geschrubbt) und `llm_usage` (pro Step, gewichteter Monatseimer). Diese Verträge erlauben es Operatoren zu rekonstruieren, was passiert ist, Kosten zuzuordnen und Verhalten zu gaten.

| Stream | Tabelle | Writer |
|---|---|---|
| Audit (append-only, geschrubbt) | `audit_log` | `audit/audit.ts:27-70`, Recorder in `audit/recorders/*` |
| Token-Usage | `llm_usage` | Loop `onStepFinish` `loop.ts:856-949`, gewichtet: `prompt + completion + 0.1·cache_read + 0.25·cache_creation` |
| Outbox-Events | per-Tabelle Outbox + `outbox_cursors` | `db/events.ts` |
| Tool-Call-Ledger | `conversation_tool_calls` (`interaction_log` JSONB tracked `proposed→confirmed|declined|partial|tested`) | `tools/sdk-wrap.ts`, `confirmation.ts` |
| Draft-History | `conversation_drafts` (Snapshot pro Mutation) | `draft.ts`, `persistence/*` |

---

## Verifikation

Dieses Dokument ist eine Beschreibung des Codes, daher heisst Verifikation **aus dem Quellcode regenerieren und vergleichen**:

1. **Skim-Sweep** — jede zitierte Datei öffnen und bestätigen, dass die Zeilenbereiche das beschriebene Verhalten noch abbilden. Insbesondere:
   - `apps/engine/src/conversations/loop.ts:229-1167` (Loop-Body)
   - `apps/engine/src/conversations/tools/sdk-wrap.ts:150-468` (Wrapping + Confirm-Gate)
   - `apps/engine/src/conversations/tool-policies.ts:194-452` (Resolution-Stack)
   - `apps/engine/src/execution/state.ts:32-209` + `steps/request.ts` (Execution-States)
   - `apps/engine/src/self-healing/service.ts:69-240` (Repair-Loop)
2. **Live-Trace** — `bun run dev` (oder das Target des Users) starten, einen Prompt absetzen, der einen Connector erstellt + committed + ausführt, und bestätigen, dass die SSE-Frames + DB-Zeilen jede Phase treffen, die das Diagramm vorhersagt. Die CLI-Session unter `apps/sk` ist die direkteste Oberfläche.
3. **Mermaid rendern** — jeden Diagramm-Block in einen Mermaid-Renderer einfügen (jeder Markdown-Previewer mit Mermaid oder `mmdc`) und prüfen, dass die Diagramme parsen. Die CommonMark-Fences hier sind valides Mermaid.
4. **Audit-Cross-Check** — für eine konkrete Execution sollten die Zeilen in `audit_log` so verlaufen: `CONVERSATION_CREATED → APPROVAL_REQUESTED? → CONNECTOR_COMMITTED|WORKFLOW_COMMITTED → EXECUTION_STARTED → CONNECTOR_INVOKED* → EXECUTION_COMPLETED → (PATCH_CANDIDATE_*?) → CHAT_MESSAGE_SENT?`. Alles Fehlende markiert eine Divergenz zwischen diesem Dokument und der Realität.

Wenn ein Segment vom aktuellen Quellcode abweicht, sind die Datei-Referenzen innerhalb jedes Diagramms der günstigste Startpunkt zum Nachlesen.
