// Test fixture: the answering actor a unit test stands in for.
//
// `AnswerActor` has no default in `src/` on purpose — every production surface
// must declare whether a PERSON produced the answer it is resuming with, because
// only a person can grant an approval. Tests that drive the resume path directly
// (`maybeAutoPersistFromElicitation`, `tryFastPath`) need a value; unless they
// are asserting the relay contract, that value is a person at a keyboard.

import type { AnswerActor } from "../conversations/answer-actor.ts";

/** A person answering through the chat channel. Any test asserting a GRANT must
 *  use a `user_id` that is a real uuid — `grantApproval` rejects anything else. */
export const TEST_HUMAN_ANSWER: AnswerActor = {
  kind: "human",
  user_id: "00000000-0000-4000-8000-000000000001",
  via: "chat",
};

/** A person answering through the chat channel, named. */
export function testHumanAnswer(user_id: string): AnswerActor {
  return { kind: "human", user_id, via: "chat" };
}
