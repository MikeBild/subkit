import { redactPaymentData } from "@shared/redaction.ts";

export type WithheldKind = "card" | "iban" | "cvv" | "otp";

export interface WithheldChatText {
  readonly text: string;
  readonly withheld: readonly WithheldKind[];
}

const WITHHELD_KINDS: readonly WithheldKind[] = ["card", "iban", "cvv", "otp"];

const CODE_VALUE = String.raw`(?:\d{6,8}|\d{3}[ -]\d{3,4})(?![\d-])`;
const LEAD = String.raw`(?:\s+(?:is|was|ist|lautet|war))?[\s:=#"'\u201e\u201c]{1,4}`;

const CONTEXT_PATTERNS: ReadonlyArray<{ kind: WithheldKind; regex: RegExp }> = [
  {
    kind: "cvv",
    regex: new RegExp(
      String.raw`(?<=(?:sicherheitscode|pr\u00fcfnummer|pr\u00fcfziffer|kartenpr\u00fcfnummer)${LEAD})\d{3,4}(?![\d-])`,
      "giu",
    ),
  },
  {
    kind: "otp",
    regex: new RegExp(
      String.raw`(?<=(?:code|\btan|passcode|\botp|einmalpasswort|einmalkennwort)${LEAD})${CODE_VALUE}`,
      "giu",
    ),
  },
];

const BARE_CODE = new RegExp(String.raw`^\s*${CODE_VALUE}\s*$`, "u");

function marker(kind: WithheldKind): string {
  return `***REDACTED:${kind}***`;
}

function markerCount(text: string, kind: WithheldKind): number {
  return text.split(marker(kind)).length - 1;
}

export function withholdPaymentData(text: string): WithheldChatText {
  let out = redactPaymentData(text);
  for (const { kind, regex } of CONTEXT_PATTERNS) out = out.replace(regex, marker(kind));
  if (BARE_CODE.test(out)) out = marker("otp");
  const withheld = WITHHELD_KINDS.filter(
    (kind) => markerCount(out, kind) > markerCount(text, kind),
  );
  return { text: out, withheld };
}
