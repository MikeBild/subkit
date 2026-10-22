import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/api/client";
import type { IntakeProposal, IntakeProposalTarget } from "@/api/intake";
import { translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import { ProposalCard } from "./intake";

const value = {
  locale: "de",
  preference: "de",
  setPreference() {},
  t: (key, values) => translate("de", key, values),
  tn: (key, count, values) => translatePlural("de", key, count, values),
  dateTime: (date) => String(date),
} as I18nValue;
const ITEM = "33333333-3333-4333-8333-333333333333";
const SKILL = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222";
const SKILL_WRITER = ["intake:confirm", "skill:write", "skill:activate"];

function proposal(target: IntakeProposalTarget): IntakeProposal {
  return {
    id: "proposal",
    tenant_id: "tenant",
    status: "draft",
    current_revision: 1,
    confirmed_revision: null,
    confirmed_target_kind: null,
    confirmed_target_id: null,
    rejected_at: null,
    stale_reason: null,
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    revision: {
      revision: 1,
      digest: "digest",
      title: "Rollbacks zuerst",
      body: "Rollback first.\nThen fix.",
      target,
      items: [{ id: ITEM, version: 1, title: "Sitzung", source_url: null }],
      created_at: "2026-01-02T00:00:00.000Z",
    },
  };
}

function render(
  target: IntakeProposalTarget,
  permissions: readonly string[],
  skills: Record<string, { title: string; version: number; body: string; status?: string }> = {},
  bindings: Record<string, string | number> = {},
) {
  const client = new QueryClient();
  for (const [id, skill] of Object.entries(skills))
    client.setQueryData(["skill", "intake-target", id], skill);
  for (const [path, binding] of Object.entries(bindings)) {
    if (typeof binding === "string") {
      client.setQueryData(["intake-target-binding", path], { name: binding });
      continue;
    }
    client
      .getQueryCache()
      .build(client, { queryKey: ["intake-target-binding", path] })
      .setState({
        status: "error",
        fetchStatus: "idle",
        error: new ApiError(binding, { message: "refused" }, null),
        errorUpdatedAt: 1,
      });
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nContext.Provider value={value}>
        <ProposalCard
          proposal={proposal(target)}
          permissions={permissions}
          focused
          onConfirm={() => {}}
        />
      </I18nContext.Provider>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

function confirmButton(html: string): string | null {
  return (
    html.match(/<button[^>]*data-testid="intake-proposal-proposal-confirm"[^>]*>/)?.[0] ?? null
  );
}

const newSkill: IntakeProposalTarget = {
  skill: {
    new: { title: "Rollbacks", scope: "global", tags: [], category: "betrieb" },
    supersedes: [],
  },
};
const replacing: IntakeProposalTarget = {
  skill: {
    new: { title: "Rollbacks", scope: "global", tags: [], category: "betrieb" },
    supersedes: [{ skill_id: OLD, expected_version: 2 }],
  },
};

describe("intake proposal card", () => {
  test("a new skill names its domain and is confirmable without knowledge:write", () => {
    const html = render(newSkill, SKILL_WRITER);
    expect(html).toContain("Neuer Skill „Rollbacks“ · betrieb · gilt überall");
    expect(html).toContain("Als Skill bestätigen");
    expect(html).toContain('data-testid="intake-proposal-proposal-confirm"');
  });

  test("knowledge writing alone never confirms a skill and names the missing rights", () => {
    const html = render(newSkill, ["intake:confirm", "knowledge:write"]);
    expect(html).not.toContain('data-testid="intake-proposal-proposal-confirm"');
    expect(html).toContain("Zum Bestätigen nötig: skill:write, skill:activate");
  });

  test("a connector-scoped new skill shows its binding in the card and the confirmation", () => {
    const target: IntakeProposalTarget = {
      skill: {
        new: {
          title: "Paging",
          scope: "connector",
          connector_id: SKILL,
          tags: [],
          category: "betrieb",
        },
        supersedes: [],
      },
    };
    const pending = render(target, SKILL_WRITER);
    expect(pending).toContain("nur für Konnektor …");
    expect(confirmButton(pending)).toContain('disabled=""');
    const html = render(target, SKILL_WRITER, {}, { [`/v1/connectors/${SKILL}`]: "Orders API" });
    expect(html).toContain("Neuer Skill „Paging“ · betrieb · nur für Konnektor Orders API");
    expect(confirmButton(html)).not.toContain('disabled=""');
  });

  test("an unreadable binding shows its id and leaves confirmation to the engine", () => {
    const target: IntakeProposalTarget = {
      skill: {
        new: {
          title: "Paging",
          scope: "workflow",
          workflow_id: OLD,
          tags: [],
          category: "betrieb",
        },
        supersedes: [],
      },
    };
    const forbidden = render(target, SKILL_WRITER, {}, { [`/v1/workflows/${OLD}`]: 403 });
    expect(forbidden).toContain(`nur für Workflow ${OLD}`);
    expect(forbidden).not.toContain('data-testid="intake-proposal-proposal-target-missing"');
    expect(confirmButton(forbidden)).not.toContain('disabled=""');
    const missing = render(target, SKILL_WRITER, {}, { [`/v1/workflows/${OLD}`]: 404 });
    expect(missing).toContain('data-testid="intake-proposal-proposal-target-missing"');
    expect(confirmButton(missing)).toContain('disabled=""');
  });

  test("updating an inactive skill says that confirming activates it", () => {
    const html = render(
      { skill: { skill_id: SKILL, expected_version: 3, supersedes: [] } },
      SKILL_WRITER,
      { [SKILL]: { title: "Regel", version: 3, body: "Rollback first.", status: "draft" } },
    );
    expect(html).toContain("Ändert Regel (v3) · aktiviert ihn auch");
  });

  test("a replaced skill shows its name, version and change and needs archive rights", () => {
    const old = { title: "Alte Regel", version: 2, body: "Rollback first.\nThen wait." };
    expect(render(replacing, SKILL_WRITER, { [OLD]: old })).not.toContain(
      'data-testid="intake-proposal-proposal-confirm"',
    );
    const html = render(replacing, [...SKILL_WRITER, "skill:archive"], { [OLD]: old });
    expect(html).toContain("Ersetzt Alte Regel (v2)");
    expect(html).toContain(`data-testid="intake-proposal-proposal-diff-${OLD}"`);
    expect(html).toContain('data-diff-line="removed"');
    expect(html).toContain('data-testid="intake-proposal-proposal-confirm"');
    expect(confirmButton(html)).not.toContain('disabled=""');
  });

  test("confirmation waits until every referenced skill is loaded", () => {
    const html = render(
      { skill: { skill_id: SKILL, expected_version: 3, supersedes: [] } },
      SKILL_WRITER,
    );
    expect(html).toContain("Ändert den gewählten Skill (v3)");
    expect(confirmButton(html)).toContain('disabled=""');
  });

  test("a skill that moved past the reviewed version cannot be confirmed", () => {
    const target: IntakeProposalTarget = {
      skill: { skill_id: SKILL, expected_version: 3, supersedes: [] },
    };
    const reviewed = render(target, SKILL_WRITER, {
      [SKILL]: { title: "Regel", version: 3, body: "Rollback first." },
    });
    expect(reviewed).toContain("Ändert Regel (v3)");
    expect(confirmButton(reviewed)).not.toContain('disabled=""');
    const moved = render(target, SKILL_WRITER, {
      [SKILL]: { title: "Regel", version: 4, body: "Rollback first." },
    });
    expect(moved).toContain('data-testid="intake-proposal-proposal-skill-moved"');
    expect(confirmButton(moved)).toContain('disabled=""');
  });

  test("source items open the collected item inside the cockpit", () => {
    const html = render(newSkill, SKILL_WRITER);
    expect(html).toContain(`/intake/${ITEM}`);
    expect(html).not.toContain('target="_blank"');
  });

  test("a knowledge target keeps its name and category line", () => {
    const html = render({ name: "Produktwissen", category: "incident-review" }, [
      "intake:confirm",
      "knowledge:write",
    ]);
    expect(html).toContain("Produktwissen · incident-review");
    expect(html).toContain("Als Wissen bestätigen");
  });
});
