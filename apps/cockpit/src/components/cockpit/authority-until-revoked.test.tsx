import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  authorityValidity,
  MakeUntilRevoked,
  UntilRevokedDone,
  UntilRevokedHint,
  untilRevokedCounts,
} from "@/components/cockpit/authority-until-revoked";
import { confirmTitle } from "@/components/cockpit/patterns";
import { i18nValue, render } from "@/components/cockpit/patterns/test-utils";
import { type Locale, translate } from "@/lib/i18n";
import { untilRevokedOffer, type WorkflowAuthority } from "@/lib/workflow-authorities";

const NOW = Date.parse("2026-11-16T09:00:00.000Z");
const authority = {
  id: "00000000-0000-4000-8000-000000000001",
  workflow_id: "00000000-0000-4000-8000-000000000002",
  workflow_version_id: "00000000-0000-4000-8000-000000000003",
  effect_manifest_digest: "a".repeat(64),
  execution_environment: "prod",
  valid_from: "2026-10-20T09:00:00.000Z",
  valid_until: "2026-11-19T09:00:00.000Z",
  max_runs: null,
  reserved_runs: 4,
  remaining_runs: null,
  revoked_at: null,
  state: "approved",
} as WorkflowAuthority;

describe("removing the expiry of an approval", () => {
  test("is offered for a live approval limited only by run count", () => {
    const counted = { ...authority, valid_until: null, max_runs: 50, remaining_runs: 46 };
    expect(untilRevokedOffer(counted, NOW, true)).toEqual({ days: null });
    expect(
      untilRevokedOffer({ ...counted, valid_until: authority.valid_until }, NOW, true),
    ).toEqual({ days: 3 });
    expect(untilRevokedOffer({ ...counted, remaining_runs: 0 }, NOW, true)).toBeNull();
    expect(untilRevokedOffer(counted, NOW, false)).toBeNull();
    expect(render(<UntilRevokedHint days={null} remainingRuns={46} />)).toContain(
      "Noch 46 Runs erlaubt, danach startet der Workflow nichts mehr, bis du neu freigibst.",
    );
    expect(render(<UntilRevokedHint days={null} remainingRuns={1} />)).toContain(
      "Noch 1 Run erlaubt, danach startet der Workflow nichts mehr, bis du neu freigibst.",
    );
    expect(render(<UntilRevokedHint days={null} remainingRuns={46} />, "en")).toContain(
      "46 runs left, after which the workflow starts nothing until you approve again.",
    );
    expect(render(<UntilRevokedHint days={null} remainingRuns={1} />, "en")).toContain(
      "1 run left, after which the workflow starts nothing until you approve again.",
    );
    expect(
      translate("de", "workflowApprovals.untilRevoked.consequenceRuns", {
        subject: "Version v3 · Produktion",
      }),
    ).toBe(
      "Die Freigabe für „Version v3 · Produktion“ gilt dann bis auf Widerruf, ohne Run-Grenze.",
    );
    expect(translate("en", "workflowApprovals.untilRevoked.limitLifted")).toBe(
      "The run limit is lifted as well.",
    );
  });

  test("is offered only for a live approval with an expiry to someone who may grant", () => {
    expect(untilRevokedOffer(authority, NOW, true)).toEqual({ days: 3 });
    expect(untilRevokedOffer(authority, NOW + 60 * 60_000, true)).toEqual({ days: 3 });
    expect(untilRevokedOffer(authority, Date.parse("2026-11-18T23:00:00.000Z"), true)).toEqual({
      days: 1,
    });
    expect(untilRevokedOffer({ ...authority, valid_until: null }, NOW, true)).toBeNull();
    expect(untilRevokedOffer(authority, NOW, false)).toBeNull();
    expect(
      untilRevokedOffer({ ...authority, revoked_at: "2026-11-01T00:00:00.000Z" }, NOW, true),
    ).toBeNull();
    expect(untilRevokedOffer({ ...authority, state: "superseded" }, NOW, true)).toBeNull();
    expect(untilRevokedOffer(authority, Date.parse("2026-11-20T00:00:00.000Z"), true)).toBeNull();
  });

  test("the hint names the days left and what happens after", () => {
    expect(render(<UntilRevokedHint days={3} remainingRuns={null} />)).toContain(
      "Läuft in 3 Tagen ab, danach startet der Workflow nichts mehr, bis du neu freigibst.",
    );
    expect(render(<UntilRevokedHint days={1} remainingRuns={12} />)).toContain(
      "Läuft in 1 Tag ab, danach",
    );
    expect(render(<UntilRevokedHint days={2} remainingRuns={null} />, "en")).toContain(
      "Expires in 2 days, after which the workflow starts nothing until you approve again.",
    );
  });

  test("every hint is one sentence in both languages", () => {
    for (const locale of ["de", "en"] as const)
      for (const hint of [
        <UntilRevokedHint key="days" days={3} remainingRuns={null} />,
        <UntilRevokedHint key="runs" days={null} remainingRuns={5} />,
      ]) {
        const text = render(hint, locale).replace(/<[^>]+>/g, "");
        expect(text.split(". ")).toHaveLength(1);
        expect(text).not.toContain("!");
      }
  });

  test("the validity names what really limits the approval", () => {
    const de = i18nValue("de");
    const en = i18nValue("en");
    const openEnded = { ...authority, valid_until: null, max_runs: null, open_ended: true };
    const counted = {
      ...authority,
      valid_until: null,
      max_runs: 50,
      remaining_runs: 46,
      open_ended: false,
    };
    const dated = { ...authority, open_ended: false };
    expect(authorityValidity(openEnded, de)).toBe("Gilt bis auf Widerruf");
    expect(authorityValidity(counted, de)).toBe("Gilt noch für 46 Runs");
    expect(authorityValidity({ ...counted, remaining_runs: 1 }, de)).toBe("Gilt noch für 1 Run");
    expect(authorityValidity(counted, en)).toBe("Applies for 46 more runs");
    expect(authorityValidity({ ...counted, remaining_runs: 1 }, en)).toBe("Applies for 1 more run");
    expect(authorityValidity(dated, de)).toBe(
      `Gilt bis ${de.dateTime("2026-11-19T09:00:00.000Z")}`,
    );
    expect(authorityValidity(counted, de)).not.toContain("Widerruf");
  });

  test("the action is named after the limit that remains", () => {
    const button = (subject: WorkflowAuthority, locale: Locale) =>
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MakeUntilRevoked
            authority={subject}
            subject="Version v3"
            tiles={null}
            onDone={() => {}}
          />
        </QueryClientProvider>,
        locale,
      );
    const counted = { ...authority, valid_until: null, max_runs: 50, remaining_runs: 46 };
    expect(button(counted, "de")).toContain(">Run-Grenze aufheben<");
    expect(button(counted, "en")).toContain(">Remove run limit<");
    expect(button(counted, "de")).not.toContain("Unbefristet machen");
    expect(button({ ...authority, max_runs: 50, remaining_runs: 46 }, "de")).toContain(
      ">Unbefristet machen<",
    );
    expect(button(authority, "en")).toContain(">Remove expiry<");
    const title = (locale: Locale) => {
      const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
        translate(locale, key, values);
      return confirmTitle(
        t,
        locale,
        t("workflowApprovals.untilRevoked.objectRuns"),
        t("workflowApprovals.untilRevoked.verbRuns"),
      );
    };
    expect(title("de")).toBe("Run-Grenze dieser Freigabe aufheben?");
    expect(title("en")).toBe("Remove run limit from this approval?");
  });

  test("the confirmation follows the approved wording", () => {
    const wording = (locale: Locale) => {
      const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
        translate(locale, key, values);
      return confirmTitle(
        t,
        locale,
        t("workflowApprovals.untilRevoked.object"),
        t("workflowApprovals.untilRevoked.action"),
      );
    };
    expect(wording("de")).toBe("Freigabe unbefristet machen?");
    expect(wording("en")).toBe("Remove expiry from this approval?");
    expect(
      translate("de", "workflowApprovals.untilRevoked.consequence", {
        subject: "Version v3 · Produktion",
        until: "19.11.2026, 10:00",
      }),
    ).toBe(
      "Die Freigabe für „Version v3 · Produktion“ gilt dann bis auf Widerruf statt bis 19.11.2026, 10:00.",
    );
    const { tn } = i18nValue("de");
    expect(
      translate("de", "workflowApprovals.untilRevoked.same", {
        counts: untilRevokedCounts({ read: 2, write: 1, risky: 0, services: 1 }, tn),
      }),
    ).toBe("Was der Workflow darf, bleibt gleich: 2 Lesezugriffe, 1 Schreibzugriff, 1 Dienst.");
    expect(translate("de", "workflowApprovals.untilRevoked.runs")).toBe(
      "Laufende und geplante Runs werden nicht unterbrochen.",
    );
    expect(translate("de", "workflowApprovals.untilRevoked.revocable")).toBe(
      "Du kannst jederzeit widerrufen.",
    );
  });

  test("the action is a labelled button and success is announced", () => {
    const markup = render(
      <QueryClientProvider client={new QueryClient()}>
        <MakeUntilRevoked
          authority={authority}
          subject="Version v3"
          tiles={null}
          onDone={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(markup).toContain('data-testid="authority-until-revoked"');
    expect(markup).toContain(">Unbefristet machen<");
    const done = render(<UntilRevokedDone />);
    expect(done).toContain('role="status"');
    expect(done).toContain(
      "Erledigt: Die Freigabe gilt jetzt bis auf Widerruf. Es gab keine Unterbrechung; die alte Befristung steht im Verlauf.",
    );
  });
});
