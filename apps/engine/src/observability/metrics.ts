// Hand-rolled Prometheus-compatible metrics registry.
//
// Why hand-rolled?
//   - Avoids pulling in `prom-client` (or any equivalent) as a runtime
//     dep — keeps the engine binary lean and drift-free.
//   - The set of series we emit is small + bounded; a real client would
//     be overkill.
//
// Concurrency: Bun runs every request on the same thread, so we get
// safe arithmetic without mutexes. The collector is process-scoped via
// a module-level instance.

import { logger } from "../logging/logger.ts";
import type { LabelValues, MetricDefinition, SampleSnapshot, SeriesSnapshot } from "./types.ts";

const DROPPED_LABEL_WARNINGS = new Set<string>();

function sortObjectKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key] as string;
  }
  return out;
}

function normalizeLabels(
  metric: MetricDefinition,
  raw: LabelValues | undefined,
): Record<string, string> {
  const allowed = new Set(metric.labels);
  const result: Record<string, string> = {};
  if (!raw) {
    for (const k of metric.labels) result[k] = "";
    return sortObjectKeys(result);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) {
      const warnKey = `${metric.name}::${k}`;
      if (!DROPPED_LABEL_WARNINGS.has(warnKey)) {
        DROPPED_LABEL_WARNINGS.add(warnKey);
        logger.warn({
          module: "observability",
          action: "metrics.label_dropped",
          msg: "metric label dropped (not in allow-list)",
          metric: metric.name,
          label: k,
        });
      }
      continue;
    }
    result[k] = String(v ?? "");
  }
  // Fill missing allow-list keys with an empty string so the series
  // shape stays consistent across writes.
  for (const k of metric.labels) {
    if (!(k in result)) result[k] = "";
  }
  return sortObjectKeys(result);
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

interface CounterSeries {
  def: MetricDefinition;
  values: Map<string, { labels: Record<string, string>; value: number }>;
}

interface GaugeSeries {
  def: MetricDefinition;
  values: Map<string, { labels: Record<string, string>; value: number }>;
}

interface HistogramSeries {
  def: MetricDefinition;
  buckets: number[]; // ascending, no +Inf
  values: Map<
    string,
    {
      labels: Record<string, string>;
      counts: number[]; // length == buckets.length + 1 (+Inf)
      sum: number;
      count: number;
    }
  >;
}

export class MetricsRegistry {
  private counters: Map<string, CounterSeries> = new Map();
  private gauges: Map<string, GaugeSeries> = new Map();
  private histograms: Map<string, HistogramSeries> = new Map();

  registerCounter(def: Omit<MetricDefinition, "kind">): void {
    const full: MetricDefinition = { ...def, kind: "counter" };
    this.counters.set(def.name, { def: full, values: new Map() });
  }

  registerGauge(def: Omit<MetricDefinition, "kind">): void {
    const full: MetricDefinition = { ...def, kind: "gauge" };
    this.gauges.set(def.name, { def: full, values: new Map() });
  }

  registerHistogram(def: Omit<MetricDefinition, "kind">): void {
    if (!def.buckets || def.buckets.length === 0) {
      throw new Error(`histogram ${def.name} requires non-empty buckets`);
    }
    const buckets = [...def.buckets].sort((a, b) => a - b);
    const full: MetricDefinition = { ...def, kind: "histogram", buckets };
    this.histograms.set(def.name, { def: full, buckets, values: new Map() });
  }

  inc(name: string, labels?: LabelValues, by = 1): void {
    const series = this.counters.get(name);
    if (!series) {
      this.warnUnknown("counter", name);
      return;
    }
    const norm = normalizeLabels(series.def, labels);
    const key = labelKey(norm);
    const existing = series.values.get(key);
    if (existing) {
      existing.value += by;
    } else {
      series.values.set(key, { labels: norm, value: by });
    }
  }

  set(name: string, value: number, labels?: LabelValues): void {
    const series = this.gauges.get(name);
    if (!series) {
      this.warnUnknown("gauge", name);
      return;
    }
    const norm = normalizeLabels(series.def, labels);
    series.values.set(labelKey(norm), { labels: norm, value });
  }

