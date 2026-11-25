export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransitionIn<S extends string>(
  table: TransitionTable<S>,
  from: S,
  to: S,
): boolean {
  return table[from].includes(to);
}

export function transitionSourcesIn<S extends string>(
  table: TransitionTable<S>,
  to: S,
  allowed: readonly S[] = Object.keys(table) as S[],
): S[] {
  return allowed.filter((from) => canTransitionIn(table, from, to));
}
