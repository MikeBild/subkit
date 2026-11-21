import { expect } from "bun:test";
import { isolatedIn, posts, staged } from "../model/task-grant-dom-fixtures";
import {
  AUTHORITY_REPORT,
  DIGEST_MATCH,
  FINGERPRINT,
  GRANT_ID,
  liveGrant,
  preview,
  REPORT,
  TASK_ID,
  VERSION_QUOTE,
  WF_MATCH,
  WF_QUOTE,
  WF_REPORT,
  workflow,
} from "../model/task-grant-fixtures";

const isolated = isolatedIn(import.meta.path);

async function dialog(onOpenChange: (open: boolean) => void = () => {}) {
  const { GrantTaskAuthority } = await import("./grant-task-authority");
  return <GrantTaskAuthority taskId={TASK_ID} open onOpenChange={onOpenChange} />;
}

const granted = (workflows: unknown[]) => ({
  status: 201,
  body: { grant: liveGrant(), changed: true, superseded_grant_ids: [], workflows },
});

isolated(
  "the dialog asks one question, states the schedule, lists the effects, offers the duration and two buttons",
  async () => {
    await staged({ previews: [preview()] }, dialog, async (stage) => {
      expect(stage.text("task-grant-dialog-title")).toBe(
        "Darf „Rechnungen nachfassen“ alleine arbeiten?",
      );
      expect(stage.text("task-grant-dialog-description")).toBe(
        "Sie startet täglich um 07:00 und darf dabei:",
      );
      expect(stage.text("task-grant-rows")).toContain("liest Buchhaltung");
      expect(stage.text("task-grant-rows")).toContain("startet Zahlungsabgleich");
      expect(
        stage.document
          .querySelector('[data-testid="task-grant-limit-revoked"]')
          ?.getAttribute("data-state"),
      ).toBe("checked");
      expect(
        stage.document.querySelector<HTMLInputElement>('[data-testid="task-grant-limit-runs"]')
          ?.value,
      ).toBe("");
      expect(stage.text("task-grant-blocked-sentence")).toBe(
        "„Angebot erstellen“ lässt sich nicht dauerhaft erlauben und fragt deshalb bei jedem Run.",
      );
      expect(stage.document.querySelectorAll('[data-testid="task-grant-blocked"]').length).toBe(1);
      const footer = [...stage.document.querySelectorAll("[data-slot=dialog-footer] button")].map(
        (button) => button.getAttribute("data-testid"),
      );
      expect(footer).toEqual(["task-grant-cancel", "task-grant-confirm"]);
      expect(stage.text("task-grant-confirm")).toBe("Erlauben");
      expect(stage.text()).not.toMatch(/fingerprint|cron|prod\b|grant\b/i);
      expect(stage.text()).not.toContain("!");
    });
  },
);

isolated("the dialog reads the same in English", async () => {
  await staged({ previews: [preview()], locale: "en" }, dialog, async (stage) => {
    expect(stage.text("task-grant-dialog-title")).toBe(
      "May “Rechnungen nachfassen” work on its own?",
    );
    expect(stage.text("task-grant-dialog-description")).toBe("It starts daily at 07:00 and may:");
    expect(stage.text("task-grant-blocked-sentence")).toBe(
      "“Angebot erstellen” cannot be allowed permanently, so it asks on every run.",
    );
    expect(stage.text("task-grant-confirm")).toBe("Allow");
  });
});

