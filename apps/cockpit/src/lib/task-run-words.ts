export const RUN_STATE_WORDS_EN = {
  running: "running",
  waiting: "waiting for you",
  sleeping: "sleeping",
  result_ready: "result ready",
  completed: "done",
  aborted: "aborted",
  failed: "failed",
} as const;

export type RunStateWord = keyof typeof RUN_STATE_WORDS_EN;

export const RUN_STATE_WORDS_DE: Record<RunStateWord, string> = {
  running: "läuft",
  waiting: "wartet auf dich",
  sleeping: "schläft",
  result_ready: "Ergebnis liegt vor",
  completed: "erledigt",
  aborted: "abgebrochen",
  failed: "fehlgeschlagen",
};
