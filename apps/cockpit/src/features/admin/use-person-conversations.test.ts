import { describe, expect, test } from "bun:test";
import {
  PERSON_CONVERSATION_LIMIT,
  personConversationsKey,
  personConversationsQuery,
} from "./use-person-conversations";

describe("person conversations hooks", () => {
  test("the list is cached per person under the conversations key", () => {
    expect(personConversationsKey("miriam")).toEqual(["conversations", "person", "miriam"]);
  });

  test("the list asks for that person's own conversations, newest first", () => {
    expect(personConversationsQuery("miriam")).toEqual({
      owner_id: "miriam",
      owner_kind: "user",
      sort: "updated_at",
      order: "desc",
      limit: PERSON_CONVERSATION_LIMIT,
    });
  });
});
