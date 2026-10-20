import { expect, test } from "bun:test";
import { SidebarProvider } from "@/components/ui/sidebar";
import { render, renderInRouter } from "./test-utils";
import { WorkspaceChangedPage } from "./workspace-changed";
import { WorkspaceMenu } from "./workspace-menu";
import { WorkspaceRecovery } from "./workspace-recovery";

test("workspace menu renders its loading state before memberships arrive", async () => {
  const html = await renderInRouter(
    <SidebarProvider>
      <WorkspaceMenu
        items={undefined}
        tenantId="tenant"
        tenantName="Local workspace"
        changing={false}
        changingTenantId={undefined}
        loading={true}
        loadError={null}
        changeError={null}
        open={false}
        onOpenChange={() => {}}
        onSwitch={() => {}}
      />
    </SidebarProvider>,
  );
  expect(html).toContain('data-testid="cockpit-wordmark-name"');
  expect(html).toContain("Local workspace");
});

test("workspace change retains an explicit reload action", () => {
  const html = render(<WorkspaceChangedPage />);
  expect(html).toContain('data-testid="workspace-changed"');
  expect(html).toContain("<button");
});

test("recovery can load without an authenticated workspace", () => {
  const html = render(
    <WorkspaceRecovery
      state={{ data: undefined, isPending: true }}
      providers={{ data: undefined, error: null }}
      login={{ isPending: false, error: null, mutate() {} }}
      restore={{ isPending: false, error: null, mutate() {} }}
      confirm={false}
      setConfirm={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Wird geladen"');
  expect(html).not.toContain('role="alertdialog"');
});
