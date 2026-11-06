import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type {
  OnboardingProbeResult,
  OnboardingSaveResult,
  OnboardingTemplate,
} from "../../onboarding-wizard.tsx";
import type { SlashHandlerContext } from "../handler.ts";

type ConnectorTemplate = components["schemas"]["ConnectorTemplateListResponse"]["items"][number];
type CredentialBody = components["schemas"]["CredentialBody"];
type TemplateHints = Pick<ConnectorTemplate, "credential_hints">;

export type OnboardingCredential =
  | { ok: true; body: CredentialBody | null }
  | { ok: false; reason: string };

function templateHeaderName(template: TemplateHints | undefined): string | null {
  return template?.credential_hints.find((hint) => hint.header_name)?.header_name ?? null;
}

export function onboardingCredential(
  connectorId: string,
  authType: string,
  template: TemplateHints | undefined,
  secret: string,
): OnboardingCredential {
  const byHand = (flags: string) =>
    `store it with \`sk credentials set ${connectorId} --mode ${authType}${flags}\` instead`;
  const value = secret.trim();
  if (!value) return { ok: true, body: null };
  switch (authType) {
    case "none":
      return { ok: true, body: null };
    case "bearer":
      return { ok: true, body: { mode: "bearer", token: value } };
    case "signed_jwt":
      return { ok: true, body: { mode: "signed_jwt", private_key: value } };
    case "header": {
      const name = templateHeaderName(template);
      return name
        ? { ok: true, body: { mode: "header", headers: { [name]: value } } }
        : {
            ok: false,
            reason: `the template names no header for this key; ${byHand(' --header "Name=Value"')}`,
          };
    }
    case "query":
      return {
        ok: false,
        reason: `the template names no query parameter for this key; ${byHand(' --query "name=Value"')}`,
      };
    case "oauth2":
      return {
        ok: false,
        reason: `this connector signs in with an account; run \`sk auth --connector-id ${connectorId}\` instead`,
      };
    default:
      return {
        ok: false,
        reason: `${authType} sign-in needs more than one value; ${byHand("")}`,
      };
  }
}

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
      const created = new Map<string, { id: string; auth_type: string }>();
      const onProbe = async (
        template: OnboardingTemplate,
        credential: string,
      ): Promise<OnboardingProbeResult> => {
        createdConnectorId = null;
        try {
          const connector =
            created.get(template.slug) ??
            (await ctx.client.createConnectorFromTemplate(template.slug, {}));
          if (!connector.id) {
            return {
              ok: false,
              reason: "engine returned no connector id — cannot probe",
            };
          }
          created.set(template.slug, { id: connector.id, auth_type: connector.auth_type });
          const stored = onboardingCredential(
            connector.id,
            connector.auth_type,
            templatesResp.items.find((item) => item.slug === template.slug),
            credential,
          );
          if (!stored.ok) return { ok: false, reason: stored.reason };
          if (stored.body) await ctx.client.createCredential(connector.id, stored.body);
          createdConnectorId = connector.id;
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
