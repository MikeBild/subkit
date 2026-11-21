import { expect, test } from "bun:test";
import { Alert, AlertDescription, AlertTitle } from "@ui/molecules/alert";
import { SidebarProvider } from "@ui/organisms/sidebar";
import { WorkspaceMenu } from "@/features/settings/ui/workspace-menu";
import { FormDialog } from "./form-dialog";
import { StandaloneStatus } from "./standalone-status";
import { render, renderInRouter } from "./test-utils";
import { WorkspaceConfirmation } from "./workspace-confirmation";

test("centered status preserves the existing main and notice markup", () => {
  expect(
    render(
      <StandaloneStatus layout="centered" title="Changed" testId="changed">
        <p>Reload</p>
      </StandaloneStatus>,
    ),
  ).toBe(
    render(
      <main className="flex min-h-full items-start justify-center bg-background px-4 py-6 md:px-8">
        <Alert className="max-w-2xl" data-testid="changed">
          <AlertTitle>Changed</AlertTitle>
          <AlertDescription>
            <p>Reload</p>
          </AlertDescription>
        </Alert>
      </main>,
    ),
  );
});

test("reading status preserves its column, icon, variant and notice markup", () => {
  expect(
    render(
      <StandaloneStatus
        layout="reading"
        title="Recovery"
        icon={<span>Icon</span>}
        variant="destructive"
      >
        <p>Details</p>
      </StandaloneStatus>,
    ),
  ).toBe(
    render(
      <main className="min-h-full bg-background px-4 py-6 md:px-8">
        <div className="mx-auto max-w-lg py-16">
          <Alert variant="destructive">
            <span>Icon</span>
            <AlertTitle>Recovery</AlertTitle>
            <AlertDescription>
              <p>Details</p>
            </AlertDescription>
          </Alert>
        </div>
      </main>,
    ),
  );
});

test("workspace menu retains the sidebar trigger, busy state and visible caller content", async () => {
  const html = await renderInRouter(
    <SidebarProvider>
      <WorkspaceMenu
        items={[]}
        tenantId="fixture-tenant"
        tenantName="Workspace"
        changing
        changingTenantId={undefined}
        loading={false}
        loadError={null}
        changeError={null}
        open={false}
        onOpenChange={() => {}}
        onSwitch={() => {}}
      />
    </SidebarProvider>,
  );
  expect(html).toContain('data-testid="cockpit-wordmark"');
  expect(html).toContain('aria-label="Arbeitsbereich wechseln"');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('data-size="lg"');
  expect(html).toContain("Workspace");
  expect(html).toContain("data-[state=open]:bg-sidebar-accent");
});

test("workspace confirmation uses the form pattern and blocks close or confirm while pending or disabled", () => {
  let confirmations = 0;
  let closes = 0;
  const base = {
    open: true,
    onOpenChange: () => {
      closes++;
    },
    title: "Confirm",
    description: "Review",
    confirmLabel: "Confirm",
    pendingLabel: "Working",
    onConfirm: () => {
      confirmations++;
    },
  };
  const pending = WorkspaceConfirmation({ ...base, pending: true });
  expect(pending.type).toBe(FormDialog);
  pending.props.onOpenChange(false);
  pending.props.onSubmit();
  expect(closes).toBe(0);
  expect(confirmations).toBe(0);
  expect(pending.props.submit.pending).toBe(true);
  const disabled = WorkspaceConfirmation({ ...base, pending: false, disabled: true });
  disabled.props.onSubmit();
  expect(confirmations).toBe(0);
  const active = WorkspaceConfirmation({ ...base, pending: false, destructive: false });
  active.props.onSubmit();
  active.props.onOpenChange(false);
  expect(confirmations).toBe(1);
  expect(closes).toBe(1);
  expect(active.props.submit.destructive).toBe(false);
});
