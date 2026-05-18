// Pure detector for cadence phrasing in workflow names + descriptions.
//
// Defence-in-depth for Root A: when a workflow's name or description
// mentions a recurring cadence ("daily at 9", "every Monday morning",
// "täglich um 18 Uhr") but `trigger.kind === "request"` survives the
// commit, we want a loud audit row. The seed skill (Phase 2)
// instructs the LLM to bind a schedule trigger in this case; this
// detector is the observability signal that proves whether the
// teaching works in production.
//
// **Used only for emitting a warning.** The regex never feeds back
// into cron construction — that's the LLM's responsibility per the
// seed skill. Treating the regex as a "fallback cron generator" was
// the kind of hack the codebase explicitly forbids
// (see `feedback_no_hacks_only_root_cause`).

const CADENCE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // English
  { name: "every-day-at-HH", re: /\bevery\s+day\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i },
  { name: "daily-at-HH", re: /\bdaily(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i },
  { name: "hourly", re: /\bhourly\b/i },
  { name: "weekly", re: /\bweekly(?:\s+on\s+[a-z]+)?(?:\s+at\s+\d{1,2}(?::\d{2})?)?\b/i },
  { name: "monthly", re: /\bmonthly(?:\s+on\s+the\s+\d+(?:st|nd|rd|th)?)?\b/i },
  { name: "weekdays-at-HH", re: /\bweekdays?\s+at\s+\d{1,2}(?::\d{2})?\b/i },
  {
    name: "every-N-minutes",
    re: /\bevery\s+\d+\s+(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b/i,
  },
  {
    name: "every-weekday-at-HH",
    re: /\bevery\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+morning|\s+evening|\s+at\s+\d{1,2}(?::\d{2})?)?\b/i,
  },
  { name: "at-HH-utc", re: /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:utc|gmt)\b/i },
  // German
  { name: "täglich", re: /\btäglich(?:\s+um\s+\d{1,2}(?::\d{2})?)?\b/i },
  { name: "stündlich", re: /\bstündlich\b/i },
  { name: "wöchentlich", re: /\bwöchentlich\b/i },
  { name: "monatlich", re: /\bmonatlich\b/i },
  { name: "jeden-werktag", re: /\bjeden\s+werktag\b/i },
  {
    name: "jeden-wochentag",
    re: /\bjeden\s+(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i,
  },
  { name: "alle-N-minuten", re: /\balle\s+\d+\s+(?:minuten|stunden|sekunden)\b/i },
];

export interface SchedulePhraseDetection {
  matched: boolean;
  /** Pattern names that fired — stable identifiers for audit metadata. */
  matched_phrases: string[];
}

/**
 * Scan a workflow's name + description for cadence phrasing. Returns
 * the matched pattern names so the audit row carries operator-readable
 * triage context.
 */
export function detectSchedulePhrases(input: {
  name?: string | null;
  description?: string | null;
}): SchedulePhraseDetection {
  const haystack = [input.name ?? "", input.description ?? ""].join(" ");
  if (!haystack.trim()) return { matched: false, matched_phrases: [] };
  const matched: string[] = [];
  for (const pat of CADENCE_PATTERNS) {
    if (pat.re.test(haystack)) matched.push(pat.name);
  }
  return { matched: matched.length > 0, matched_phrases: matched };
}
