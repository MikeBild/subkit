import { describe, expect, test } from "bun:test";
import {
  applyProposals,
  type ExistingNote,
  MAX_ACTIVE_NOTES,
  MAX_NOTE_ABSTRACT_CHARS,
  MAX_NOTE_TEXT_CHARS,
  type NoteProposal,
  type OwnMessage,
} from "./apply-proposals.ts";

const SECRET = `ghp_${"a1B2".repeat(9)}`;

const messages: OwnMessage[] = [
  { id: "m1", conversation_id: "c1", text: "Please note that I send invoices every Friday." },
  { id: "m2", conversation_id: "c2", text: "As I said, I send invoices every Friday afternoon." },
  {
    id: "m3",
    conversation_id: "c3",
    text: "Summarize this for me.\n\n> I always travel by train to Hamburg.\n> Book me a seat.",
  },
  { id: "m4", conversation_id: "c4", text: `My token is ${SECRET} and I work from Berlin.` },
];

function proposal(extra: Partial<NoteProposal> = {}): NoteProposal {
  return {
    area: "routines",
    slug: "invoice-day",
    origin: "stated",
    fact_kind: "fact",
    text: "Sends invoices every Friday.",
    abstract: "Invoice day is Friday",
    quote: "I send invoices every Friday",
    message_id: "m1",
    ...extra,
  };
}

function existing(extra: Partial<ExistingNote> = {}): ExistingNote {
  return {
    id: "n1",
    area: "routines",
    slug: "invoice-day",
    text: "Sends invoices every Friday.",
    confirmed: false,
    version: 1,
    source_message_ids: ["m1"],
    ...extra,
  };
}

describe("applyProposals: what becomes a note", () => {
  test("a quote found in the person's own words creates a note with that source", () => {
    const out = applyProposals([], [proposal()], messages, "background");
    expect(out.rejected).toEqual([]);
    expect(out.writes).toEqual([
      {
        kind: "create",
        area: "routines",
        slug: "invoice-day",
        origin: "stated",
        fact_kind: "fact",
        text: "Sends invoices every Friday.",
        abstract: "Invoice day is Friday",
        confirmed: false,
        source: { message_id: "m1", conversation_id: "c1", quote: "I send invoices every Friday" },
      },
    ]);
  });

  test("an explicit request creates the note already confirmed", () => {
    const out = applyProposals([], [proposal()], messages, "explicit");
    expect(out.writes[0]).toMatchObject({ kind: "create", confirmed: true });
  });

  test("text and abstract are trimmed, a missing abstract falls back to the clipped text", () => {
    const long = `${"word ".repeat(60)}end`;
    const out = applyProposals(
      [],
      [proposal({ text: `  ${long}  `, abstract: "   " })],
      messages,
      "background",
    );
    const write = out.writes[0];
    expect(write?.kind).toBe("create");
    if (write?.kind !== "create") return;
    expect(write.text).toBe(long);
    expect(write.abstract.length).toBeLessThanOrEqual(MAX_NOTE_ABSTRACT_CHARS);
    expect(long.startsWith(write.abstract)).toBe(true);
  });

  test("a repeat from another conversation adds a source and leaves the text alone", () => {
    const out = applyProposals(
      [existing()],
      [proposal({ message_id: "m2", text: "sends invoices every friday." })],
      messages,
      "background",
    );
    expect(out.writes).toEqual([
      {
        kind: "add_source",
        note_id: "n1",
        expected_version: 1,
        confirm: false,
        source: { message_id: "m2", conversation_id: "c2", quote: "I send invoices every Friday" },
      },
    ]);
  });

  test("a changed text replaces an unconfirmed note at its version", () => {
    const out = applyProposals(
      [existing({ version: 4 })],
      [proposal({ message_id: "m2", text: "Sends invoices every Friday afternoon." })],
      messages,
      "background",
    );
    expect(out.writes[0]).toMatchObject({
      kind: "replace",
      note_id: "n1",
      expected_version: 4,
      text: "Sends invoices every Friday afternoon.",
      confirmed: false,
    });
  });
});

