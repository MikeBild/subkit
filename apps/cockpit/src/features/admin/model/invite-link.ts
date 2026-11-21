export const INVITE_PAGE = "/cockpit/invite";

export function inviteLink(origin: string, token: string): string {
  return `${origin}${INVITE_PAGE}#${token}`;
}
