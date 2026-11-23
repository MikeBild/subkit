import { z } from "zod";
import { signLoginState, verifyLoginState } from "../../../auth/browser-session.ts";

export const SLACK_LINK_PATH = "/v1/integrations/slack/link";
const PURPOSE = "slack_identity_link";

const LinkClaims = z.object({
  purpose: z.literal(PURPOSE),
  tenant_id: z.string().uuid(),
  team_id: z.string().min(1).max(64),
  slack_user_id: z.string().min(1).max(64),
});

export type SlackLinkClaims = Omit<z.infer<typeof LinkClaims>, "purpose">;

export async function signSlackLinkToken(claims: SlackLinkClaims): Promise<string> {
  return await signLoginState({ purpose: PURPOSE, ...claims });
}

export async function verifySlackLinkToken(token: string): Promise<SlackLinkClaims | null> {
  if (!token) return null;
  const payload = await verifyLoginState(token);
  const parsed = LinkClaims.safeParse(payload);
  if (!parsed.success) return null;
  const { purpose: _purpose, ...claims } = parsed.data;
  return claims;
}

export function slackLinkUrl(baseUrl: string, token: string): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(SLACK_LINK_PATH, baseUrl);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return null;
  }
}
