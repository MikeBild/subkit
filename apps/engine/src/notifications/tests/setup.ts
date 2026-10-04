import type { ChatAdapter } from "../../chat/adapter.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../../chat/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { __resetBreakers } from "../circuit-breaker.ts";
import { __resetRateLimiter } from "../rate-limit.ts";

export interface NotificationTestCtx {
  testDb: TestDb;
  db: Db;
  tenant_id: string;
  cleanup: () => Promise<void>;
}

export async function createNotificationCtx(label: string): Promise<NotificationTestCtx> {
  __resetRateLimiter();
  __resetBreakers();
  const testDb = await createTestDb(`notif_${label}`);
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: `t-notif-${label}`, display_name: `Notif ${label}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  return {
    testDb,
    db: testDb.db,
    tenant_id: tenant.id,
    cleanup: async () => {
      await testDb.cleanup();
    },
  };
}

export class FakeAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  sends: ChatDelivery[] = [];
  approvals: ApprovalCard[] = [];
  failOn: ((d: ChatDelivery) => boolean) | null = null;
  alwaysFail = false;

  async verify(): Promise<VerifiedEvent | null> {
    return null;
  }
  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    return ev as unknown as ChatEvent;
  }
  async send(d: ChatDelivery): Promise<{ platform_message_id: string }> {
    if (this.alwaysFail) throw new Error("adapter: forced failure");
    if (this.failOn?.(d)) throw new Error("adapter: conditional failure");
    this.sends.push(d);
    return { platform_message_id: `msg-${this.sends.length}` };
  }
  async update(_d: ChatDelivery, _id: string): Promise<void> {}
  async sendApproval(c: ApprovalCard): Promise<{ platform_message_id: string }> {
    this.approvals.push(c);
    return { platform_message_id: `ap-${this.approvals.length}` };
  }
}
