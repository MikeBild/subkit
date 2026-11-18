import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StatusBadge, statusTone } from "@/components/cockpit/patterns";
import { render } from "@/components/cockpit/patterns/test-utils";
import { InviteLinkBody, InviteRoleLines, validInviteEmail } from "./people-tab";

const invite = {
  email: "mira@example.com",
  token: "skinv_0123456789abcdef",
  expiresAt: "2026-11-24T13:00:00.000Z",
};

describe("the invitation link step", () => {
  test("hands over one link for one address and says SubKit sends no email", () => {
    const html = render(
      <InviteLinkBody invite={invite} origin="https://subkit.example" selfHosted={false} />,
    );
    expect(html).toContain(
      "Gib diesen Link an mira@example.com weiter. SubKit verschickt keine E-Mail.",
    );
    expect(html).toContain('value="https://subkit.example/cockpit/invite#skinv_0123456789abcdef"');
    expect(html).toContain("Der Link funktioniert nur einmal und nur für diese Adresse.");
    expect(html).toContain("Gültig bis ");
  });

  test("a hosted workspace shows no command line", () => {
    const html = render(
      <InviteLinkBody invite={invite} origin="https://subkit.example" selfHosted={false} />,
    );
    expect(html).not.toContain("Mit der Kommandozeile beitreten");
    expect(html).not.toContain("sk join");
  });

  test("a self-hosted workspace keeps the command, collapsed", () => {
    const html = render(
      <InviteLinkBody invite={invite} origin="https://subkit.example" selfHosted />,
    );
    expect(html).toContain("Mit der Kommandozeile beitreten");
    expect(html).toMatch(/data-state="closed"[^>]*data-testid="people-invite-cli"/);
  });

  test("shows no raw code and no technical word", () => {
    const text = render(
      <InviteLinkBody invite={invite} origin="https://subkit.example" selfHosted={false} />,
    ).replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/Einladungscode|Token|tenant/i);
  });
});

describe("inviting a person", () => {
  test("is one call that creates the person and the invitation together", () => {
    const source = readFileSync(resolve(import.meta.dir, "people-tab.tsx"), "utf8");
    const dialog = source.slice(source.indexOf("export function InvitePersonDialog"));
    expect(dialog).toContain('apiCall("post", "/v1/identity/users", {');
    expect(dialog).toContain("invite: {},");
    expect(dialog).not.toContain("/v1/identity/users/{id}/invites");
    expect(source).not.toMatch(/SecretDialog|people\.inviteCode/);
  });

  test("the address is checked before anything is sent", () => {
    expect(validInviteEmail(" mira@example.com ")).toBe(true);
    for (const wrong of ["", "mira", "mira@", "mira@example", "mi ra@example.com"])
      expect(validInviteEmail(wrong)).toBe(false);
  });

  test("every role says in one line what it is for", () => {
    const html = render(<InviteRoleLines roles={undefined} />);
    expect(html).toContain("Administrator");
    expect(html).toContain("Verwaltet Personen, Verbindungen und Einstellungen.");
    expect(html).toContain("Erstellt und startet Workflows.");
    expect(html).toContain("Startet freigegebene Workflows.");
  });
});

describe("an invited person in the list", () => {
  test("reads Eingeladen in the neutral tone, not as something waiting for you", () => {
    expect(statusTone("invited")).toBe("neutral");
    const html = render(<StatusBadge state="invited" />);
    expect(html).toContain("Eingeladen");
    expect(html).toContain('data-tone="neutral"');
    expect(html).not.toContain("Wartet auf dich");
  });

  test("the row menu re-creates the link or withdraws the invitation, with a confirmation", () => {
    const source = readFileSync(resolve(import.meta.dir, "people-tab.tsx"), "utf8");
    expect(source).toContain('row.status === "invited"');
    expect(source).toContain('t("people.invite.again")');
    expect(source).toContain('t("people.invite.withdraw")');
    expect(source).toContain('testId="people-invite-withdraw-confirm"');
  });
});
