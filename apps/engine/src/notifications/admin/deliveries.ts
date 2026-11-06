import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type NotificationDeliveryRow,
  notificationDeliveries,
} from "../../db/schema/notifications.ts";

export type { NotificationDeliveryRow };

interface ListDeliveriesInput {
  limit: number;
  offset: number;
  status?: string | undefined;
}

export async function listRecentDeliveries(
  db: Db,
  tenantId: string,
  input: ListDeliveriesInput,
): Promise<NotificationDeliveryRow[]> {
  const tenantWhereClauses = [eq(notificationDeliveries.tenant_id, tenantId)];
  if (input.status) {
    tenantWhereClauses.push(eq(notificationDeliveries.status, input.status));
  }
  return db
    .select()
    .from(notificationDeliveries)
    .where(tenantWhereClauses.length === 1 ? tenantWhereClauses[0] : and(...tenantWhereClauses))
    .orderBy(desc(notificationDeliveries.created_at))
    .limit(input.limit)
    .offset(input.offset);
}
