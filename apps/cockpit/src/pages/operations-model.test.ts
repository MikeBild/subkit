import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  type AttentionFormat,
  drilldownHref,
  drilldownLabelKey,
  healthStateLine,
  type OperationalOverview,
  operationsAttention,
  scanOutcome,
} from "@/pages/operations-model";

const format: AttentionFormat = {
  t: (key, values) => (values ? `${key}${JSON.stringify(values)}` : key),
  dateTime: (iso) => `@${iso}`,
  value: (raw, unit) => (unit === "ratio" ? `${Math.round(raw * 100)}%` : String(raw)),
};

function metric(id: string, path: string) {
  return {
    id,
    label: id,
    definition: "",
    relevance: "",
    kind: "count" as const,
    value: 0,
    value_state: "zero" as const,
    unit: "count" as const,
    severity: "healthy" as const,
    required: true,
    source_updated_at: null,
    expected_interval_seconds: null,
    stale_after_seconds: null,
    drilldown: { path, label_id: "x" },
    prometheus: { name: id, type: "gauge" as const },
  };
}

function component(
  id: string,
  raw: number | null,
  score: number | null,
  path: string,
  label: string,
) {
  return {
    id,
    raw_value: raw,
    unit: id === "decisions.blocked" ? "count" : "ratio",
    normalized_score: score,
    weight: 0.3,
    contribution: null,
    freshness: raw === null ? ("missing" as const) : ("fresh" as const),
    required: true,
    drilldown: { path, label_id: label },
  };
}

type Cause = OperationalOverview["core"]["health"]["causes"][number];

const HELD_CAUSE: Cause = {
  kind: "held_schedule",
  id: "w1",
  label: "Monatsreport: automatic runs held for review",
  subject: { kind: "workflow", id: "w1", name: "Monatsreport" },
  reason: "held_for_review",
  detail: null,
  cause_class: null,
  drilldown: { path: "/cockpit/decisions?bucket=blocked", label_id: "operational.open_blocked" },
};

const CONNECTOR_CAUSE: Cause = {
  kind: "connector",
  id: "c1",
  label: "CRM: needs reauth",
  subject: { kind: "connector", id: "c1", name: "CRM" },
  reason: "needs_reauth",
  detail: null,
  cause_class: null,
  drilldown: { path: "/cockpit/connectors/c1", label_id: "operational.open_connector" },
};

function overview(input: {
  state?: "healthy" | "limited" | "critical" | "unknown";
  snapshot?: "ready" | "partial";
  causes?: OperationalOverview["core"]["health"]["causes"];
  connectorScore?: number | null;
  sources?: OperationalOverview["core"]["data_freshness"]["sources"];
}): OperationalOverview {
  const connector = input.connectorScore === undefined ? 100 : input.connectorScore;
  return {
    schema_version: "operational-overview.v1",
    contract_version: "2.3",
    product: "subkit",
    generated_at: "2026-09-27T10:00:00.000Z",
    recommended_refresh_seconds: 60,
    snapshot_state: input.snapshot ?? "ready",
    core: {
      blocked: metric("decisions.blocked", "/cockpit/decisions?bucket=blocked"),
      failing: metric("decisions.failing", "/cockpit/decisions?bucket=failing"),
      overdue: metric("decisions.overdue", "/cockpit/decisions?bucket=overdue"),
      other_decisions: metric("decisions.other", "/cockpit/decisions?bucket=other"),
      health: {
        ...metric("operations.health", "/cockpit/connectors?health=not_ok"),
        state: input.state ?? "healthy",
        components: [
          component(
            "decisions.blocked",
            0,
            100,
            "/cockpit/decisions?bucket=blocked",
            "operational.open_blocked",
          ),
          component(
            "executions.success_ratio",
            1,
            100,
            "/cockpit/runs?status=failed&source=scheduler",
            "operational.open_runs",
          ),
          component(
            "connectors.healthy_ratio",
            connector === null ? null : connector / 100,
            connector,
            "/cockpit/connectors?health=not_ok",
            "operational.open_connectors",
          ),
        ],
        causes: input.causes ?? [],
      },
      data_freshness: {
        ...metric("data.freshness", "/cockpit/audit?scope=operations"),
        state: "fresh",
        sources: input.sources ?? [
          {
            id: "self_healing.drift_scan",
            updated_at: "2026-09-27T09:00:00.000Z",
            expected_interval_seconds: 3600,
            stale_after_seconds: 7200,
            state: "fresh",
            drilldown: {
              path: "/cockpit/audit?scope=operations",
              label_id: "operational.open_scans",
            },
          },
        ],
      },
    },
    sections: [],
    audit: {
      path: "/cockpit/audit",
      contract_version: "2.3",
      snapshot_generated_at: "2026-09-27T10:00:00.000Z",
    },
  };
}

