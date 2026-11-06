import { Bell, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type CockpitInstallation, createCockpitInstallation } from "@/api/cockpit-installations";
import { type AttentionFresh, useAttentionFresh } from "@/app/attention-seen";
import { cockpitApiHref, installationId } from "@/app/installation-context";
import { useInstallation } from "@/app/installation-provider";
import { AttentionDot } from "@/app/live-indicator";
import { useSession } from "@/app/session";
import { IconButton } from "@/components/cockpit/icon-button";
import { Button, FormDialog, Switch } from "@/components/cockpit/patterns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

interface DeferredInstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallationDialogMode = { kind: "install" } | { kind: "open"; href: string };

export function installationDialogMode(
  currentInstallationId: string | null,
  installation: Pick<CockpitInstallation, "start_url"> | null,
): InstallationDialogMode {
  if (currentInstallationId || !installation) return { kind: "install" };
  return { kind: "open", href: installation.start_url };
}

interface NotificationDialogInput {
  installed: boolean;
  supported: boolean;
  permission: NotificationPermission | null;
  subscribed: boolean | null;
  pending: boolean;
  handledByApp: boolean;
}

interface NotificationDialogState {
  bell: boolean;
  checked: boolean;
  disabled: boolean;
  note: "hint" | "denied" | "handledByApp";
}

export function notificationDialogState(input: NotificationDialogInput): NotificationDialogState {
  const bell = input.installed || input.supported;
  if (!input.supported) return { bell, checked: false, disabled: true, note: "hint" };
  if (input.permission === "denied")
    return { bell, checked: false, disabled: true, note: "denied" };
  if (input.handledByApp && input.subscribed !== true)
    return { bell, checked: false, disabled: true, note: "handledByApp" };
  if (input.subscribed === null) return { bell, checked: false, disabled: true, note: "hint" };
  return {
    bell,
    checked: input.subscribed && input.permission === "granted",
    disabled: input.pending,
    note: "hint",
  };
}

function notificationPermission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

export function InstallationDialog({
  open,
  onOpenChange,
  tenantName,
  installation = null,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tenantName: string;
  installation?: Pick<CockpitInstallation, "start_url"> | null;
}) {
  const { t } = useI18n();
  const mode = installationDialogMode(installationId(), installation);
  const session = useSession();
  const [prompt, setPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [creating, setCreating] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const appName = tenantName;
  const appIcon = cockpitApiHref(
    session.branding?.app_icon_urls.icon_512 ?? "/cockpit/app-icon-192.png",
  );
  useEffect(() => {
    const listener = (event: Event) => {
      event.preventDefault();
      setPrompt(event as DeferredInstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", listener);
    return () => window.removeEventListener("beforeinstallprompt", listener);
  }, []);
  const install = async () => {
    if (mode.kind === "open") {
      window.location.assign(mode.href);
      return;
    }
    if (installationId() && !prompt) {
      setUnavailable(true);
      return;
    }
    setCreating(true);
    try {
      if (prompt) {
        await prompt.prompt();
        setPrompt(null);
        onOpenChange(false);
        return;
      }
      const installation = await createCockpitInstallation();
      window.location.assign(`${installation.start_url}?install=1`);
    } catch {
      toast.error(t("common.actionFailed"));
    } finally {
      setCreating(false);
    }
  };
  return (
    <>
      <FormDialog
        open={open && !unavailable}
        onOpenChange={onOpenChange}
        title={t("installation.installTitle", { name: appName })}
        description={t("installation.installDescription")}
        submit={{
          label: t(mode.kind === "open" ? "installation.openApp" : "installation.installAction"),
          pending: creating,
        }}
        onSubmit={install}
        testId="installation-dialog"
      >
        <div className="flex items-center gap-4 rounded-lg border bg-muted/30 p-4">
          <img src={appIcon} alt="" className="size-12 shrink-0 rounded-xl object-cover" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{appName}</p>
            <p className="truncate text-xs text-muted-foreground">{window.location.host}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            mode.kind === "open"
              ? "installation.notificationsInApp"
              : installationId()
                ? "installation.installHint"
                : "installation.notificationsAfterInstall",
          )}
        </p>
      </FormDialog>
      <FormDialog
        open={unavailable}
        onOpenChange={(next) => {
          setUnavailable(next);
          if (!next) onOpenChange(false);
        }}
        title={t("installation.unavailableTitle")}
        cancelLabel={t("common.close")}
        testId="installation-unavailable-dialog"
      >
        <p className="text-sm text-muted-foreground">{t("installation.unavailable")}</p>
      </FormDialog>
    </>
  );
}

function InstallationNotificationsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const {
    available,
    capabilities,
    enablePush,
    disablePush,
    pushSubscribed,
    handledByApp,
    refreshPushSubscription,
  } = useInstallation();
  const [pending, setPending] = useState(false);
  const [permission, setPermission] = useState(notificationPermission);
  useEffect(() => {
    if (!open) return;
    setPermission(notificationPermission());
    void refreshPushSubscription().catch(() => toast.error(t("common.actionFailed")));
  }, [open, refreshPushSubscription, t]);
  const state = notificationDialogState({
    installed: available,
    supported: capabilities.push,
    permission,
    subscribed: pushSubscribed,
    pending,
    handledByApp,
  });
  const toggle = async (checked: boolean) => {
    setPending(true);
    try {
      if (checked) await enablePush();
      else await disablePush();
    } catch {
      toast.error(t("common.actionFailed"));
    } finally {
      setPermission(notificationPermission());
      setPending(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("installation.notifications")}
      cancelLabel={t("common.close")}
      testId="installation-notifications-dialog"
    >
      <div className="flex items-center justify-between gap-4 py-1">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("installation.notificationsEnable")}</p>
          {state.note === "denied" ? null : (
            <p className="text-xs text-muted-foreground">
              {t(
                state.note === "handledByApp"
                  ? "installation.notificationsHandledByApp"
                  : "installation.notificationsHint",
              )}
            </p>
          )}
        </div>
        <Switch
          checked={state.checked}
          disabled={state.disabled}
          onCheckedChange={(checked) => void toggle(checked)}
          aria-label={t("installation.notificationsEnable")}
        />
      </div>
      {state.note === "denied" ? (
        <p className="flex gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Bell className="size-4 shrink-0" />
          {t("installation.notificationsDenied")}
        </p>
      ) : null}
    </FormDialog>
  );
}