describe("applyProposals: confirmed notes", () => {
  const confirmed = existing({ confirmed: true });

  test("background learning never changes a confirmed note", () => {
    const out = applyProposals(
      [confirmed],
      [proposal({ message_id: "m2", text: "Sends invoices every Friday afternoon." })],
      messages,
      "background",
    );
    expect(out.writes).toEqual([]);
    expect(out.rejected).toEqual([{ index: 0, reason: "confirmed_note_kept" }]);
  });

  test("background learning may still add a source to a confirmed note", () => {
    const out = applyProposals(
      [confirmed],
      [proposal({ message_id: "m2" })],
      messages,
      "background",
    );
    expect(out.writes[0]).toMatchObject({ kind: "add_source", confirm: false });
  });

  test("an explicit request replaces a confirmed note and keeps it confirmed", () => {
    const out = applyProposals(
      [confirmed],
      [proposal({ message_id: "m2", text: "Sends invoices every Friday afternoon." })],
      messages,
      "explicit",
    );
    expect(out.writes[0]).toMatchObject({ kind: "replace", confirmed: true });
  });

  test("an explicit repeat confirms the note it adds a source to", () => {
    const out = applyProposals(
      [existing()],
      [proposal({ message_id: "m2" })],
      messages,
      "explicit",
    );
    expect(out.writes[0]).toMatchObject({ kind: "add_source", confirm: true });
  });
});

describe("applyProposals: what is rejected", () => {
  test.each([
    ["an unknown area", { area: "secrets" }, "invalid_address"],
    ["a slug with capitals", { slug: "Invoice-Day" }, "invalid_address"],
    ["an empty slug", { slug: "" }, "invalid_address"],
    ["an unknown origin", { origin: "guessed" }, "invalid_address"],
    ["an unknown fact kind", { fact_kind: "rumour" }, "invalid_address"],
    ["an empty text", { text: "   " }, "invalid_text"],
    ["a text over the limit", { text: "x".repeat(MAX_NOTE_TEXT_CHARS + 1) }, "text_too_long"],
    ["a message id of someone else", { message_id: "foreign" }, "message_not_own"],
    ["a one-word quote", { quote: "invoices" }, "quote_too_short"],
    ["a quote over the limit", { quote: `I send ${"very ".repeat(90)}much` }, "quote_too_long"],
    [
      "a quote the person never wrote",
      { quote: "I send invoices every Monday" },
      "quote_not_in_own_words",
    ],
    [
      "a quote from another message",
      { quote: "I send invoices every Friday afternoon" },
      "quote_not_in_own_words",
    ],
    [
      "a quote from pasted text",
      { message_id: "m3", quote: "I always travel by train to Hamburg" },
      "quote_not_in_own_words",
    ],
    [
      "a secret in the text",
      { message_id: "m4", quote: "I work from Berlin", text: `Token ${SECRET}` },
      "secret_in_text",
    ],
    [
      "a secret in the abstract",
      { message_id: "m4", quote: "I work from Berlin", abstract: `Token ${SECRET}` },
      "secret_in_text",
    ],
    [
      "a secret in the quote",
      { message_id: "m4", quote: `My token is ${SECRET}`, text: "Works from Berlin." },
      "secret_in_quote",
    ],
  ] as const)("%s", (_label, patch, reason) => {
    const out = applyProposals([], [proposal(patch)], messages, "background");
    expect(out.writes).toEqual([]);
    expect(out.rejected).toEqual([{ index: 0, reason }]);
  });

  test("a text exactly at the limit is accepted", () => {
    const out = applyProposals(
      [],
      [proposal({ text: "x".repeat(MAX_NOTE_TEXT_CHARS) })],
      messages,
      "background",
    );
    expect(out.rejected).toEqual([]);
  });

  test("the same message is never a source twice", () => {
    const out = applyProposals([existing()], [proposal()], messages, "background");
    expect(out.rejected).toEqual([{ index: 0, reason: "source_already_known" }]);
  });

  test("a second proposal for the same address in one batch is rejected", () => {
    const out = applyProposals(
      [],
      [proposal(), proposal({ message_id: "m2" }), proposal({ slug: "other", message_id: "m2" })],
      messages,
      "background",
    );
    expect(out.writes.map((write) => write.kind)).toEqual(["create", "create"]);
    expect(out.rejected).toEqual([{ index: 1, reason: "repeated_in_batch" }]);
  });

  test("a rejected proposal does not block a later one for the same address", () => {
    const out = applyProposals(
      [],
      [proposal({ quote: "invoices" }), proposal()],
      messages,
      "background",
    );
    expect(out.rejected).toEqual([{ index: 0, reason: "quote_too_short" }]);
    expect(out.writes).toHaveLength(1);
  });

  test("the cap stops new notes and still lets existing ones gain sources", () => {
    const full = Array.from({ length: MAX_ACTIVE_NOTES - 1 }, (_, i) =>
      existing({ id: `n${i}`, slug: `slug-${i}`, source_message_ids: [] }),
    );
    const out = applyProposals(
      full,
      [
        proposal({ slug: "fits" }),
        proposal({ slug: "over" }),
        proposal({ slug: "slug-0", message_id: "m2" }),
      ],
      messages,
      "background",
    );
    expect(out.writes.map((write) => write.kind)).toEqual(["create", "add_source"]);
    expect(out.rejected).toEqual([{ index: 1, reason: "note_limit" }]);
  });
});