  observe(name: string, value: number, labels?: LabelValues): void {
    const series = this.histograms.get(name);
    if (!series) {
      this.warnUnknown("histogram", name);
      return;
    }
    const norm = normalizeLabels(series.def, labels);
    const key = labelKey(norm);
    let entry = series.values.get(key);
    if (!entry) {
      entry = {
        labels: norm,
        counts: new Array(series.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      series.values.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    let landed = false;
    for (let i = 0; i < series.buckets.length; i++) {
      const upper = series.buckets[i] as number;
      if (value <= upper) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1;
        landed = true;
        // Buckets are cumulative — `_bucket{le="x"}` includes everything
        // that landed in any earlier bucket, so we need to bump every
        // bucket from this index upwards. We do that during render so we
        // only pay it on scrape.
        break;
      }
    }
    if (!landed) {
      entry.counts[series.buckets.length] = (entry.counts[series.buckets.length] ?? 0) + 1;
    }
  }

  /** Returns the structured snapshot. Mostly used by tests + render(). */
  snapshot(): SeriesSnapshot[] {
    const out: SeriesSnapshot[] = [];
    for (const c of this.counters.values()) {
      const samples: SampleSnapshot[] = [];
      for (const v of c.values.values()) {
        samples.push({ name: c.def.name, labels: v.labels, value: v.value });
      }
      out.push({ name: c.def.name, help: c.def.help, kind: "counter", samples });
    }
    for (const g of this.gauges.values()) {
      const samples: SampleSnapshot[] = [];
      for (const v of g.values.values()) {
        samples.push({ name: g.def.name, labels: v.labels, value: v.value });
      }
      out.push({ name: g.def.name, help: g.def.help, kind: "gauge", samples });
    }
    for (const h of this.histograms.values()) {
      const samples: SampleSnapshot[] = [];
      for (const entry of h.values.values()) {
        // Cumulative bucket counts.
        let running = 0;
        for (let i = 0; i < h.buckets.length; i++) {
          running += entry.counts[i] ?? 0;
          samples.push({
            name: `${h.def.name}_bucket`,
            labels: { ...entry.labels, le: String(h.buckets[i]) },
            value: running,
          });
        }
        running += entry.counts[h.buckets.length] ?? 0;
        samples.push({
          name: `${h.def.name}_bucket`,
          labels: { ...entry.labels, le: "+Inf" },
          value: running,
        });
        samples.push({
          name: `${h.def.name}_sum`,
          labels: entry.labels,
          value: entry.sum,
        });
        samples.push({
          name: `${h.def.name}_count`,
          labels: entry.labels,
          value: entry.count,
        });
      }
      out.push({ name: h.def.name, help: h.def.help, kind: "histogram", samples });
    }
    return out;
  }

  /** Render in the Prometheus text exposition format (v0.0.4). */
  render(): string {
    const parts: string[] = [];
    for (const series of this.snapshot()) {
      parts.push(`# HELP ${series.name} ${series.help}`);
      parts.push(`# TYPE ${series.name} ${series.kind}`);
      if (series.samples.length === 0) {
        // Print a zero sample so scrape tools show the series exists.
        parts.push(`${series.name} 0`);
        continue;
      }
      for (const s of series.samples) {
        const labelKeys = Object.keys(s.labels);
        if (labelKeys.length === 0) {
          parts.push(`${s.name} ${formatNumber(s.value)}`);
        } else {
          const inner = labelKeys
            .map((k) => `${k}="${escapeLabelValue(s.labels[k] ?? "")}"`)
            .join(",");
          parts.push(`${s.name}{${inner}} ${formatNumber(s.value)}`);
        }
      }
    }
    return `${parts.join("\n")}\n`;
  }

  /** Test helper — wipes every series. */
  reset(): void {
    for (const c of this.counters.values()) c.values.clear();
    for (const g of this.gauges.values()) g.values.clear();
    for (const h of this.histograms.values()) h.values.clear();
  }

  private warnUnknown(kind: string, name: string): void {
    logger.warn({
      module: "observability",
      action: "metrics.unknown",
      msg: "attempt to write to an unregistered metric",
      kind,
      name,
    });
  }
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    if (n === Number.POSITIVE_INFINITY) return "+Inf";
    if (n === Number.NEGATIVE_INFINITY) return "-Inf";
    return "NaN";
  }
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}

// -----------------------------------------------------------------------
// Process-scoped registry + canonical series definitions
// -----------------------------------------------------------------------

const HISTOGRAM_DURATION_BUCKETS_MS = [10, 50, 250, 1000, 5000, 30000, 300000, 3600000] as const;

const HTTP_DURATION_BUCKETS_MS = [5, 25, 100, 500, 2500, 10000] as const;

export const METRIC_NAMES = {
  EXECUTION_TOTAL: "execution_total",
  EXECUTION_DURATION_MS: "execution_duration_ms",
  REQUEST_RETRY_TOTAL: "request_retry_total",
  WEBHOOK_DELIVERY_TOTAL: "webhook_delivery_total",
  CHAT_DELIVERY_TOTAL: "chat_delivery_total",
  LLM_TOKENS_TOTAL: "llm_tokens_total",
  QUEUE_DEPTH: "queue_depth",
  QUEUE_LAG_MS: "queue_lag_ms",
  OUTBOX_CURSOR_LAG: "outbox_cursor_lag",
  LLM_QUOTA_EXHAUSTED_TOTAL: "llm_quota_exhausted_total",
  PATCH_CANDIDATES_TOTAL: "patch_candidates_total",
  PROCESS_UPTIME_SECONDS: "process_uptime_seconds",
  HTTP_REQUESTS_TOTAL: "http_requests_total",
  HTTP_REQUEST_DURATION_MS: "http_request_duration_ms",
  RBAC_CHECKS_TOTAL: "rbac_checks_total",
  AUDIT_ROWS_WRITTEN_TOTAL: "audit_rows_written_total",
  CONVERSATION_TOOL_CALLS_TOTAL: "conversation_tool_calls_total",
  CONVERSATION_TOOL_DURATION_MS: "conversation_tool_duration_ms",
  CONVERSATION_CONFIRMATIONS_TOTAL: "conversation_confirmations_total",
  LLM_OUTPUT_VIOLATIONS_TOTAL: "llm_output_violations_total",
  LLM_OUTPUT_GUARD_DURATION_MS: "llm_output_guard_duration_ms",
  CANNOT_HELP_INVOCATIONS_TOTAL: "cannot_help_invocations_total",
  SELF_HEALING_REPAIR_RETRIED_TOTAL: "self_healing_repair_retried_total",
  EXECUTION_WARNINGS_EMITTED_TOTAL: "execution_warnings_emitted_total",
  EXECUTION_DRY_RUN_TOTAL: "execution_dry_run_total",
  // Loop iterations whose body payload was offloaded to durable
  // storage (the in-memory scope holds an `OffloadRef`, not the full
  // envelope — the OOM fix). Counted at the `productiveIterations`
  // short-circuit so operators can see big-loop memory pressure: a
  // rising count means loops are pushing oversize payloads through
  // the fixture / S3 offload path.
  EXECUTION_LOOP_ITERATION_OFFLOADED_TOTAL: "execution_loop_iteration_offloaded_total",
  LLM_CACHE_HIT_TOTAL: "llm_cache_hit_tokens_total",
  LLM_CACHE_CREATION_TOTAL: "llm_cache_creation_tokens_total",
  LLM_PROMPT_TOKENS_TOTAL: "llm_prompt_tokens_total",
  CONVERSATION_TURN_DURATION_MS: "conversation_turn_duration_ms",
  LLM_CONTEXT_ASSEMBLED_TOTAL: "llm_context_assembled_total",
  LLM_CONTEXT_DROPPED_SECTIONS_TOTAL: "llm_context_dropped_sections_total",
  LLM_CONTEXT_TOTAL_TOKENS: "llm_context_total_tokens",
  /**
   * Wall-clock duration (ms) of `listProposedForAuthoring` — the
   * authoring-time fan-out that loads proposed Skill Candidates for
   * the assembler. Up to three indexed queries + `getEvidenceCounts`
   * batch per converse turn; this histogram surfaces the cost so a
   * future fan-out → single-query refactor has measured ground truth.
   */
  LLM_LIST_PROPOSED_FOR_AUTHORING_DURATION_MS: "llm_list_proposed_for_authoring_duration_ms",
  /**
   * Section-load failures during context assembly, partitioned by
   * section name. Currently emitted by the proposed-candidates loader
   * when the DB fan-out throws. A non-zero rate is operational signal:
   * candidates have silently vanished from the prompt.
   */
  LLM_CONTEXT_SECTION_LOAD_FAILURES_TOTAL: "llm_context_section_load_failures_total",
  AUTHORING_GATE_BLOCKS_TOTAL: "subkit_authoring_gate_blocks_total",
  // Per-tool circuit-breaker open events. Fired when the
  // sdk-wrap layer short-circuits a tool call due to repeated
  // identical args (`tool_loop_detected`) or the global
  // consecutive-failures cap (`consecutive_failures_cap`). Lets a
  // dashboard show flapping tools the same way the connector
  // circuit metric shows flapping connectors.
  TOOL_CIRCUIT_OPEN_TOTAL: "subkit_tool_circuit_open_total",
  // Detected hallucinated tool-absence claims. Fires when the LLM's
  // assistant text denies the availability of a tool that IS in the
  // resolved palette this turn. Operators chart by `tool` to see
  // which tools the model is most likely to forget — usually a
  // signal that the schema-normaliser regressed or the cleanup
  // palette diverged from the seed-skill teaching.
  CONVERSATION_TOOL_HALLUCINATED_ABSENCE_TOTAL:
    "subkit_conversation_tool_hallucinated_absence_total",
  // Defence-in-depth for Root A: counts workflow commits where the
  // name+description carries cadence phrasing but `trigger.kind`
  // remained `request`. Any non-zero count is a regression signal —
  // the seed skill (Phase 2 fix) instructs the LLM to carry the
  // schedule trigger inline with `build_workflow`.
  WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL: "subkit_workflow_schedule_not_bound_total",
  // Per-kind workflow trigger counter. Recorded at every successful
  // commit so operators can chart the mix of request / webhook /
  // schedule over time. A sudden drop in `schedule` kind is the
  // canary for the chat-authoring flow regressing.
  WORKFLOW_TRIGGER_KIND_TOTAL: "subkit_workflow_trigger_kind_total",
  // Authoring-time LLM critic runs. `result` is one of
  // passed / rejected / fail_open. Operators chart passed:rejected
  // to estimate signal quality, and (passed+rejected):fail_open to
  // spot provider instability.
  CRITIC_RUNS_TOTAL: "subkit_critic_runs_total",
  // Best-effort `workflows.last_executed_at` write failures from the
  // saved-execution finaliser. The catalog LRU degrades silently when
  // this drifts; a non-zero rate is operational signal.
  WORKFLOWS_LAST_EXECUTED_AT_WRITE_FAILED_TOTAL:
    "subkit_workflows_last_executed_at_write_failed_total",
  // G15 (lock the LLM-token-accountant lead): the token accountant
  // reconciles tiktoken estimates against SDK-reported usage already;
  // exporting the absolute drift percentage as a histogram surfaces
  // estimate quality at provider granularity. Operators can chart it
  // to spot a drift regression after a model swap before it shows up
  // as a billing surprise.
  LLM_TOKEN_DRIFT_PCT: "llm_token_drift_pct",

  // v3.5 — runtime config moved to subkit.config.json. Operators
  // override individual leaves via SK_OVERRIDE_<KEY> env vars during
  // incidents; this gauge reports which leaves are currently
  // override-driven so dashboards can flag a drifted host without
  // exposing the secret value itself. Set at every loadConfig() and
  // every setConfigKey() commit.
  SETTINGS_OVERRIDE_ACTIVE: "settings_override_active",
  // Engine self-update + rollback outcomes. Cardinality is
  // intentionally bounded: `result` is one of `success` / `failed` /
  // `rollback` (kept in lockstep with the `engine.update.*` audit
  // action names so SREs don't have to remember an off-by-one),
  // `channel` is `stable` / `beta`. Version labels are NOT included —
  // semver is unbounded over time and would explode the series.
  ENGINE_UPDATE_TOTAL: "engine_update_total",
  // Next-message suggestion outcomes — `outcome` is one of `generated`,
  // `accepted`, `dismissed`, `typed_over`, `suppressed`, `budget_pressure`,
  // `error`. The single counter covers both the generation side (engine
  // emits `generated` / `suppressed` / `error`) and the acceptance side
  // (sk-cli posts feedback that lands as `accepted` / `dismissed` /
  // `typed_over`). Cardinality is bounded — no suggestion text label.
  SK_SUGGEST_NEXT_TOTAL: "sk_suggest_next_total",
  // Proactive self-healing drift scan instrumentation. The scheduler /
  // admin HTTP / MCP entry points share this label set so dashboards
  // can compare cadence:
  //   * proactive_drift_scans_total      — one per scan invocation,
  //     labelled by source (scheduler / admin_http / mcp) and
  //     terminal status (succeeded / failed). Cardinality bounded
  //     by tenant_id × 3 × 2.
  //   * proactive_drift_signals_total    — one per emitted signal,
  //     labelled by drift kind. Operators chart this against
  //     candidates_total to see how many signals got promoted.
  //   * proactive_drift_candidates_total — one per Patch Candidate
  //     created from a proactive scan, labelled by classification.
  //     Distinct from the existing PATCH_CANDIDATES_TOTAL counter
  //     (which mixes reactive + proactive) so dashboards can split
  //     the funnel.
  //   * proactive_drift_scan_duration_seconds — histogram of scan
  //     wall-clock duration, labelled by source. Lets SREs spot a
  //     scan that has started running long (e.g. an unbounded LLM
  //     retry loop) without trawling logs.
  PROACTIVE_DRIFT_SCANS_TOTAL: "proactive_drift_scans_total",
  PROACTIVE_DRIFT_SIGNALS_TOTAL: "proactive_drift_signals_total",
  PROACTIVE_DRIFT_CANDIDATES_TOTAL: "proactive_drift_candidates_total",
  PROACTIVE_DRIFT_SCAN_DURATION_SECONDS: "proactive_drift_scan_duration_seconds",
  /**
   * Drift the scanner detected but could not promote to a Patch
   * Candidate because no workflow anchor exists (hook surface, or a
   * connector no workflow references). Operators chart this against
   * `proactive_drift_signals_total` to see how much of detected
   * drift the current candidate model can act on — high unanchored
   * counts point at follow-up work to land hook-level candidates.
   */
  PROACTIVE_DRIFT_UNANCHORED_TOTAL: "proactive_drift_unanchored_total",

  // ----- Unified files resource ---------------------------------
  // The files surface owns its own metric ladder so an operator can see at
  // a glance how the storage substrate is behaving without grepping the
  // execution / LLM ladders.
  /**
   * Per-tenant live row count, partitioned by status (`pending` /
   * `uploading` / `ready` / `failed` / `expired`). Updated on every
   * create / finalize / delete transition and reconciled by the cleanup
   * cron. Operators chart `ready` vs. `pending` to spot a stuck upload
   * pipeline (rising `pending` with flat `ready`) and total row count
   * against the storage backend's object count to spot orphan leaks.
   */
  FILES_TOTAL: "subkit_files_total",
  /**
   * Per-tenant sum of `size_bytes` across `files WHERE deleted_at IS
   * NULL`. Drives a "bytes-on-disk per tenant" panel; spikes here paired
   * with a flat row count point at a single very large upload that may
   * need a TTL or quota nudge.
   */
  FILES_BYTES_TOTAL: "subkit_files_bytes_total",
  /**
   * Counts every dedup short-circuit — both the inline path
   * (sha256-match on POST /v1/files/inline) and the finalize sibling-
   * dedup branch. Operators chart this against `subkit_files_total` to
   * gauge how much storage cost the dedup index is saving.
   */
  FILES_DEDUP_HITS_TOTAL: "subkit_files_dedup_hits_total",
  /**
   * Histogram of inline-upload + finalize wall-clock duration, labelled
   * by terminal outcome (`success` / `scan_infected` / `sha_mismatch` /
   * `error`). p95 of `success` tracks user-perceived upload latency;
   * a rising `error` bucket points at a degraded storage backend.
   */
  FILES_UPLOAD_DURATION_SECONDS: "subkit_files_upload_duration_seconds",
  /**
   * Per-tenant counter of bytes shipped inline to the LLM via the
   * `file_part` strategy. A runaway inline channel can blow the
   * per-turn token budget — chart this against
   * `subkit_files_llm_cap_downgrades_total` to see how often the
   * 250 KiB per-turn cap is biting.
   */
  FILES_LLM_INLINE_BYTES_TOTAL: "subkit_files_llm_inline_bytes_total",
  /**
   * Per-tenant counter of files force-downgraded from `file_part` to
   * `text_extract` because the per-turn 250 KiB inline budget was
   * exhausted. Non-zero values mean the model is seeing parser-extracted
   * text instead of the raw bytes — which is the safe fallback but
   * worse signal for image / PDF input.
   */
  FILES_LLM_CAP_DOWNGRADES_TOTAL: "subkit_files_llm_cap_downgrades_total",
  /**
   * Counter of scanner verdicts (`clean` / `infected`). Any non-zero
   * `infected` value is operator-actionable: the scanner caught
   * malware before it became readable to a workflow, but the upload
   * source still warrants follow-up.
   */
  FILES_SCAN_RESULTS_TOTAL: "subkit_files_scan_results_total",
  /**
   * Counter of pg-boss in-flight scans that failed because the
   * `pgboss` schema was absent. In production this is a serious
   * deploy regression — pg-boss is the queue substrate; missing
   * schema means migrations didn't apply. The cleanup cron skips
   * the unlinked-TTL soft-delete pass for the tick when any scan
   * fails (so a file referenced by an in-flight job that is
   * unreachable through the failed scan path is NOT reaped).
   * `source` is one of `job`, `schedule`, `archive`.
   */
  FILES_CLEANUP_PGBOSS_SCAN_MISSING_TOTAL: "subkit_files_cleanup_pgboss_scan_missing_total",
  /**
   * Counter of binary parse attempts in the docs-ingestion subsystem
   * (`pdf` / `docx` / `xlsx` / `xls` / `pptx`), partitioned by terminal
   * result (`success` / `error`). Chart against
   * `subkit_docs_binary_parse_input_bytes_total` to see input volume per
   * format; a sudden spike in `error` for one format usually points at
   * a library regression or a malformed-file upload campaign.
   */
  DOCS_BINARY_PARSE_TOTAL: "subkit_docs_binary_parse_total",
  /**
   * Counter of input bytes attempted by the docs-ingestion binary
   * parsers, partitioned by format. Increments BEFORE the parser runs
   * — name carries `_input_bytes_` (not `_parsed_bytes_`) so an
   * operator reading the metric knows it includes failures. To chart
   * successfully-parsed volume divide by the success rate from
   * `subkit_docs_binary_parse_total{result="success"}`.
   */
  DOCS_BINARY_PARSE_INPUT_BYTES_TOTAL: "subkit_docs_binary_parse_input_bytes_total",
} as const;

function buildRegistry(): MetricsRegistry {
  const reg = new MetricsRegistry();

  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_TOTAL,
    help: "Workflow executions, partitioned by terminal status.",
    labels: ["tenant_id", "status", "request_source", "workflow_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WORKFLOWS_LAST_EXECUTED_AT_WRITE_FAILED_TOTAL,
    help: "Best-effort `workflows.last_executed_at` write failures from the saved-execution finaliser.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.ENGINE_UPDATE_TOTAL,
    help: "Engine self-update + rollback outcomes.",
    labels: ["result", "channel"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.SK_SUGGEST_NEXT_TOTAL,
    help: "Next-message suggestion outcomes — generation + acceptance.",
    labels: ["tenant_id", "outcome", "kind"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.EXECUTION_DURATION_MS,
    help: "Wall-clock duration of workflow executions in milliseconds.",
    labels: ["tenant_id", "workflow_id"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.REQUEST_RETRY_TOTAL,
    help: "Outbound HTTP retries inside the request step driver.",
    labels: ["connector_id", "reason"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WEBHOOK_DELIVERY_TOTAL,
    help: "Outbound webhook deliveries, partitioned by outcome.",
    labels: ["subscription_id", "status"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CHAT_DELIVERY_TOTAL,
    help: "Outbound chat messages, partitioned by platform and outcome.",
    labels: ["platform", "status"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_TOKENS_TOTAL,
    help: "LLM tokens consumed (prompt + completion combined).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.QUEUE_DEPTH,
    help: "Pending jobs per pg-boss queue (sampled every 15s).",
    labels: ["queue"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.QUEUE_LAG_MS,
    help: "Age of the oldest pending job in each pg-boss queue.",
    labels: ["queue"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.OUTBOX_CURSOR_LAG,
    help: "Outbox listener cursor lag (rows behind head per channel).",
    labels: ["listener_id", "channel"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_QUOTA_EXHAUSTED_TOTAL,
    help: "Tenant LLM monthly budget exhaustion events.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PATCH_CANDIDATES_TOTAL,
    help: "Self-healing patch candidates by classification + decision.",
    labels: ["classification", "decision"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.PROCESS_UPTIME_SECONDS,
    help: "Engine process uptime in seconds.",
    labels: [],
  });
  reg.registerCounter({
    name: METRIC_NAMES.HTTP_REQUESTS_TOTAL,
    help: "HTTP requests served by the engine HTTP layer.",
    labels: ["method", "path", "status"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.HTTP_REQUEST_DURATION_MS,
    help: "HTTP request handler duration in milliseconds.",
    labels: ["method", "path"],
    buckets: HTTP_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.RBAC_CHECKS_TOTAL,
    help: "RBAC permission check evaluations, partitioned by result + source.",
    labels: ["result", "permission", "source"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.AUDIT_ROWS_WRITTEN_TOTAL,
    help: "Audit log rows successfully persisted, partitioned by action and result.",
    labels: ["action", "result"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONVERSATION_TOOL_CALLS_TOTAL,
    help: "Conversation tool invocations, partitioned by category + outcome.",
    labels: ["category", "tool", "outcome"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_OUTPUT_VIOLATIONS_TOTAL,
    help: "Assistant-text grounding violations caught by llmOutputGuard, partitioned by scanner kind + mode.",
    labels: ["kind", "mode"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_OUTPUT_GUARD_DURATION_MS,
    help: "Wall-clock duration of llmOutputGuard scans in milliseconds.",
    labels: [],
    buckets: HTTP_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.CANNOT_HELP_INVOCATIONS_TOTAL,
    help: "Assistant abstentions via cannot_help, partitioned by missing_capability slug.",
    labels: ["missing_capability"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS,
    help: "Conversation tool execution latency in milliseconds.",
    labels: ["category", "tool"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONVERSATION_CONFIRMATIONS_TOTAL,
    help: "Confirmation state transitions, partitioned by to_state.",
    labels: ["to_state", "tool"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.SELF_HEALING_REPAIR_RETRIED_TOTAL,
    help: "Self-healing repair-flow retries (final attempts count per drift signal).",
    labels: ["tenant_id", "attempts"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_SCANS_TOTAL,
    help: "Proactive self-healing drift scans, partitioned by source (scheduler / admin_http / mcp) and terminal status.",
    labels: ["tenant_id", "source", "status"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_SIGNALS_TOTAL,
    help: "Anchored drift signals from proactive scans (those promoted toward a Patch Candidate), partitioned by signal kind. Drift that lacked a workflow anchor is tracked separately by `proactive_drift_unanchored_total`; the sum is `signals_detected` on the scan response.",
    labels: ["tenant_id", "signal_type"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_CANDIDATES_TOTAL,
    help: "Patch Candidates created from proactive scans, partitioned by classification. Always parked as 'proposed' — never auto-applied.",
    labels: ["tenant_id", "classification"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.PROACTIVE_DRIFT_SCAN_DURATION_SECONDS,
    help: "Wall-clock duration of a proactive drift scan, in seconds.",
    labels: ["source"],
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_UNANCHORED_TOTAL,
    help: "Drift detected by proactive scans that could not be promoted to a Patch Candidate (no workflow anchor).",
    labels: ["tenant_id", "signal_type", "reason"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_WARNINGS_EMITTED_TOTAL,
    help: "Step warnings emitted during workflow execution (e.g. unresolved identifiers).",
    labels: ["tenant_id", "step_kind"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_DRY_RUN_TOTAL,
    help: "Dry-run previews of workflows or steps, partitioned by source kind.",
    labels: ["tenant_id", "source_kind"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_LOOP_ITERATION_OFFLOADED_TOTAL,
    help: "Loop iterations whose body payload was offloaded to durable storage (the in-memory scope holds an OffloadRef). A rising count signals big-loop memory pressure.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.AUTHORING_GATE_BLOCKS_TOTAL,
    help: "Authoring-time gate refusals — workflow_unresolved_step_reference, workflow_cycle_detected, loop_authoring_requires_inspect, transform_authoring_requires_inspect, repair_loop_detected, critic_rejected. Tells us how often the LLM hits these guards (high counts = the skill / prompt is failing to teach the rule).",
    labels: ["code", "tool"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.TOOL_CIRCUIT_OPEN_TOTAL,
    help: "Per-tool circuit-breaker opens. `reason` is `tool_loop_detected` (3× identical args) or `consecutive_failures_cap` (5 consecutive fails). High counts on a specific tool point at flapping behaviour or a brittle skill prompt.",
    labels: ["tool", "reason"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONVERSATION_TOOL_HALLUCINATED_ABSENCE_TOTAL,
    help: "LLM denied availability of a tool that IS in the resolved palette this turn (root D defence-in-depth). Triaged by `tool` — non-zero counts are a regression signal because the seed skill instructs the model to call `cannot_help` instead.",
    labels: ["tool"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL,
    help: "Workflow commits whose name+description carry cadence phrasing but `trigger.kind` remained `request` (root A defence-in-depth). Non-zero counts are a regression signal — the seed skill teaches the LLM to bind the schedule trigger inline with `build_workflow`.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WORKFLOW_TRIGGER_KIND_TOTAL,
    help: "Workflow commits per trigger kind (request / webhook / schedule). A sudden drop in `schedule` is the canary for chat-authoring regressing back to manual create_schedule calls. Labelled by `tenant_id` for parity with WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL so cohorts can be sliced per tenant.",
    labels: ["tenant_id", "kind"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CRITIC_RUNS_TOTAL,
    help: "Authoring-critic invocations. `result` is `passed` (critic approved), `rejected` (critic returned passed:false; tool emits critic_rejected), or `fail_open` (LLM error / no structured output; treated as passed).",
    labels: ["result"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CACHE_HIT_TOTAL,
    help: "LLM prompt-cache read tokens (cached stable-block reuse).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CACHE_CREATION_TOTAL,
    help: "LLM prompt-cache write tokens (first-turn cache seeding).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_PROMPT_TOKENS_TOTAL,
    help: "LLM prompt tokens billed as regular input (denominator for cache hit rate).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.CONVERSATION_TURN_DURATION_MS,
    help: "Conversation-turn wall-clock duration in milliseconds.",
    labels: ["tenant_id"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CONTEXT_ASSEMBLED_TOTAL,
    help: "Context-assembly invocations partitioned by flow and the surface that triggered them.",
    labels: ["flow", "request_source"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CONTEXT_DROPPED_SECTIONS_TOTAL,
    help: "Context sections dropped by the budget trimmer, partitioned by flow and section name.",
    labels: ["flow", "section"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_CONTEXT_TOTAL_TOKENS,
    help: "Total prompt tokens emitted from context-assembly per call (pre-completion).",
    labels: ["flow"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_LIST_PROPOSED_FOR_AUTHORING_DURATION_MS,
    help: "Wall-clock duration of the authoring-time proposed-candidate fan-out (up to 3 indexed queries + evidence batch).",
    labels: ["scope_hint"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CONTEXT_SECTION_LOAD_FAILURES_TOTAL,
    help: "Context-assembly section-load failures partitioned by section name.",
    labels: ["section"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_TOKEN_DRIFT_PCT,
    help: "Absolute percentage drift between tiktoken-estimated tokens and SDK-reported usage, per provider.",
    labels: ["provider", "model", "kind"],
    // 0% to 50% in five-percent steps — drift in the high single
    // digits is normal; anything past ~15% is a strong signal that a
    // tokenizer assumption is stale.
    buckets: [0, 1, 2, 5, 10, 15, 20, 30, 50],
  });
  reg.registerGauge({
    name: METRIC_NAMES.SETTINGS_OVERRIDE_ACTIVE,
    help: "Active SK_OVERRIDE_<key> env overrides. 1 per dotted leaf path while the override is in effect; never carries the value itself.",
    labels: ["key"],
  });

  // ----- Unified files resource ---------------------------------
  reg.registerGauge({
    name: METRIC_NAMES.FILES_TOTAL,
    help: "Live `files` rows per tenant, partitioned by status (pending / uploading / ready / failed / expired). Refreshed on transitions and reconciled by the cleanup cron.",
    labels: ["tenant_id", "status"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.FILES_BYTES_TOTAL,
    help: "Per-tenant sum of `size_bytes` across `files WHERE deleted_at IS NULL`.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_DEDUP_HITS_TOTAL,
    help: "Dedup short-circuits — inline path (sha256-match) + finalize sibling-dedup branch.",
    labels: [],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.FILES_UPLOAD_DURATION_SECONDS,
    help: "Wall-clock duration of inline upload + finalize, labelled by terminal outcome (success / scan_infected / sha_mismatch / error).",
    labels: ["outcome"],
    // p50 ~50ms inline; p95 ~5s for finalize on a slow scanner.
    buckets: [0.05, 0.25, 1, 5, 30, 120],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_LLM_INLINE_BYTES_TOTAL,
    help: "Per-tenant bytes shipped inline to the LLM via the `file_part` strategy. Chart against `subkit_files_llm_cap_downgrades_total` to spot per-turn cap pressure.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_LLM_CAP_DOWNGRADES_TOTAL,
    help: "Per-tenant files force-downgraded from `file_part` to `text_extract` because the per-turn 250 KiB inline budget was exhausted.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_SCAN_RESULTS_TOTAL,
    help: "Scanner verdicts (`clean` / `infected`). Any `infected` value is operator-actionable.",
    labels: ["verdict"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_CLEANUP_PGBOSS_SCAN_MISSING_TOTAL,
    help: "pg-boss in-flight scans that failed because the `pgboss` schema is absent — a serious deploy regression in production. The cleanup cron skips the unlinked-TTL soft-delete pass for the tick when any scan fails. `source` is one of `job`, `schedule`, `archive`.",
    labels: ["source"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.DOCS_BINARY_PARSE_TOTAL,
    help: "Binary file parse attempts (pdf/docx/xlsx/xls/pptx), partitioned by terminal result.",
    labels: ["format", "result"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.DOCS_BINARY_PARSE_INPUT_BYTES_TOTAL,
    help: "Input bytes attempted (success + error) by the docs-ingestion binary parsers, partitioned by format.",
    labels: ["format"],
  });

  return reg;
}

let _registry: MetricsRegistry | null = null;
const BOOT_AT_MS = Date.now();

export function getMetrics(): MetricsRegistry {
  if (!_registry) {
    _registry = buildRegistry();
  }
  return _registry;
}

/** Reset the singleton — tests only. */
export function resetMetricsRegistryForTests(): void {
  _registry = buildRegistry();
}

/** Compute current process uptime in seconds (used right before render()). */
export function refreshProcessUptime(): void {
  getMetrics().set(
    METRIC_NAMES.PROCESS_UPTIME_SECONDS,
    Math.floor((Date.now() - BOOT_AT_MS) / 1000),
  );
}
