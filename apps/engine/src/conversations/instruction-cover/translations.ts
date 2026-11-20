const EQUIVALENT_VALUES: ReadonlyArray<readonly string[]> = [
  ["erledigt", "done", "completed", "complete", "abgeschlossen", "fertig", "finished"],
  ["offen", "open"],
  ["geschlossen", "closed"],
  ["hoch", "high"],
  ["niedrig", "gering", "low"],
  ["mittel", "medium", "normal"],
  ["dringend", "urgent"],
  ["gelost", "resolved", "solved"],
  ["in arbeit", "in bearbeitung", "in progress", "in_progress", "inprogress", "doing"],
  ["wichtig", "important"],
  ["genehmigt", "approved"],
  ["abgelehnt", "rejected", "declined"],
  ["wartend", "wartet", "pending", "waiting", "on hold", "on_hold"],
  ["neu", "new"],
  ["kritisch", "critical"],
  ["blockiert", "blocked"],
  ["privat", "private"],
];

const BY_VALUE = new Map<string, readonly string[]>();
for (const group of EQUIVALENT_VALUES) {
  for (const value of group) BY_VALUE.set(value, group);
}

export function equivalentValues(normalized: string): readonly string[] {
  const group = BY_VALUE.get(normalized.toLowerCase());
  return group ? group.filter((value) => value !== normalized.toLowerCase()) : [];
}
