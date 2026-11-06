import { afterAll, beforeAll } from "bun:test";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import type { ChatAdapter } from "../adapter.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";

let nextHex = createDeterministicHexFactory(0xc4a7d15);

export const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

export class FakeSlackAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  sends: ChatDelivery[] = [];
  approvals: ApprovalCard[] = [];
  async verify(): Promise<VerifiedEvent | null> {
    return null;
  }
  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    return ev as unknown as ChatEvent;
  }
  async send(d: ChatDelivery) {
    this.sends.push(d);
    return { platform_message_id: `msg-${this.sends.length}` };
  }
  async update(_d: ChatDelivery, _id: string) {}
  async sendApproval(c: ApprovalCard) {
    this.approvals.push(c);
    return { platform_message_id: `ap-${this.approvals.length}` };
  }
}

export let ctx: ConversationTestCtx;

export function setupChatDispatcher(): void {
  nextHex = createDeterministicHexFactory(0xc4a7d15);
  beforeAll(async () => {
    ctx = await createConversationTestCtx("dispatcher");
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
}
