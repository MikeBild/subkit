import { ConfirmDialog } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";

export function StopRunDialog({
  name,
  open,
  onOpenChange,
  pending,
  onConfirm,
  testId,
}: {
  name: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  pending: boolean;
  onConfirm(): void | Promise<void>;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      object={name ? t("tasks.stop.object", { name }) : t("chat.taskRun.abort.object")}
      verb={t("tasks.stop.verb")}
      confirmLabel={t("tasks.menu.stop")}
      dismissLabel={t("tasks.stop.dismiss")}
      consequence={t("tasks.stop.consequence")}
      destructive
      pending={pending}
      onConfirm={onConfirm}
      testId={testId}
    />
  );
}
