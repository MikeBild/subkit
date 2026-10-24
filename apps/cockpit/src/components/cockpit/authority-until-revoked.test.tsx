import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
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
    expect(render(<UntilRevokedHint days={3} />)).toContain(
      "Läuft in 3 Tagen ab. Danach startet der Workflow nichts mehr, bis du neu freigibst.",
    );
    expect(render(<UntilRevokedHint days={1} />)).toContain("Läuft in 1 Tag ab.");
    expect(render(<UntilRevokedHint days={2} />, "en")).toContain("Expires in 2 days.");
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
      "Laufende und geplante Läufe werden nicht unterbrochen.",
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
