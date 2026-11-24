import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { reloadIntoUpdate, useWaitingUpdate } from "@/features/pwa";
import { useI18n } from "@/lib/i18n-context";
import { useLiveStatus } from "./live-events";
import { useSession } from "./session";
import { handleReloadAction } from "./version-notice-model";

const dirtyForms = new Set<symbol>();

function hasDirtyForms(): boolean {
  return dirtyForms.size > 0;
}

export function useDirtyGuard(dirty: boolean): void {
  const id = useRef(Symbol("form"));
  useEffect(() => {
    const key = id.current;
    if (dirty) dirtyForms.add(key);
    else dirtyForms.delete(key);
    return () => {
      dirtyForms.delete(key);
    };
  }, [dirty]);
}

export function isNewVersion(booted: string, announced: string | null): boolean {
  return announced !== null && announced !== "" && announced !== booted;
}

const VERSION_TOAST_ID = "cockpit-new-version";

export function VersionNotice() {
  const session = useSession();
  const { serverVersion } = useLiveStatus();
  const { t } = useI18n();
  const shown = useRef<string | null>(null);
  const waitingUpdate = useWaitingUpdate();

  useEffect(() => {
    const fresh = isNewVersion(session.version, serverVersion)
      ? serverVersion
      : waitingUpdate
        ? "update"
        : null;
    if (fresh === null || shown.current === fresh) return;
    shown.current = fresh;
    toast(t("platform.newVersion"), {
      id: VERSION_TOAST_ID,
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: t("platform.reload"),
        onClick: (event) =>
          handleReloadAction({
            dirty: hasDirtyForms(),
            preventDefault: () => event.preventDefault(),
            warn: () => toast.warning(t("platform.reloadDirty")),
            reload: () => void reloadIntoUpdate(),
          }),
      },
    });
  }, [serverVersion, session.version, t, waitingUpdate]);

  return null;
}
