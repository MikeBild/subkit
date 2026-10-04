import { z } from "@hono/zod-openapi";

export const BoundaryGrowthSchema = z
  .object({
    kind: z.enum(["new_connector", "new_target", "wider_effect", "changed_boundary"]),
    connector_id: z.string().nullable(),
    connector_name: z.string().nullable().optional(),
    target: z.string().nullable(),
    effect: z.enum(["read", "write", "unknown", "destructive"]),
  })
  .openapi("AuthorityBoundaryGrowth");

export type BoundaryGrowth = z.infer<typeof BoundaryGrowthSchema>;
