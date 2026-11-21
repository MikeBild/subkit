import { describe, expect, test } from "bun:test";
import { conversationsAboutQuery } from "@/api/client";
import { conversationsAboutReferences } from "./conversations-about";

const SKILL = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";

describe("conversations about a record", () => {
  test("a skill asks for conversations that reference it", () => {
    const query = conversationsAboutQuery({ skill_id: SKILL });
    expect(query.get("referenced_skill_id")).toBe(SKILL);
    expect(query.get("referenced_knowledge_source_id")).toBeNull();
    expect(query.get("owner_kind")).toBe("user");
    expect(query.get("sort")).toBe("updated_at");
  });

  test("a knowledge source asks for conversations that reference it", () => {
    const query = conversationsAboutQuery({ knowledge_source_id: SOURCE });
    expect(query.get("referenced_knowledge_source_id")).toBe(SOURCE);
    expect(query.get("referenced_skill_id")).toBeNull();
  });

  test("starting a chat from the empty state carries the record as @ reference", () => {
    expect(conversationsAboutReferences({ skill_id: SKILL })).toEqual([
      { type: "skill", id: SKILL },
    ]);
    expect(conversationsAboutReferences({ knowledge_source_id: SOURCE })).toEqual([
      { type: "knowledge_source", id: SOURCE },
    ]);
  });
});
