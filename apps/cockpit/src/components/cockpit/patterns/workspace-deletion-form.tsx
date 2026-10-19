import { Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useI18n } from "@/lib/i18n-context";
import { WorkspaceConfirmation } from "./workspace-confirmation";

export function WorkspaceDeletionForm({
  tenant,
  deletion,
  open,
  setOpen,
  confirmation,
  setConfirmation,
}: {
  tenant: { display_name: string };
  deletion: { isPending: boolean; error: unknown; mutate(value: string): void };
  open: boolean;
  setOpen(value: boolean): void;
  confirmation: string;
  setConfirmation(value: string): void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Separator />
      <section className="grid gap-4 py-6 md:grid-cols-[220px_1fr] md:gap-8">
        <div>
          <h2 className="text-sm font-semibold">{t("workspace.delete")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("workspace.deleteDescription", { name: tenant.display_name })}
          </p>
        </div>
        <div className="space-y-4">
          {deletion.error ? (
            <Alert variant="destructive">
              <AlertDescription>{t("workspace.actionError")}</AlertDescription>
            </Alert>
          ) : null}
          <Button
            data-testid="workspace-delete-open"
            variant="destructive"
            size="sm"
            onClick={() => {
              setConfirmation("");
              setOpen(true);
            }}
          >
            <Trash2 className="size-4" />
            {t("workspace.delete")}
          </Button>
        </div>
      </section>
      <WorkspaceConfirmation
        open={open}
        onOpenChange={setOpen}
        title={t("workspace.deleteTitle", { name: tenant.display_name })}
        description={t("workspace.deleteIntro")}
        confirmLabel={t("workspace.confirmDelete")}
        pendingLabel={t("workspace.deleting")}
        pending={deletion.isPending}
        disabled={confirmation !== tenant.display_name}
        onConfirm={() => deletion.mutate(confirmation)}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t("workspace.c1")}</li>
          <li>{t("workspace.c2")}</li>
          <li>{t("workspace.c3")}</li>
          <li>{t("workspace.c4")}</li>
          <li>{t("workspace.c5")}</li>
        </ul>
        <div className="grid gap-2">
          <Label htmlFor="workspace-confirm-name">
            {t("workspace.confirmation", { name: tenant.display_name })}
          </Label>
          <Input
            data-testid="workspace-delete-name"
            id="workspace-confirm-name"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={deletion.isPending}
          />
        </div>
      </WorkspaceConfirmation>
    </>
  );
}
