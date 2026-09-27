// What an overview owes a reader: the operating picture, not a second copy of
// the work queue and not a list of causes.
//
// The tiles are fixed by the family contract (FAMILY-UI.json, checked by
// scripts/konvention-check.mjs): four decision counts, the health state and the
// data freshness, then the product sections — no lists, no banners. What this
// file decides is how each number is read, never which numbers there are.
//
// The causes behind a red tile live where they can be acted on: the failing and
// blocked workflows on the decisions page, the health components, causes and
// stale sources on the system page. The engine names the way to each (contract
// 2.3); this file only decides when a number offers that way at all.

/**
 * Whether a number offers a way in.
 *
 * The engine owns every drilldown, aimed at what its number counted. What is
 * left to decide here is the reader's side, and it depends on what KIND of
 * number it is.
 *
 * A count of nothing has nothing to open. On a live installation a link sat
 * under "production incidents: 0" and opened nine hundred rows — a reader
 * clicks a zero expecting to be told there is nothing, and was handed a wall
 * instead. That rule is about counts, and only about counts.
 *
 * A ratio, a score or a duration at zero is not "nothing": execution success
 * at 0 %, connector health at 0 %, a health score of 0 are the WORST states
 * the tile can be in, and each has a cause to go to. Those link whenever the
 * engine names a path — a red tile without a way to its cause is the one
 * thing §1 forbids. A metric that names no kind is read as a count, the
 * narrower rule.
 *
 * `null` is not zero: a value that could not be read is unknown, not empty.
 * An unknown that is also red keeps its way in — the engine makes the health
 * state critical on blocked work alone, with no score when nothing ran in 24
 * hours. A plain unknown offers none. A path that is missing or blank is no
 * way in, whatever the value.
 */
export function metricOffersDrilldown(metric: {
  kind?: string | null;
  value: number | null | undefined;
  severity?: string | null;
  drilldown?: { path?: string | null } | null;
}): boolean {
  if (!metric.drilldown?.path?.trim()) return false;
  if (metric.value === null || metric.value === undefined)
    return metric.severity === "critical" || metric.severity === "urgent";
  const isCount = !metric.kind || metric.kind === "count";
  return isCount ? metric.value > 0 : true;
}

/**
 * The status line under a tile's value, or nothing when it would repeat it.
 *
 * "Betriebszustand" printed "Gesund" as its value and "Gesund" again as its
 * status; "Datenstand" printed "Aktuell" twice. A second line that says the
 * same word is not a second fact. It stays where it adds one — "Veraltet"
 * under a measured age says what the age means.
 */
export function distinctStatus(value: string, status: string | undefined): string | undefined {
  return status && status.trim() !== value.trim() ? status : undefined;
}
