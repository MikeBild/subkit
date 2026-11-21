import { describe, expect, test } from "bun:test";
import { render } from "@/features/settings/model/settings-fixtures";
import { groupByKind, type VaultItem } from "@/features/vault/model/vault";
import { VaultActivityList, VaultDetail, VaultEmpty, VaultList, VaultRevealed } from "./page";

function handle(path: string): string {
  return `\${secret.${path}}`;
}

function item(overrides: Partial<VaultItem> = {}): VaultItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "crm-token",
    kind: "secret",
    scope: "workspace",
    environment: "prod",
    description: null,
    version: 2,
    connector: null,
    template_slug: null,
    fields: ["token"],
    created_at: "2026-11-01T08:00:00.000Z",
    updated_at: "2026-11-01T08:00:00.000Z",
    rotated_at: null,
    last_used_at: null,
    ...overrides,
  };
}

function detail(entry: VaultItem, permissions: readonly string[] = [], revealed = false) {
  return render(
    <VaultDetail
      item={entry}
      permissions={permissions}
      revealed={revealed ? { token: "s3cr3t" } : null}
      secondsLeft={12}
      revealPending={false}
      activity={null}
      onReveal={() => {}}
      onHide={() => {}}
      onRotate={() => {}}
      onDelete={() => {}}
      onOpenConnector={() => {}}
    />,
  );
}

describe("vault list", () => {
  test("groups by kind and shows environment, version, scope and that it was never used", () => {
    const html = render(
      <VaultList
        groups={groupByKind([item(), item({ id: "2", name: "erp", kind: "login" })])}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('data-testid="vault-group-secret"');
    expect(html).toContain('data-testid="vault-group-login"');
    expect(html).toContain("API-Key oder Token");
    expect(html).toContain("Version 2");
    expect(html).toContain("Noch nie genutzt");
    expect(html).toContain("Echtbetrieb");
    expect(html).toContain("Arbeitsbereich");
    expect(html).toContain('data-testid="vault-item-crm-token-prod-open"');
  });

  test("the empty vault explains adding an entry and the handle", () => {
    const html = render(
      <VaultEmpty scope="workspace" total={0} canWriteWorkspace onAdd={() => {}} />,
    );
    expect(html).toContain("Der Tresor ist leer");
    expect(html).toContain(handle("crm-token"));
    expect(html).toContain("Eintrag hinzufügen");
  });
});

describe("vault detail", () => {
  test("a shared entry without rights shows its handle but no actions", () => {
    const html = detail(item());
    expect(html).toContain(`value="${handle("crm-token")}"`);
    expect(html).not.toContain('data-testid="vault-reveal-button"');
    expect(html).not.toContain('data-testid="vault-rotate"');
    expect(html).not.toContain('data-testid="vault-delete"');
  });

  test("an own login offers reveal, replace and delete with handles per field", () => {
    const html = detail(item({ kind: "login", name: "erp", scope: "person" }));
    expect(html).toContain(`value="${handle("me.erp.username")}"`);
    expect(html).toContain(`value="${handle("me.erp.password")}"`);
    expect(html).toContain("Aufdecken");
    expect(html).toContain("Wert ersetzen");
    expect(html).toContain("Löschen");
  });

  test("a connector access links to its connector and cannot take a new value", () => {
    const html = detail(
      item({
        kind: "connector",
        connector: { id: "c1", slug: "hubspot", display_name: "HubSpot" },
      }),
      ["vault:read", "vault:rotate", "vault:delete"],
    );
    expect(html).toContain('data-testid="vault-connector-link"');
    expect(html).not.toContain('data-testid="vault-handle"');
    expect(html).toContain("Connector HubSpot öffnen");
    expect(html).not.toContain('data-testid="vault-rotate"');
    expect(html).toContain('data-testid="vault-delete"');
  });

  test("a template client names its template", () => {
    const html = detail(item({ kind: "template_client", template_slug: "google" }));
    expect(html).toContain("Connector-Vorlage google");
  });

  test("revealed values show with copy and the countdown", () => {
    const html = render(
      <VaultRevealed values={{ token: "s3cr3t" }} secondsLeft={12} onHide={() => {}} />,
    );
    expect(html).toContain('value="s3cr3t"');
    expect(html).toContain("Wird in 12 s wieder verborgen");
    expect(detail(item({ scope: "person" }), [], true)).toContain('data-testid="vault-revealed"');
  });

  test("activity names each action and keeps unknown ones as written", () => {
    const html = render(
      <VaultActivityList
        entries={[
          {
            id: "a1",
            at: "2026-11-20T08:00:00.000Z",
            action: "vault.item.revealed",
            actor_type: "user",
            actor_id: "u1",
            result: "success",
            metadata: {},
          },
          {
            id: "a2",
            at: "2026-11-19T08:00:00.000Z",
            action: "credential.rotated",
            actor_type: "user",
            actor_id: "u1",
            result: "success",
            metadata: {},
          },
          {
            id: "a3",
            at: "2026-11-18T08:00:00.000Z",
            action: "vault.item.unknown",
            actor_type: "system",
            actor_id: null,
            result: "denied",
            metadata: {},
          },
        ]}
      />,
    );
    expect(html).toContain("Tresor-Wert aufgedeckt");
    expect(html).toContain("Zugangsdaten gewechselt");
    expect(html).toContain("vault.item.unknown");
    expect(render(<VaultActivityList entries={[]} />)).toContain("Noch nichts aufgezeichnet.");
  });
});
