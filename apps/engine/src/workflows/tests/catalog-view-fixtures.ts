import { connectors } from "../../db/schema/index.ts";
import type { TestDb } from "../../db/tests/setup.ts";
import { createWorkflow } from "../service.ts";

export function catalogViewFixtures(state: { readonly ctx: TestDb; readonly tenant_id: string }) {
  async function seedConnector(slug: string): Promise<string> {
    const [row] = await state.ctx.db
      .insert(connectors)
      .values({
        tenant_id: state.tenant_id,
        slug,
        display_name: slug,
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://api.example.test",
        config: {},
      })
      .returning();
    if (!row) throw new Error(`seed connector ${slug} failed`);
    return row.id;
  }

  async function seedWorkflow(
    slug: string,
    step: Record<string, unknown>,
    category?: string,
  ): Promise<string> {
    const result = await createWorkflow(
      {
        tenant_id: state.tenant_id,
        actor_id: null,
        def: { name: slug, slug, steps: [step] },
        ...(category ? { metadata: { category } } : {}),
      },
      state.ctx.db,
    );
    if (!result.workflow) throw new Error(`seed ${slug} failed: ${JSON.stringify(result.errors)}`);
    return result.workflow.id;
  }

  return { seedConnector, seedWorkflow };
}