isolated(
  "allowing sends the reviewed fingerprint and workflow digests, then closes with one sentence",
  async () => {
    const closed: boolean[] = [];
    await staged(
      {
        previews: [preview()],
        grant: granted([
          { workflow_id: WF_MATCH, outcome: "granted", authority_id: GRANT_ID, reason: null },
          {
            workflow_id: WF_QUOTE,
            outcome: "not_granted",
            authority_id: null,
            reason: "workflow_not_repeatable",
          },
          {
            workflow_id: WF_REPORT,
            outcome: "covered",
            authority_id: AUTHORITY_REPORT,
            reason: null,
          },
        ]),
      },
      () => dialog((open) => closed.push(open)),
      async (stage) => {
        await stage.click("task-grant-limit-date");
        await stage.click("task-grant-confirm");
        const [sent] = posts(stage.calls, `/v1/tasks/${TASK_ID}/grants`);
        expect(sent?.body).toMatchObject({
          expected_fingerprint: FINGERPRINT,
          max_runs: null,
          expected_workflow_digests: { [WF_MATCH]: DIGEST_MATCH },
        });
        const until = Date.parse(
          (sent?.body as { valid_until?: string } | undefined)?.valid_until ?? "",
        );
        // allow-wall-clock: the dialog derives the limit from the browser's real clock
        const days = (until - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(30);
        expect(days).toBeLessThan(31);
        expect(closed).toEqual([false]);
        expect(stage.toasts).toEqual([
          "success:„Rechnungen nachfassen“ darf jetzt alleine arbeiten.",
        ]);
      },
    );
  },
);

isolated(
  "a task that changed since the preview reloads the preview and says so in one sentence",
  async () => {
    const closed: boolean[] = [];
    await staged(
      {
        previews: [preview(), preview({ fingerprint: "9".repeat(64) })],
        grant: {
          status: 409,
          body: { code: "task_grant_fingerprint_changed", message: "changed" },
        },
      },
      () => dialog((open) => closed.push(open)),
      async (stage) => {
        await stage.click("task-grant-confirm");
        expect(stage.text("task-grant-changed")).toBe(
          "Die Aufgabe wurde inzwischen geändert, prüfe die Angaben noch einmal.",
        );
        expect(stage.calls.filter((call) => call.path.endsWith("/grant-preview")).length).toBe(2);
        expect(closed).toEqual([]);
        expect(stage.has("task-grant-dialog-error")).toBe(false);
        await stage.click("task-grant-confirm");
        expect(posts(stage.calls, "/grants").at(-1)?.body).toMatchObject({
          expected_fingerprint: "9".repeat(64),
        });
      },
    );
  },
);

isolated("a workflow that changed since the preview reloads it with its own sentence", async () => {
  await staged(
    {
      previews: [preview()],
      grant: { status: 409, body: { code: "task_grant_preview_changed", message: "changed" } },
    },
    dialog,
    async (stage) => {
      await stage.click("task-grant-confirm");
      expect(stage.text("task-grant-changed")).toBe(
        "Ein Workflow darf inzwischen etwas anderes, prüfe die Angaben noch einmal.",
      );
      expect(stage.calls.filter((call) => call.path.endsWith("/grant-preview")).length).toBe(2);
    },
  );
});

isolated(
  "a workflow refused only on allowing is named per workflow with its step reason behind Warum?",
  async () => {
    const closed: boolean[] = [];
    await staged(
      {
        previews: [preview({ workflows: [workflow(), REPORT] })],
        grant: granted([
          {
            workflow_id: WF_MATCH,
            outcome: "not_granted",
            authority_id: null,
            reason: "workflow_not_repeatable",
          },
          {
            workflow_id: WF_REPORT,
            outcome: "covered",
            authority_id: AUTHORITY_REPORT,
            reason: null,
          },
        ]),
        workflowPreview: {
          unavailable_steps: ["lookup"],
          request_refusals: [{ step_id: "lookup", reason: "mcp_tool_changed" }],
          storage_refusals: [],
          manifest: { issues: [] },
        },
      },
      () => dialog((open) => closed.push(open)),
      async (stage) => {
        expect(stage.has("task-grant-blocked")).toBe(false);
        await stage.click("task-grant-confirm");
        expect(closed).toEqual([]);
        expect(stage.text("task-grant-dialog-title")).toBe(
          "„Rechnungen nachfassen“ darf jetzt alleine arbeiten",
        );
        expect(stage.text("task-grant-outcome-0")).toBe("Zahlungsabgleich fragt jedes Mal");
        expect(stage.text("task-grant-outcome-1")).toBe("Wochenbericht schon erlaubt");
        expect(stage.text("task-grant-blocked-sentence")).toBe(
          "„Zahlungsabgleich“ lässt sich nicht dauerhaft erlauben und fragt deshalb bei jedem Run.",
        );
        expect(stage.has("task-grant-confirm")).toBe(false);
        expect(stage.text("task-grant-close")).toBe("Schließen");
        await stage.open("task-grant-blocked-why");
        expect(stage.text("task-grant-steps-0")).toContain(
          "Schritt lookup: Der Server beschreibt dieses Tool anders, als der Schritt es festhält",
        );
      },
    );
  },
);

isolated(
  "an unavailable step of a bound workflow shows its refusal reason behind Warum?",
  async () => {
    await staged(
      {
        previews: [preview()],
        workflowPreview: {
          unavailable_steps: [],
          request_refusals: [{ step_id: "send", reason: "no_boundary" }],
          storage_refusals: [],
          manifest: {
            issues: [{ step_id: "send", code: "request_boundary_missing" }],
          },
        },
      },
      dialog,
      async (stage) => {
        expect(stage.has("task-grant-steps-0")).toBe(false);
        await stage.open("task-grant-blocked-why");
        const asked = stage.calls.find((call) => call.path.endsWith("/authority-preview"));
        expect(asked?.path).toBe(
          `/v1/workflows/${WF_QUOTE}/versions/${VERSION_QUOTE}/authority-preview`,
        );
        expect(stage.text("task-grant-steps-0")).toContain("Schritt send: ");
      },
    );
  },
);

isolated("a failed allow keeps the dialog open and names the next step", async () => {
  await staged(
    { previews: [preview()], grant: { status: 500, body: { code: "internal", message: "x" } } },
    dialog,
    async (stage) => {
      await stage.click("task-grant-confirm");
      expect(stage.text("task-grant-dialog-error")).toContain(
        "Die Dauererlaubnis konnte nicht gespeichert werden, versuche es noch einmal.",
      );
      expect(stage.has("task-grant-dialog-error-remedy")).toBe(true);
      expect(stage.has("task-grant-dialog-error-technical-toggle")).toBe(true);
      expect(stage.has("task-grant-confirm")).toBe(true);
    },
  );
});

isolated("an expired session offers to sign in instead of allowing", async () => {
  await staged(
    {
      previews: [preview()],
      grant: { status: 403, body: { code: "human_session_expired", message: "x" } },
    },
    dialog,
    async (stage) => {
      await stage.click("task-grant-confirm");
      expect(stage.text("task-grant-dialog-error")).toContain(
        "Deine Sitzung ist abgelaufen, melde dich an und erlaube dann noch einmal.",
      );
      expect(stage.has("task-grant-sign-in")).toBe(true);
      expect(stage.has("task-grant-confirm")).toBe(false);
    },
  );
});

isolated("an archived task cannot be allowed", async () => {
  await staged({ previews: [preview({ grantable: false })] }, dialog, async (stage) => {
    expect(stage.text("task-grant-archived")).toBe(
      "Eine archivierte Aufgabe kann keine Dauererlaubnis bekommen.",
    );
    expect(stage.has("task-grant-confirm")).toBe(false);
  });
});