export function notificationBellLabel(fresh: AttentionFresh | null): TranslationKey {
  return fresh ? "installation.notificationsNew" : "installation.notifications";
}

export function NotificationBellIcon({ fresh }: { fresh: AttentionFresh | null }) {
  return (
    <span className="relative flex">
      <Bell />
      {fresh && <AttentionDot stopped={fresh.stopped} />}
    </span>
  );
}

export function InstallationNotificationControl() {
  const { t } = useI18n();
  const session = useSession();
  const { available, capabilities } = useInstallation();
  const fresh = useAttentionFresh(session);
  const [open, setOpen] = useState(false);
  if (!available && !capabilities.push) return null;
  return (
    <>
      <IconButton
        type="button"
        variant="ghost"
        size="icon"
        label={t(notificationBellLabel(fresh))}
        data-testid="installation-notifications"
        data-attention-new={String(fresh !== null)}
        onClick={() => setOpen(true)}
      >
        <NotificationBellIcon fresh={fresh} />
      </IconButton>
      <InstallationNotificationsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function InstallationFollowupPrompt({ tenantName }: { tenantName: string }) {
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      installationId() !== null &&
      new URLSearchParams(window.location.search).get("install") === "1",
  );
  return (
    <InstallationDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          const url = new URL(window.location.href);
          url.searchParams.delete("install");
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        }
      }}
      tenantName={tenantName}
    />
  );
}

export function InstallationInputActions({
  onFiles,
  onClipboard,
  disabled = false,
}: {
  onFiles(files: File[]): void;
  onClipboard(): void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { capabilities } = useInstallation();
  const chooseFiles = () => {
    if (disabled) return;
    const picker = (
      window as Window & {
        showOpenFilePicker?: () => Promise<Array<{ getFile(): Promise<File> }>>;
      }
    ).showOpenFilePicker;
    if (capabilities.fileOpen && picker) {
      void picker
        .call(window)
        .then(async (handles) =>
          onFiles(await Promise.all(handles.map(async (handle) => await handle.getFile()))),
        )
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          toast.error(t("installation.importFailed"));
        });
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.md,.csv,.json,.pdf";
    input.multiple = true;
    input.onchange = () => onFiles([...(input.files ?? [])]);
    input.click();
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClipboard}
        disabled={disabled || !capabilities.clipboard}
        data-testid="installation-import-clipboard"
      >
        <Upload />
        {t("installation.clipboard")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={chooseFiles}
        disabled={disabled}
        data-testid="installation-import-file"
      >
        <Upload />
        {t("installation.openFile")}
      </Button>
    </div>
  );
}
