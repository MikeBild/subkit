import { Bell, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { createCockpitInstallation } from "@/api/cockpit-installations";
import { cockpitApiHref, installationId } from "@/app/installation-context";
import { useInstallation } from "@/app/installation-provider";
import { useSession } from "@/app/session";
import { Button, FormDialog } from "@/components/cockpit/patterns";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/lib/i18n-context";

interface DeferredInstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallationDialog({
  open,
  onOpenChange,
  tenantName,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  tenantName: string;
}) {
  const { t } = useI18n();
  const session = useSession();
  const [prompt, setPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [creating, setCreating] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const appName = session.branding?.display_name || tenantName;
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
    if (prompt) {
      await prompt.prompt();
      setPrompt(null);
      onOpenChange(false);
      return;
    }
    if (installationId()) {
      setUnavailable(true);
      return;
    }
    setCreating(true);
    try {
      const installation = await createCockpitInstallation();
      window.location.assign(`${installation.start_url}?install=1`);
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
        submit={{ label: t("installation.installAction"), pending: creating }}
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
        <p className="text-xs text-muted-foreground">{t("installation.installHint")}</p>
      </FormDialog>
      <FormDialog
        open={unavailable}
        onOpenChange={setUnavailable}
        title={t("installation.unavailableTitle")}
        testId="installation-unavailable-dialog"
      >
        <p className="text-sm text-muted-foreground">{t("installation.unavailable")}</p>
      </FormDialog>
    </>
  );
}

export function InstallationNotificationsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const { capabilities, enablePush, disablePush, pushSubscribed, refreshPushSubscription } =
    useInstallation();
  const [pending, setPending] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (open) void refreshPushSubscription().catch(() => {});
  }, [open, refreshPushSubscription]);
  const toggle = async (checked: boolean) => {
    setPending(true);
    try {
      if (checked) {
        const enabled = await enablePush();
        setDenied(!enabled && Notification.permission === "denied");
      } else await disablePush();
    } finally {
      setPending(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("installation.notifications")}
      testId="installation-notifications-dialog"
    >
      <div className="flex items-center justify-between gap-4 py-1">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("installation.notificationsEnable")}</p>
          <p className="text-xs text-muted-foreground">{t("installation.notificationsHint")}</p>
        </div>
        <Switch
          checked={pushSubscribed === true}
          disabled={pending || !capabilities.push}
          onCheckedChange={(checked) => void toggle(checked)}
          aria-label={t("installation.notificationsEnable")}
        />
      </div>
      {denied ||
      (capabilities.push &&
        typeof Notification !== "undefined" &&
        Notification.permission === "denied") ? (
        <p className="flex gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Bell className="size-4 shrink-0" />
          {t("installation.notificationsDenied")}
        </p>
      ) : null}
    </FormDialog>
  );
}

export function InstallationNotificationControl() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!installationId()) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("installation.notifications")}
        onClick={() => setOpen(true)}
      >
        <Bell />
      </Button>
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
      void picker()
        .then(async (handles) =>
          onFiles(await Promise.all(handles.map(async (handle) => await handle.getFile()))),
        )
        .catch(() => {});
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
      >
        <Upload />
        {t("installation.clipboard")}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={chooseFiles} disabled={disabled}>
        <Upload />
        {t("installation.openFile")}
      </Button>
    </div>
  );
}
