import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n-context";
import { useLiveStatus } from "./live-events";
import { useSession } from "./session";

// A new release is live when the engine the stream reconnects to names another
// version than the one this bundle booted against — the Cockpit ships inside
// the engine, so the two change together.
//
// The notice is the only way to reload: nothing reloads on its own, and the
// reload asks first while a form holds unsaved input.

const dirtyForms = new Set<symbol>();

/** True while any registered form holds unsaved input. */
export function hasDirtyForms(): boolean {
  return dirtyForms.size > 0;
}

/**
 * Registers a form's unsaved state, so a reload offered by the new-version
 * notice never throws away what someone is typing.
 */
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

/** Whether a version announced by the engine differs from the booted one. */
export function isNewVersion(booted: string, announced: string | null): boolean {
  return announced !== null && announced !== "" && announced !== booted;
}

export const VERSION_TOAST_ID = "cockpit-new-version";

export function VersionNotice() {
  const session = useSession();
  const { serverVersion } = useLiveStatus();
  const { t } = useI18n();
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!isNewVersion(session.version, serverVersion) || shown.current === serverVersion) return;
    shown.current = serverVersion;
    const show = () =>
      toast(t("platform.newVersion"), {
        id: VERSION_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: t("platform.reload"),
          onClick: () => {
            // Unsaved input stays: the notice comes back once the form is saved.
            if (hasDirtyForms()) {
              toast.warning(t("platform.reloadDirty"));
              setTimeout(show, 0);
              return;
            }
            window.location.reload();
          },
        },
      });
    show();
  }, [serverVersion, session.version, t]);

  return null;
}
