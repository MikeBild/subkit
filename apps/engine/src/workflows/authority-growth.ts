import { z } from "@hono/zod-openapi";

export const BoundaryGrowthSchema = z
  .object({
    kind: z.enum([
      "new_connector",
      "new_target",
      "wider_effect",
      "changed_boundary",
      "new_device",
      "new_folder",
      "wider_folder_access",
      "new_site",
      "private_site",
      "new_app",
      "new_secret",
    ]),
    connector_id: z.string().nullable(),
    connector_name: z.string().nullable().optional(),
    target: z.string().nullable(),
    effect: z.enum(["read", "write", "unknown", "destructive"]),
    device_id: z.string().uuid().optional(),
    item: z
      .string()
      .optional()
      .describe(
        "The folder id, website origin or app id that a device growth adds, or the vault handle a new_secret growth adds.",
      ),
  })
  .openapi("AuthorityBoundaryGrowth");

export type BoundaryGrowth = z.infer<typeof BoundaryGrowthSchema>;
