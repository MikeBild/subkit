import { describe, expect, test } from "bun:test";
import { actorDirectory } from "@/app/actor-directory-model";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  approvalActivatesSkill,
  isKnowledgeFact,
  mayApproveProposal,
  proposalAddition,
  proposalAuthor,
  proposalDomain,
  proposalTarget,
} from "./learning-proposal-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);
const LENA = "11111111-1111-4111-8111-111111111111";

describe("learning proposals", () => {
  test("a fact lands in the knowledge of its domain, a practice in a skill", () => {
    const fact = { pattern_kind: "knowledge_learning" as const, tags: ["domain:betrieb"] };
    expect(proposalTarget(fact, de)).toBe("Wissen · betrieb");
    expect(proposalTarget(fact, en)).toBe("Knowledge · betrieb");
    expect(proposalTarget({ pattern_kind: "knowledge_learning", tags: [] }, de)).toBe(
      "Wissen · gemeinsam Gelerntes",
    );
    expect(proposalTarget({ pattern_kind: "session_learning", tags: ["domain:betrieb"] }, de)).toBe(
      "Skill",
    );
    expect(
      proposalDomain({ pattern_kind: "knowledge_learning", tags: ["kind:x", "domain:ops"] }),
    ).toBe("ops");
  });

  test("only a practice or pattern asks to activate a skill", () => {
    expect(isKnowledgeFact({ pattern_kind: "knowledge_learning" })).toBe(true);
    expect(approvalActivatesSkill({ pattern_kind: "knowledge_learning" })).toBe(false);
    expect(approvalActivatesSkill({ pattern_kind: "session_learning" })).toBe(true);
    expect(approvalActivatesSkill({ pattern_kind: "repair_pattern" })).toBe(true);
  });

  test("a fact needs knowledge:write to approve, a practice needs skill:activate", () => {
    const fact = { pattern_kind: "knowledge_learning" as const };
    const practice = { pattern_kind: "session_learning" as const };
    expect(mayApproveProposal(fact, ["skill:write", "skill:activate"])).toBe(false);
    expect(mayApproveProposal(fact, ["skill:write", "knowledge:write"])).toBe(true);
    expect(mayApproveProposal(practice, ["skill:write", "knowledge:write"])).toBe(false);
    expect(mayApproveProposal(practice, ["skill:write", "skill:activate"])).toBe(true);
    expect(mayApproveProposal(fact, ["knowledge:write"])).toBe(false);
  });

  test("the author is named from the directory, else by kind; a detected pattern has none", () => {
    const directory = actorDirectory(
      { items: [{ id: LENA, email: "lena@example.com" }] },
      { items: [{ id: LENA, name: "Service" }] },
    );
    expect(
      proposalAuthor({ proposed_by: { kind: "system_account", id: LENA } }, directory, de),
    ).toBe("Service");
    expect(proposalAuthor({ proposed_by: { kind: "user", id: LENA } }, directory, de)).toBe(
      "lena@example.com",
    );
    expect(
      proposalAuthor({ proposed_by: { kind: "system_account", id: "x" } }, directory, de),
    ).toBe("Systemkonto");
    expect(proposalAuthor({ proposed_by: null }, directory, de)).toBeNull();
  });

  test("the change to the source is the section the fact appends", () => {
    expect(
      proposalAddition({ title: " Bereitschaft ", body: "Nachts nur per Telefon wecken.\n" }),
    ).toEqual([
      { type: "added", text: "## Bereitschaft" },
      { type: "added", text: "" },
      { type: "added", text: "Nachts nur per Telefon wecken." },
    ]);
  });
});
