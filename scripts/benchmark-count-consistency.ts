// Before/after benchmark for the chat-critic count-consistency checks (A+B).
//
// "Before" = shipped behaviour: gradeChat checked ids / runtime / placeholders
// but NOT the assistant's own counts, so a self-contradictory delete summary
// passed with confidence 1 (recall = 0). "After" runs detectCountInconsistencies.
//
// Run: bun run scripts/benchmark-count-consistency.ts
//
// Ground truth is drawn from the real corsica-ferries delete (conversation
// dc81979b): the "3 Workflows over a 2-item list" summary and the "5 = 2+2"
// final tally — plus clean messages that MUST stay quiet (precision).

import { detectCountInconsistencies } from "../apps/engine/src/llm/critic/count-consistency.ts";

interface Case {
  name: string;
  text: string;
  expectIssue: boolean; // ground truth: should ANY count issue fire?
}

const CORSICA_SUMMARY = [
  "Du möchtest alle Corsica-Ferries-Ressourcen löschen. Das sind 3 Workflows und 2 Connectors:",
  "",
  "Workflows:",
  "• corsica-ferries-daily-cabin-price-check",
  "• corsica-ferries-daily-cabin-price-check-rpc",
  "• (keine weiteren mit corsica-ferries im Namen)",
  "",
  "Connectors:",
  "• corsica-ferries-web",
  "• corsica-ferries-booking-rpc",
].join("\n");

const CORPUS: Case[] = [
  // ── Inconsistent (must be caught) ────────────────────────────────────
  {
    name: "corsica summary: '3 Workflows' over 2 real + 1 hedge bullet",
    text: CORSICA_SUMMARY,
    expectIssue: true,
  },
  {
    name: "corsica final tally: '5 … : 2 Workflows + 2 Connectors' (5≠4)",
    text: "Fertig. Alle 5 Corsica-Ferries-Ressourcen gelöscht: 2 Workflows + 2 Connectors.",
    expectIssue: true,
  },
  {
    name: "three-part breakdown that doesn't sum",
    text: "Deleted 10 items: 3 workflows + 3 connectors + 2 schedules.",
    expectIssue: true,
  },
  {
    name: "over-claim '4 Connectors' over 3 listed",
    text: "Found 4 Connectors:\n• github\n• notion\n• gmail",
    expectIssue: true,
  },
  // ── Consistent / clean (must stay quiet) ─────────────────────────────
  {
    name: "consistent paren breakdown 5 (3+2)",
    text: "Alle 5 Corsica-Ferries-Ressourcen (3 Workflows + 2 Connectors) wirklich löschen?",
    expectIssue: false,
  },
  {
    name: "consistent tally 4 = 2+2",
    text: "Deleted 4 resources (2 workflows + 2 connectors).",
    expectIssue: false,
  },
  {
    name: "honest list: 3 connectors over 3 bullets",
    text: "I found 3 connectors:\n• github\n• notion\n• gmail",
    expectIssue: false,
  },
  {
    name: "truncation qualifier 'Top 5 repos' over 3 bullets",
    text: "Top 5 repos:\n• a\n• b\n• c",
    expectIssue: false,
  },
  {
    name: "prose with 'and' (not + notation)",
    text: "Released 2 (3 months and 1 week ago).",
    expectIssue: false,
  },
  {
    name: "plain count, no breakdown or list",
    text: "Your tenant has 27 workflows and 13 connectors.",
    expectIssue: false,
  },
  {
    name: "full enumerated list with header count match (13 total)",
    text: "Connectors (13 total):\n• github\n• notion\n• supabase-rest",
    expectIssue: false,
  },
];

const positives = CORPUS.filter((c) => c.expectIssue);
const negatives = CORPUS.filter((c) => !c.expectIssue);

let caught = 0;
let falsePositives = 0;
const rows: string[] = [];

for (const c of CORPUS) {
  const issues = detectCountInconsistencies(c.text);
  const fired = issues.length > 0;
  if (c.expectIssue && fired) caught++;
  if (!c.expectIssue && fired) falsePositives++;
  const verdict = c.expectIssue
    ? fired
      ? "✓ caught"
      : "✗ MISSED"
    : fired
      ? "✗ FALSE POS"
      : "✓ quiet";
  const codes = issues.map((i) => i.kind).join(",") || "quiet";
  rows.push(`  ${verdict.padEnd(13)} before=—   after=${codes.padStart(20)}  ${c.name}`);
}

const recallAfter = (caught / positives.length) * 100;
const precisionAfter = ((negatives.length - falsePositives) / negatives.length) * 100;

console.log("\nChat-critic count-consistency — before/after benchmark");
console.log("=".repeat(74));
console.log(rows.join("\n"));
console.log("=".repeat(74));
console.log(
  `Corpus: ${CORPUS.length} cases (${positives.length} inconsistent, ${negatives.length} clean)\n`,
);
console.log("                              BEFORE (no check)   AFTER (detector)");
console.log(
  `  Recall  (inconsistencies caught)    0%               ${recallAfter.toFixed(0)}%   (${caught}/${positives.length})`,
);
console.log(
  `  Precision (clean stayed quiet)       —                ${precisionAfter.toFixed(0)}%   (${negatives.length - falsePositives}/${negatives.length})`,
);
console.log("");

if (recallAfter === 100 && falsePositives === 0) {
  console.log("VERDICT: ✓ improvement validated — every self-contradictory count is now caught,");
  console.log(
    "         zero false positives. Before this change the chat critic passed them all.\n",
  );
  process.exit(0);
} else {
  console.log(`VERDICT: ✗ recall ${recallAfter.toFixed(0)}%, false-positives ${falsePositives}.\n`);
  process.exit(1);
}
