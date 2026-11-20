import { expect } from "bun:test";
import { isolatedIn, staged } from "@/components/cockpit/task-grant-dom-fixtures";
import { TASK_ID } from "@/components/cockpit/task-grant-fixtures";
import { run, task } from "./tasks-fixtures";

const isolated = isolatedIn(import.meta.path);

const label = (document: Document, testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? "";

for (const [locale, title, confirm, dismiss] of [
  ["de", "Lauf von „Wetter Berlin“ abbrechen?", "Lauf abbrechen", "Zurück"],
  ["en", "Stop run of “Wetter Berlin”?", "Stop run", "Back"],
] as const)
  isolated(
    `stopping a run offers two different buttons and names the run in ${locale}`,
    async () => {
      await staged(
        { previews: [], locale },
        async () => {
          const { StopRunDialog } = await import("./tasks-stop-dialog");
          return (
            <StopRunDialog
              name="Wetter Berlin"
              open
              onOpenChange={() => {}}
              pending={false}
              onConfirm={() => {}}
              testId="task-stop-confirm"
            />
          );
        },
        async (stage) => {
          const confirmLabel = label(stage.document, "task-stop-confirm-confirm");
          const dismissLabel = label(stage.document, "task-stop-confirm-cancel");
          expect(stage.text("task-stop-confirm-title")).toBe(title);
          expect(confirmLabel).toBe(confirm);
          expect(dismissLabel).toBe(dismiss);
          expect(confirmLabel).not.toBe(dismissLabel);
          expect(
            stage.document
              .querySelector('[data-testid="task-stop-confirm-confirm"]')
              ?.className.includes("bg-destructive"),
          ).toBe(true);
        },
      );
    },
  );

isolated("stopping a run without a known task name still has two different buttons", async () => {
  await staged(
    { previews: [] },
    async () => {
      const { StopRunDialog } = await import("./tasks-stop-dialog");
      return (
        <StopRunDialog
          name={null}
          open
          onOpenChange={() => {}}
          pending={false}
          onConfirm={() => {}}
          testId="chat-task-run-abort-dialog"
        />
      );
    },
    async (stage) => {
      expect(stage.text("chat-task-run-abort-dialog-title")).toBe("Lauf abbrechen?");
      expect(label(stage.document, "chat-task-run-abort-dialog-confirm")).not.toBe(
        label(stage.document, "chat-task-run-abort-dialog-cancel"),
      );
    },
  );
});

const review = (results: { id: string; label: string; text: string }[]) => async () => {
  const { TaskReviewDialog } = await import("./tasks-runs");
  return (
    <TaskReviewDialog
      task={task({ name: "Wetter Berlin", done_when: "Nennt Temperatur und Wind." })}
      run={run({ state: "result_ready" })}
      results={results}
      open
      onOpenChange={() => {}}
      canOpen
    />
  );
};

isolated("the review shows the delivered result and its yardstick inside the dialog", async () => {
  await staged(
    { previews: [] },
    review([
      { id: "work", label: "Zusammenfassen", text: "In Berlin sind es 6,4 °C.\nWind 12,7 km/h." },
    ]),
    async (stage) => {
      expect(stage.text("task-review-title")).toBe("Ergebnis von „Wetter Berlin“ prüfen");
      expect(stage.text("task-review-yardstick")).toContain("Fertig, wenn");
      expect(stage.text("task-review-yardstick")).toContain("Nennt Temperatur und Wind.");
      expect(stage.text("task-review-results")).toContain("Zusammenfassen");
      expect(stage.text("task-review-results")).toContain("In Berlin sind es 6,4 °C.");
      expect(stage.has("task-review-description")).toBe(false);
      expect(label(stage.document, "task-review-open")).toBe("Ergebnis ansehen");
      const body = stage.document.querySelector('[data-slot="dialog-body"]');
      expect(
        body?.contains(stage.document.querySelector('[data-testid="task-review-results"]')),
      ).toBe(true);
      expect(body?.className.split(" ")).toContain("overflow-auto");
      for (const button of ["task-review-accept", "task-review-reject", "task-review-cancel"]) {
        const found = stage.document.querySelector(`[data-testid="${button}"]`);
        expect(found, button).not.toBeNull();
        expect(body?.contains(found)).toBe(false);
      }
      const labels = ["task-review-accept", "task-review-reject", "task-review-cancel"].map(
        (button) => label(stage.document, button),
      );
      expect(labels).toEqual(["Passt", "Nacharbeiten", "Abbrechen"]);
    },
  );
});

isolated(
  "without a result text the review falls back to the one sentence and the link",
  async () => {
    await staged({ previews: [] }, review([]), async (stage) => {
      expect(stage.text("task-review-description")).toContain(
        "Sieh dir das Ergebnis in der Unterhaltung an",
      );
      expect(stage.has("task-review-results")).toBe(false);
      expect(stage.has("task-review-yardstick")).toBe(false);
      expect(stage.has("task-review-open")).toBe(true);
    });
  },
);

for (const [name, refusal] of [
  ["signed in with an API key only", { status: 403, body: { code: "human_session_required" } }],
  ["with an expired session", { status: 401, body: { code: "human_session_expired" } }],
] as const)
  isolated(`the permissions tab asks to sign in in the browser when ${name}`, async () => {
    await staged(
      { previews: [], previewRefusal: refusal },
      async () => {
        const { TaskPermissions } = await import("@/components/cockpit/task-permissions");
        return <TaskPermissions taskId={TASK_ID} />;
      },
      async (stage) => {
        expect(stage.text("task-permissions-session")).toContain(
          "Melde dich im Browser an, um zu sehen, was diese Aufgabe darf.",
        );
        expect(stage.has("task-permissions-sign-in")).toBe(true);
        expect(stage.has("task-permissions-failed")).toBe(false);
        expect(stage.text()).not.toContain("konnte nicht geladen werden");
      },
    );
  });

isolated("another failure of the permissions tab keeps the retry", async () => {
  await staged(
    { previews: [], previewRefusal: { status: 500, body: { code: "internal" } } },
    async () => {
      const { TaskPermissions } = await import("@/components/cockpit/task-permissions");
      return <TaskPermissions taskId={TASK_ID} />;
    },
    async (stage) => {
      expect(stage.has("task-permissions-failed")).toBe(true);
      expect(stage.has("task-permissions-session")).toBe(false);
    },
  );
});

isolated("the permission dialog names the browser sign-in for an API key", async () => {
  await staged(
    {
      previews: [],
      previewRefusal: { status: 403, body: { code: "human_session_required" } },
    },
    async () => {
      const { GrantTaskAuthority } = await import("@/components/cockpit/grant-task-authority");
      return <GrantTaskAuthority taskId={TASK_ID} open onOpenChange={() => {}} />;
    },
    async (stage) => {
      expect(stage.text("task-grant-dialog-error")).toBe(
        "Melde dich im Browser an, um diese Erlaubnis zu geben.",
      );
      expect(stage.has("task-grant-sign-in")).toBe(true);
      expect(stage.has("task-grant-load-failed")).toBe(false);
    },
  );
});