describe("the state line on /operations", () => {
  test("an undetermined state says it cannot be determined and why, never 'Unbekannt'", () => {
    const de = (key: TranslationKey, values?: Record<string, string>) =>
      translate("de", key, values);
    const line = healthStateLine("unknown", de);
    expect(line).toBe(de("operations.attention.undetermined"));
    expect(line).not.toContain("Unbekannt");
  });

  test("a determined state is named", () => {
    const de = (key: TranslationKey, values?: Record<string, string>) =>
      translate("de", key, values);
    expect(healthStateLine("limited", de)).toBe("Zustand: Eingeschränkt");
  });
});

describe("what the system page raises", () => {
  test("a healthy installation raises nothing at all", () => {
    expect(operationsAttention(overview({}), format)).toEqual([]);
  });

  test("each engine cause is a line that leads to it, most blocking first", () => {
    const items = operationsAttention(
      overview({
        state: "critical",
        causes: [HELD_CAUSE, CONNECTOR_CAUSE],
      }),
      format,
    );
    expect(items.map((item) => [item.id, item.tone, item.href, item.actionLabel])).toEqual([
      [
        "cause:held_schedule:w1",
        "critical",
        "/cockpit/decisions?bucket=blocked",
        "operations.link.open_blocked",
      ],
      ["cause:connector:c1", "warning", "/cockpit/connectors/c1", "operations.link.open_connector"],
    ]);
  });

  test("a cause is the cockpit's own sentence, never the engine's English label", () => {
    // The live defect: "Monatsreport: automatic runs held for review" printed
    // verbatim inside a German page.
    const [held, connector] = operationsAttention(
      overview({ state: "critical", causes: [HELD_CAUSE, CONNECTOR_CAUSE] }),
      format,
    );
    expect(held?.text).toBe('operations.cause.held_for_review{"name":"Monatsreport"}');
    expect(held?.engineWording).toBeNull();
    expect(connector?.text).toBe('operations.cause.needs_reauth{"name":"CRM"}');
    for (const item of [held, connector]) expect(item?.text).not.toContain("automatic runs");
  });

  test("the engine's free text travels beside the sentence, marked as the engine's", () => {
    const [failing] = operationsAttention(
      overview({
        state: "critical",
        causes: [
          {
            kind: "failing_group",
            id: "sig-1",
            label: "Monatsreport: The step driver failed: Object not found",
            subject: { kind: "workflow", id: "w1", name: "Monatsreport" },
            reason: "failing",
            detail: "The step driver failed: Object not found",
            cause_class: "driver_error",
            drilldown: {
              path: "/cockpit/decisions?bucket=failing",
              label_id: "operational.open_failing",
            },
          },
        ],
      }),
      format,
    );
    expect(failing?.text).toBe('operations.cause.failing{"name":"Monatsreport"}');
    expect(failing?.engineWording).toBe("The step driver failed: Object not found");
    expect(failing?.href).toBe("/cockpit/decisions?bucket=failing");
  });

  test("a subject without a name is said as such, not as an id or an empty name", () => {
    const [item] = operationsAttention(
      overview({
        state: "critical",
        causes: [
          {
            ...HELD_CAUSE,
            kind: "failing_group",
            reason: "failing",
            subject: { kind: "workflow", id: null, name: null },
          },
        ],
      }),
      format,
    );
    expect(item?.text).toBe('operations.cause.failing{"name":"operations.cause.unnamed.workflow"}');
  });

  test("an unhealthy score the engine named no cause for points at its weak component", () => {
    const items = operationsAttention(overview({ state: "limited", connectorScore: 50 }), format);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("component:connectors.healthy_ratio");
    expect(items[0]?.href).toBe("/cockpit/connectors?health=not_ok");
    expect(items[0]?.text).toContain("50%");
  });

  test("a component is not repeated beside the cause that already explains it", () => {
    const items = operationsAttention(
      overview({
        state: "limited",
        connectorScore: 50,
        causes: [CONNECTOR_CAUSE],
      }),
      format,
    );
    expect(items.map((item) => item.id)).toEqual(["cause:connector:c1"]);
  });

  test("a state that could not be determined is not an all-clear", () => {
    const items = operationsAttention(overview({ state: "unknown", connectorScore: null }), format);
    expect(items.map((item) => item.id)).toEqual(["health:undetermined"]);
    expect(items[0]?.href).toBe("/cockpit/connectors?health=not_ok");
  });

  test("an incomplete report says so", () => {
    expect(operationsAttention(overview({ snapshot: "partial" }), format)[0]?.id).toBe("snapshot");
  });

  test("a stale source names itself, when it last ran, and links to where it runs", () => {
    const items = operationsAttention(
      overview({
        sources: [
          {
            id: "self_healing.drift_scan",
            updated_at: "2026-09-20T09:00:00.000Z",
            expected_interval_seconds: 3600,
            stale_after_seconds: 7200,
            state: "stale",
            drilldown: {
              path: "/cockpit/audit?scope=operations",
              label_id: "operational.open_scans",
            },
          },
          {
            id: "connectors.reauth_scan",
            updated_at: null,
            expected_interval_seconds: 3600,
            stale_after_seconds: 7200,
            state: "missing",
            drilldown: { path: "/cockpit/connectors", label_id: "operational.open_connectors" },
          },
        ],
      }),
      format,
    );
    expect(items.map((item) => [item.id, item.tone, item.href])).toEqual([
      ["freshness:self_healing.drift_scan", "critical", "/cockpit/audit?scope=operations"],
      ["freshness:connectors.reauth_scan", "warning", "/cockpit/connectors"],
    ]);
    expect(items[0]?.text).toContain("@2026-09-20T09:00:00.000Z");
    expect(items[1]?.text).toContain("operations.attention.missing");
  });
});

describe("drilldowns", () => {
  test("engine paths already carry the base and keep it exactly once", () => {
    expect(drilldownHref({ path: "/cockpit/connectors?health=not_ok" })).toBe(
      "/cockpit/connectors?health=not_ok",
    );
    expect(drilldownHref({ path: "" })).toBeNull();
    expect(drilldownHref(null)).toBeNull();
  });

  test("an unknown label id still offers a way in", () => {
    expect(drilldownLabelKey("operational.open_somewhere_new")).toBe("operations.link.fallback");
  });
});

describe("the scan's toast", () => {
  test("proposed repairs are counted and lead to the queue", () => {
    expect(scanOutcome({ candidates_created: 3 })).toEqual({
      key: "operations.scanFound",
      count: 3,
      offerDecisions: true,
    });
  });

  test("a scan that proposed nothing says so and offers nothing", () => {
    expect(scanOutcome({ candidates_created: 0 }).offerDecisions).toBe(false);
    expect(scanOutcome({ candidates_created: 0 }).key).toBe("operations.scanFoundNone");
  });

  test("an answer without a count is not read as zero", () => {
    expect(scanOutcome({}).key).toBe("operations.scanStarted");
    expect(scanOutcome(null).key).toBe("operations.scanStarted");
  });
});
