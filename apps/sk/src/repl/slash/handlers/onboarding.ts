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
