export type TaskRunLanguage = "de" | "en";

export type TaskRunTurnKind = "continue" | "after_rejection";

export const TASK_RUN_CONTINUATION_MESSAGE =
  "Continue working on the task. Update the playbook, ask when you need a decision, and set the next check when you have to wait. A finished step gets its result; ending the round hands it over.";

export const TASK_RUN_REJECTION_NOTICE =
  "The person rejected the result. It is not done yet: find out what is missing, work on it, and update the playbook before you offer the result again.";

export const TASK_RUN_LANGUAGE_INSTRUCTIONS: Readonly<Record<TaskRunLanguage, string>> = {
  de: "Language: German. Write everything the person reads in German and address them informally with „du“, never „Sie“: your summary, every question, and each result and note you record in the playbook.",
  en: "Language: English. Write everything the person reads in English: your summary, every question, and each result and note you record in the playbook.",
};

export function taskRunTurnKind(run: {
  rejected_playbook_revision: number | null;
  last_playbook_revision: number;
}): TaskRunTurnKind {
  return run.rejected_playbook_revision === run.last_playbook_revision
    ? "after_rejection"
    : "continue";
}

export function taskRunTurnPrompt(language: TaskRunLanguage, kind: TaskRunTurnKind): string {
  return [
    TASK_RUN_CONTINUATION_MESSAGE,
    ...(kind === "after_rejection" ? [TASK_RUN_REJECTION_NOTICE] : []),
    TASK_RUN_LANGUAGE_INSTRUCTIONS[language],
  ].join("\n");
}
