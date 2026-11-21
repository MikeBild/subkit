import { expect } from "bun:test";
import { buttons, isolatedIn, posts, staged } from "../model/task-grant-dom-fixtures";
import {
  AUTHORITY_REPORT,
  GRANT_ID,
  liveGrant,
  preview,
  QUOTE,
  REPORT,
  TASK_ID,
  WF_REPORT,
} from "../model/task-grant-fixtures";

const isolated = isolatedIn(import.meta.path);

async function tab() {
  const { TaskPermissions } = await import("./task-permissions");
  return <TaskPermissions taskId={TASK_ID} />;
}

async function tabBelowAllowStrip() {
  const { TaskPermissions } = await import("./task-permissions");
  return <TaskPermissions taskId={TASK_ID} allowOffered />;
}

isolated("the tab without a standing permission has allow as its one action", async () => {
  await staged({ previews: [preview()] }, tab, async (stage) => {
    expect(stage.text("task-permissions-summary")).toContain(
      "Diese Aufgabe hat keine Dauererlaubnis und startet deshalb nicht alleine.",
    );
    expect(buttons(stage.document, "task-permissions")).toEqual(["task-permissions-allow"]);
    expect(stage.text("task-permissions-rows")).toContain("Workflow-Freigabe bis auf Widerruf");
    expect(stage.text("task-permissions-blocked-sentence")).toContain("Angebot erstellen");
    await stage.click("task-permissions-allow");
    expect(stage.text("task-grant-dialog-title")).toBe(
      "Darf „Rechnungen nachfassen“ alleine arbeiten?",
    );
  });
});

isolated(
  "the tab with a live standing permission shows validity, runs left and revoke as its one action",
  async () => {
    await staged(
      {
        previews: [
          preview({
            live_grant: liveGrant({
              valid_until: "2026-12-31T00:00:00.000Z",
              max_runs: 10,
              reserved_runs: 4,
              workflow_authority_ids: [AUTHORITY_REPORT],
            }),
            workflows: [QUOTE, REPORT],
          }),
        ],
        revoke: { body: { grant: liveGrant(), changed: true } },
      },
      tab,
      async (stage) => {
        expect(stage.text("task-permissions-summary")).toContain(
          "Die Dauererlaubnis gilt bis 2026-12-31T00:00:00.000Z.",
        );
        expect(stage.text("task-permissions-summary")).toContain("noch 6 Runs");
        expect(buttons(stage.document, "task-permissions")).toEqual([
          "task-permissions-revoke",
          "task-permissions-technical-toggle",
        ]);
        expect(stage.text("task-permissions-rows")).toContain("mit erlaubt");
        expect(
          stage.document
            .querySelector('[data-testid="task-grant-approval-3"]')
            ?.getAttribute("href"),
        ).toBe(`/cockpit/workflows/${WF_REPORT}#workflow-section-approvals`);
        await stage.click("task-permissions-revoke");
        expect(stage.text("task-permissions-revoke-dialog-title")).toBe(
          "Dauererlaubnis für „Rechnungen nachfassen“ widerrufen?",
        );
        await stage.click("task-permissions-revoke-dialog-confirm");
        expect(posts(stage.calls, `/grants/${GRANT_ID}/revoke`).length).toBe(1);
        expect(stage.toasts).toEqual(["success:Die Dauererlaubnis ist widerrufen."]);
      },
    );
  },
);

isolated("the tab leaves allow to the page when the page already offers it", async () => {
  await staged({ previews: [preview()] }, tabBelowAllowStrip, async (stage) => {
    expect(buttons(stage.document, "task-permissions")).toEqual([]);
    expect(stage.has("task-grant-dialog")).toBe(false);
    expect(stage.has("task-permissions-rows")).toBe(true);
  });
});

isolated("the tab keeps revoke for a live standing permission in any case", async () => {
  await staged(
    { previews: [preview({ live_grant: liveGrant() })] },
    tabBelowAllowStrip,
    async (stage) => {
      expect(buttons(stage.document, "task-permissions")).toContain("task-permissions-revoke");
      expect(buttons(stage.document, "task-permissions")).not.toContain("task-permissions-allow");
    },
  );
});

isolated("the tab offers no action to a person who may not allow", async () => {
  await staged({ previews: [preview()], permissions: ["task:read"] }, tab, async (stage) => {
    expect(buttons(stage.document, "task-permissions")).toEqual([]);
    expect(stage.has("task-permissions-rows")).toBe(true);
  });
});

isolated(
  "an expired standing permission is said to be expired and can be allowed again",
  async () => {
    await staged(
      {
        previews: [preview({ live_grant: liveGrant({ valid_until: "2026-01-01T00:00:00.000Z" }) })],
      },
      tab,
      async (stage) => {
        expect(stage.text("task-permissions-summary")).toContain(
          "Die Dauererlaubnis ist am 2026-01-01T00:00:00.000Z abgelaufen.",
        );
        expect(buttons(stage.document, "task-permissions")).toContain("task-permissions-allow");
        expect(buttons(stage.document, "task-permissions")).not.toContain(
          "task-permissions-revoke",
        );
      },
    );
  },
);
