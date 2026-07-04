// `/onboard` (alias `/install`) — the onboarding wizard wiring.
// Fetches the template catalog up-front and wires the wizard's
// probe / save / dismiss callbacks to the engine connector tools; the
// wizard overlay itself is owned by the Ink host (PaneSpec kind
// "onboarding-wizard"). Body moved verbatim from handler.ts, which
// keeps the case labels and delegates here with the canonical
// (post-alias) command name.
//
// Returns:
//   - `string | null` if the command was handled (string = banner,
//     null = pane was opened)
//   - `undefined` if the name doesn't belong to this group

import type {
  OnboardingProbeResult,
  OnboardingSaveResult,
  OnboardingTemplate,
} from "../../onboarding-wizard.tsx";
import type { SlashHandlerContext } from "../handler.ts";

export async function dispatchOnboardingSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "install":
    case "onboard": {
      // Fetch the template catalog up-front so the wizard mounts with
      // a ready list. Picking a template is the first step; the
      // remaining steps (credential → probe → save) route through the
      // existing engine connector tools so this slash command never
      // duplicates business logic — it's a UI affordance over the
      // same surface a hand-typed conversation would walk.
      const templatesResp = await ctx.client.listConnectorTemplates();
      const templates = (templatesResp.items ?? [])
        .map((raw) => {
          const slug = typeof raw.slug === "string" ? raw.slug : null;
          if (!slug) return null;
          const oauthRaw = raw.oauth as Record<string, unknown> | null | undefined;
          const oauth =
            oauthRaw && typeof oauthRaw === "object"
              ? {
                  authorization_url:
                    typeof oauthRaw.authorization_url === "string"
                      ? oauthRaw.authorization_url
                      : undefined,
                  scopes: Array.isArray(oauthRaw.scopes)
                    ? (oauthRaw.scopes.filter(
                        (s): s is string => typeof s === "string",
                      ) as string[])
                    : null,
                }
              : null;
          const template: OnboardingTemplate = {
            slug,
            ...(typeof raw.name === "string" ? { name: raw.name } : {}),
            ...(typeof raw.driver === "string" ? { driver: raw.driver } : {}),
            ...(typeof raw.auth_type === "string" ? { auth_type: raw.auth_type } : {}),
            ...(typeof raw.description === "string" ? { description: raw.description } : {}),
            ...(typeof raw.setup_instructions === "string"
              ? { setup_instructions: raw.setup_instructions }
              : {}),
            ...(oauth ? { oauth } : {}),
          };
          return template;
        })
        .filter((t): t is OnboardingTemplate => t !== null);
      if (!ctx.openPane) {
        return "/onboard requires the Ink REPL — run `sk` interactively to launch the wizard";
      }
      // Two-phase wiring: the wizard's `probe` step creates a draft
      // connector via `POST /v1/connectors/from-template/:slug` (a
      // single-shot atomic create that runs the engine's draft +
      // validate + probe pipeline), and the `save` step is a no-op
      // when the from-template route already persisted the connector.
      // For OAuth templates the from-template route returns a draft
      // that requires an OAuth start round-trip; the wizard surfaces
      // the failure reason and lets the operator retry.
      let createdConnectorId: string | null = null;
      const onProbe = async (
        template: OnboardingTemplate,
        credential: string,
      ): Promise<OnboardingProbeResult> => {
        try {
          const body: Record<string, unknown> = {};
          if (credential.length > 0) body.credential = credential;
          const resp = (await ctx.client.createConnectorFromTemplate(template.slug, body)) as {
            ok?: boolean;
            connector?: { id?: string };
            id?: string;
            reason?: string;
          };
          if (resp.ok === false) {
            return { ok: false, reason: resp.reason ?? "probe failed" };
          }
          createdConnectorId = resp.connector?.id ?? resp.id ?? null;
          if (!createdConnectorId) {
            return {
              ok: false,
              reason: "engine returned no connector id — cannot probe",
            };
          }
          // Confirm liveness via the explicit /test endpoint so the
          // wizard's probe step matches what `sk` users would run by
          // hand. A failing test is the operator-facing analog of a
          // failed `probe_connector_draft` tool call.
          const testResp = (await ctx.client.testConnector(createdConnectorId)) as {
            ok?: boolean;
            reason?: string;
          };
          if (testResp.ok === false) {
            return { ok: false, reason: testResp.reason ?? "connector test failed" };
          }
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            reason: err instanceof Error ? err.message : "probe call failed",
          };
        }
      };
      const onSave = async (
        _template: OnboardingTemplate,
        _credential: string,
      ): Promise<OnboardingSaveResult> => {
        // The probe step already persisted the connector via the
        // from-template route. Save is a no-op acknowledgement so
        // the wizard's step machine stays consistent across template
        // types (OAuth flows that need a follow-up call would
        // override this in the future).
        if (createdConnectorId) {
          return { ok: true, connector_id: createdConnectorId };
        }
        return { ok: false, reason: "probe must succeed before save" };
      };
      const onComplete = (_result: {
        status: "saved" | "cancelled" | "skipped";
        reason?: string;
      }): void => {
        // Pane dismissal is owned by the host — the wizard component
        // calls onDone, the host clears the pane via setPane(null).
        // We pass through here so the type-checker is satisfied.
      };
      ctx.openPane({
        kind: "onboarding-wizard",
        title: "onboarding",
        templates,
        onProbe,
        onSave,
        onComplete,
      });
      return null;
    }
    default:
      return undefined;
  }
}
