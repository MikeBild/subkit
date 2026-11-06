import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type {
  OnboardingProbeResult,
  OnboardingSaveResult,
  OnboardingTemplate,
} from "../../onboarding-wizard.tsx";
import type { SlashHandlerContext } from "../handler.ts";

type ConnectorTemplate = components["schemas"]["ConnectorTemplateListResponse"]["items"][number];

function oauthScopes(scopes: string | undefined): string[] | null {
  if (scopes === undefined) return null;
  return scopes.split(/\s+/).filter((scope) => scope.length > 0);
}

function onboardingTemplate(raw: ConnectorTemplate): OnboardingTemplate {
  return {
    slug: raw.slug,
    name: raw.name,
    driver: raw.driver,
    auth_type: raw.auth_type,
    description: raw.description,
    setup_instructions: raw.setup_instructions,
    ...(raw.oauth
      ? {
          oauth: {
            authorization_url: raw.oauth.authorization_endpoint,
            scopes: oauthScopes(raw.oauth.scopes),
          },
        }
      : {}),
  };
}

export async function dispatchOnboardingSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "install":
    case "onboard": {
      const templatesResp = await ctx.client.listConnectorTemplates();
      const templates = templatesResp.items.map(onboardingTemplate);
      if (!ctx.openPane) {
        return "/onboard requires the Ink REPL — run `sk` interactively to launch the wizard";
      }
      let createdConnectorId: string | null = null;
      const onProbe = async (
        template: OnboardingTemplate,
        _credential: string,
      ): Promise<OnboardingProbeResult> => {
        try {
          const created = await ctx.client.createConnectorFromTemplate(template.slug, {});
          createdConnectorId = created.id || null;
          if (!createdConnectorId) {
            return {
              ok: false,
              reason: "engine returned no connector id — cannot probe",
            };
          }
          const testResp = await ctx.client.testConnector(createdConnectorId);
          if (!testResp.ok) {
            return { ok: false, reason: testResp.detail ?? "connector test failed" };
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
        if (createdConnectorId) {
          return { ok: true, connector_id: createdConnectorId };
        }
        return { ok: false, reason: "probe must succeed before save" };
      };
      const onComplete = (_result: {
        status: "saved" | "cancelled" | "skipped";
        reason?: string;
      }): void => {};
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
