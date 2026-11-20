import { describe, expect, test } from "bun:test";
import { checkContent, collectContent, fullContent, MAX_GIVEN_CONTENT_CHARS } from "../content.ts";
import { spokenFacts } from "../spoken.ts";

const NOW = new Date("2026-11-20T10:00:00Z");
const facts = (...texts: string[]) => spokenFacts(texts, NOW, "Europe/Berlin");

describe("text that goes to someone else must be the person's own or a draft they saw", () => {
  test("an action without text needs no check", () => {
    expect(checkContent([], facts("Markiere Aufgabe 12 als erledigt"), [])).toEqual({
      ok: true,
      basis: "none",
    });
  });

  test("the person's words in another order and inflection count as given", () => {
    const said = facts("Schick Anna eine Mail, dass ich 10 Minuten später komme");
    expect(checkContent(["Verspätung", "Ich komme 10 Minuten später."], said, [])).toEqual({
      ok: true,
      basis: "given",
    });
    expect(
      checkContent(["Das Meeting fällt aus."], facts("Schreib Bob, dass das Meeting ausfällt"), [])
        .ok,
    ).toBe(true);
    expect(checkContent(["Hallo Anna, vielen Dank!"], facts("Danke an anna@firma.de"), []).ok).toBe(
      true,
    );
  });

  test("more than a quarter of new words, capped at three, asks", () => {
    const said = facts("Tell Bob the build is green and tests pass");
    expect(checkContent(["The build is green and tests pass, deployed."], said, []).ok).toBe(true);
    expect(
      checkContent(["The build is green, tests pass, deploy starts, rollback ready."], said, []).ok,
    ).toBe(false);
    expect(checkContent(["Resign"], said, []).ok).toBe(false);
    expect(checkContent(["Build resigned"], said, []).ok).toBe(false);
    expect(checkContent(["Status", "Build green"], said, []).ok).toBe(true);
    expect(checkContent(["Status update", "Build green"], said, []).ok).toBe(false);
  });

  test("a number, link, address, handle or negation the person did not write asks", () => {
    const said = facts("Schreib an anna@firma.de, dass ich um 15 Uhr komme");
    expect(checkContent(["Ich komme um 15 Uhr."], said, []).ok).toBe(true);
    expect(checkContent(["Ich komme um 16 Uhr."], said, []).ok).toBe(false);
    expect(checkContent(["Ich komme nicht um 15 Uhr."], said, []).ok).toBe(false);
    expect(checkContent(["Ich komme, siehe https://x.example"], said, []).ok).toBe(false);
    expect(checkContent(["Ich komme, cc chef@firma.de"], said, []).ok).toBe(false);
    expect(checkContent(["Ich komme @alle"], said, []).ok).toBe(false);
    expect(checkContent(["I don't come"], facts("Tell her I come"), []).ok).toBe(false);
  });

  test("a draft the person saw in the conversation counts, an altered one does not", () => {
    const said = facts("Ja, schick sie ab");
    const shown = ["Entwurf:\n\nBetreff: Angebot\n\nHallo Anna, anbei das Angebot für März."];
    expect(
      checkContent(["Angebot", "Hallo Anna, anbei das Angebot für März."], said, shown),
    ).toEqual({ ok: true, basis: "shown" });
    expect(
      checkContent(["Angebot", "Hallo Anna, anbei das Angebot für April."], said, shown).ok,
    ).toBe(false);
  });

  test("text longer than a person dictates in chat must have been shown", () => {
    const long = "komme ".repeat(MAX_GIVEN_CONTENT_CHARS / 6 + 1);
    expect(checkContent([long], facts("ich komme"), []).ok).toBe(false);
    expect(checkContent([long], facts("ich komme"), [long]).ok).toBe(true);
  });

  test("content fields are found in nested bodies and returned in full for the card", () => {
    const args = {
      method: "POST",
      path: "/rest/api/3/issue",
      body: {
        fields: { summary: "Drucker", description: { content: [{ text: "druckt nicht" }] } },
      },
    };
    const fields = collectContent("call_connector", args);
    expect(fields).toEqual(["Drucker", "druckt nicht"]);
    expect(fullContent(fields)).toBe("Drucker\n\ndruckt nicht");
    expect(fullContent([])).toBeNull();
    expect(collectContent("call_connector", { body: "raw=1" })).toEqual(["raw=1"]);
    expect(collectContent("mcp_mail_send", { to: "a@b.example", message: "Hi" })).toEqual(["Hi"]);
  });
});
