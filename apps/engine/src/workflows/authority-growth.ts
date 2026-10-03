import { z } from "@hono/zod-openapi";

/** One thing a new version reaches that an approval did not cover.
 *
 *  new_connector: a connector the approval never reached.
 *  new_target: a known connector, but a new address on it.
 *  wider_effect: a known address, now written to (or deleted from) where it was
 *  only read — or an effect the engine cannot classify.
 *  changed_boundary: a known address whose connector configuration, credential
 *  or declared request boundary changed. */
export const BoundaryGrowthSchema = z
  .object({
    kind: z.enum(["new_connector", "new_target", "wider_effect", "changed_boundary"]),
    connector_id: z.string().nullable(),
    /** The connector's display name when the growth was recorded. */
    connector_name: z.string().nullable().optional(),
    target: z.string().nullable(),
    effect: z.enum(["read", "write", "unknown", "destructive"]),
  })
  .openapi("AuthorityBoundaryGrowth");

export type BoundaryGrowth = z.infer<typeof BoundaryGrowthSchema>;
