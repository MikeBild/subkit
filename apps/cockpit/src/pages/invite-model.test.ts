import { describe, expect, test } from "bun:test";
import {
  type InvitePreview,
  inviteLink,
  inviteToken,
  inviteView,
  joinCommand,
} from "./invite-model";

const TOKEN = "skinv_0123456789abcdef";

const preview: InvitePreview = {
  workspace_name: "Albrecht & Partner",
  invited_by_name: "Jonas Albrecht",
  email_hint: "m•••@example.com",
  expires_at: "2026-11-24T13:00:00.000Z",
  providers: [{ id: "workforce", label: "Workforce" }],
};

const none = { data: undefined, failed: false, code: null };
const refused = (code: string | null) => ({ data: undefined, failed: true, code });

describe("the invitation link", () => {
  test("carries the token in the fragment, where no server sees it", () => {
    expect(inviteLink("https://subkit.example", TOKEN)).toBe(
      `https://subkit.example/cockpit/invite#${TOKEN}`,
    );
    expect(inviteToken(`#${TOKEN}`)).toBe(TOKEN);
    expect(inviteToken(TOKEN)).toBe(TOKEN);
  });

  test("a missing, cut or malformed fragment is no token", () => {
    expect(inviteToken("")).toBeNull();
    expect(inviteToken("#short")).toBeNull();
    expect(inviteToken(`#${"x".repeat(129)}`)).toBeNull();
    expect(inviteToken("#has space inside it")).toBeNull();
    expect(inviteToken("#%E0%A4%A")).toBeNull();
  });

  test("the command line joins the same engine with the same token", () => {
    expect(joinCommand("https://subkit.example", TOKEN)).toBe(
      `sk join --invite ${TOKEN} --engine-url https://subkit.example`,
    );
  });
});

describe("what the invitation page shows", () => {
  test("a valid link opens the invitation", () => {
    expect(inviteView({ search: "", token: TOKEN, preview: none })).toEqual({ kind: "loading" });
    expect(inviteView({ search: "", token: TOKEN, preview: { ...none, data: preview } })).toEqual({
      kind: "open",
      preview,
    });
  });

  test("a workspace without browser sign-in is joined with the command line", () => {
    const view = inviteView({
      search: "",
      token: TOKEN,
      preview: { ...none, data: { ...preview, providers: [] } },
    });
    expect(view).toEqual({ kind: "cli", token: TOKEN });
    expect(
      inviteView({ search: "", token: TOKEN, preview: refused("invite_credential_only") }),
    ).toEqual({ kind: "cli", token: TOKEN });
  });

  test("no fragment is an invalid link, without asking the engine", () => {
    expect(inviteView({ search: "", token: null, preview: none })).toEqual({ kind: "invalid" });
  });

  test("each refusal of the preview has its own state", () => {
    const view = (code: string | null) =>
      inviteView({ search: "", token: TOKEN, preview: refused(code) });
    expect(view("invite_invalid")).toEqual({ kind: "invalid" });
    expect(view("invite_expired")).toEqual({ kind: "expired" });
    expect(view("invite_revoked")).toEqual({ kind: "gone", signIn: false });
    expect(view("invite_unavailable")).toEqual({ kind: "gone", signIn: false });
    expect(view("invite_already_redeemed")).toEqual({ kind: "gone", signIn: true });
    expect(view("rate_limit_exceeded")).toEqual({ kind: "unreachable" });
    expect(view(null)).toEqual({ kind: "unreachable" });
  });

  test("after the sign-in the page finishes the join or names why it could not", () => {
    const back = (search: string, token: string | null = null) =>
      inviteView({ search, token, preview: none });
    expect(back("?joined=1")).toEqual({ kind: "joined" });
    expect(back("?error=identity_mismatch")).toEqual({ kind: "mismatch", retry: false });
    expect(back("?error=identity_mismatch", TOKEN)).toEqual({ kind: "mismatch", retry: true });
    expect(back("?error=invite_invalid")).toEqual({ kind: "invalid" });
    expect(back("?error=invite_unavailable")).toEqual({ kind: "gone", signIn: false });
    for (const code of [
      "invite_credential_only",
      "hosted_provider_required",
      "hosted_provider_unavailable",
      "tenant_unavailable",
      "something_new",
    ])
      expect(back(`?error=${code}`)).toEqual({ kind: "unavailable" });
  });
});
