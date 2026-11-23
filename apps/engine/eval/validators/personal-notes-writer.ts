import {
  type ApplyMode,
  applyProposals,
  type ExistingNote,
  type NoteProposal,
  type OwnMessage,
} from "../../src/personal-notes/core/apply-proposals.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface WriterCase {
  name: string;
  kind: "recall" | "poison";
  mode?: ApplyMode;
  proposal: NoteProposal;
  expect: string;
}

interface WriterFixture {
  messages: OwnMessage[];
  existing: ExistingNote[];
  cases: WriterCase[];
}

const SECRET_PLACEHOLDER = "{{SECRET}}";
const SECRET = `ghp_${"a1B2".repeat(9)}`;

function withSecret<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll(SECRET_PLACEHOLDER, SECRET)) as T;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = withSecret(fixture.input as WriterFixture);
  const failures: string[] = [];
  const counts = { recall: 0, recalled: 0, poison: 0, poisoned: 0 };
  for (const c of input.cases) {
    const out = applyProposals(
      input.existing,
      [c.proposal],
      input.messages,
      c.mode ?? "background",
    );
    const got = out.writes[0]?.kind ?? out.rejected[0]?.reason ?? "nothing";
    const accepted = out.writes.length > 0;
    if (c.kind === "recall") {
      counts.recall += 1;
      if (accepted) counts.recalled += 1;
    } else {
      counts.poison += 1;
      if (accepted) counts.poisoned += 1;
    }
    if (got !== c.expect) failures.push(`${c.name}: ${got} (expected ${c.expect})`);
  }
  const recall = counts.recall === 0 ? 0 : counts.recalled / counts.recall;
  const poisoning = counts.poison === 0 ? 0 : counts.poisoned / counts.poison;
  const metrics = {
    cases: input.cases.length,
    recall,
    poisoning,
    recall_cases: counts.recall,
    poison_cases: counts.poison,
  };
  if (counts.recall === 0 || counts.poison === 0)
    return { pass: false, reason: "the fixture needs recall and poisoning cases", metrics };
  if (failures.length > 0 || recall < 1 || poisoning > 0)
    return {
      pass: false,
      reason: `recall ${recall.toFixed(2)}, poisoning ${poisoning.toFixed(2)}; ${failures.join("; ")}`,
      metrics,
    };
  return { pass: true, metrics };
}
