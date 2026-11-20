import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useSetup } from "@/api/setup";
import { Toaster } from "@/components/ui/sonner";
import { useI18n } from "@/lib/i18n-context";
import { SetupStep } from "@/pages/setup";
import {
  postponeSetup,
  type SetupGateView,
  setupGateView,
  setupOffered,
  setupPostponed,
} from "@/pages/setup-model";
import { useSession } from "./session";

export function SetupGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const session = useSession();
  const person = useMemo(
    () => ({ tenantId: session.tenant.id, userId: session.principal.id }),
    [session.tenant.id, session.principal.id],
  );
  const offered = setupOffered(session.permissions);
  const setup = useSetup(offered);
  const [state, setState] = useState<SetupGateView>("checking");
  const view = setupGateView({
    permissions: session.permissions,
    postponed: setupPostponed(person),
    setup: setup.data,
    failed: setup.isError,
  });
  useEffect(() => {
    if (state === "checking" && view !== "checking") setState(view);
  }, [state, view]);
  const shown = state === "checking" ? view : state;
  if (shown === "passed") return children;
  if (shown === "open" && setup.data)
    return (
      <>
        <SetupStep
          setup={setup.data}
          onDone={() => setState("passed")}
          onLater={() => {
            postponeSetup(person);
            setState("passed");
          }}
        />
        <Toaster richColors position="bottom-right" />
      </>
    );
  return (
    <div
      className="min-h-full bg-background"
      role="status"
      aria-busy="true"
      aria-label={t("common.loading")}
      data-testid="setup-checking"
    />
  );
}
