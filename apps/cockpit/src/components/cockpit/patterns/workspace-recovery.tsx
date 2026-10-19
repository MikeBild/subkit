import { Clock, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import type { paths } from "@/api/schema";
import type { readRecovery } from "@/api/tenant-lifecycle";
import { loginHref } from "@/app/session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n-context";
import { WorkspaceConfirmation } from "./workspace-confirmation";

type RecoveryProviders =
  paths["/v1/identity/recovery/providers"]["get"]["responses"][200]["content"]["application/json"];
export function WorkspaceRecovery({
  state,
  providers,
  login,
  restore,
  confirm,
  setConfirm,
}: {
  state: { data: Awaited<ReturnType<typeof readRecovery>> | undefined; isPending: boolean };
  providers: { data: RecoveryProviders | undefined; error: unknown };
  login: { isPending: boolean; error: unknown; mutate(id: string): void };
  restore: { isPending: boolean; error: unknown; mutate(token: string): void };
  confirm: boolean;
  setConfirm(value: boolean): void;
}) {
  const { t, dateTime } = useI18n();
  const tenant = state.data?.tenant;
  const pendingDeletion = tenant?.status === "pending_deletion";
  const deadline = tenant?.deletion_scheduled_for;
  return (
    <main className="min-h-svh bg-background px-4 py-6 md:px-8">
      <div className="mx-auto max-w-lg py-16">
        <Alert variant={pendingDeletion && !state.data?.can_restore ? "destructive" : "default"}>
          <Clock className="size-4" />
          <AlertTitle>
            {t(pendingDeletion ? "workspace.scheduled" : "workspace.restore")}
          </AlertTitle>
          <AlertDescription>
            {state.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-label={t("common.loading")} />
            ) : null}
            {pendingDeletion && deadline ? (
              <p>{t("workspace.scheduledBody", { date: dateTime(deadline) })}</p>
            ) : null}
            {state.data?.can_restore ? (
              <>
                <p className="mt-1 flex items-center gap-1">
                  <ShieldCheck className="size-3.5" />
                  {t("workspace.restore")}
                </p>
                <Button
                  data-testid="workspace-restore-open"
                  size="sm"
                  className="mt-3"
                  onClick={() => setConfirm(true)}
                >
                  <RotateCcw className="size-4" />
                  {t("workspace.restore")}
                </Button>
              </>
            ) : state.data ? (
              <p>{t(pendingDeletion ? "workspace.expired" : "workspace.unavailable")}</p>
            ) : !state.isPending ? (
              <>
                <p>{t("workspace.needsSignIn")}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {providers.data?.items.map((provider) => (
                    <Button
                      data-testid="workspace-recovery-provider"
                      key={provider.id}
                      size="sm"
                      variant="outline"
                      disabled={login.isPending}
                      onClick={() => login.mutate(provider.id)}
                    >
                      {login.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                      {t("workspace.signIn")} · {provider.label}
                    </Button>
                  ))}
                </div>
              </>
            ) : null}
            {providers.error || login.error || restore.error ? (
              <p className="mt-2 text-destructive" role="alert">
                {t("workspace.actionError")}
              </p>
            ) : null}
            <Button variant="ghost" asChild size="sm" className="mt-3">
              <a
                data-testid="workspace-recovery-login"
                href={loginHref({ pathname: "/cockpit", search: "" })}
              >
                {t("familyFailure.expired.signIn")}
              </a>
            </Button>
          </AlertDescription>
        </Alert>
        <WorkspaceConfirmation
          open={confirm}
          onOpenChange={setConfirm}
          title={t("workspace.restoreTitle")}
          description={t("workspace.restoreBody", { name: tenant?.display_name ?? "" })}
          confirmLabel={t("workspace.restore")}
          pendingLabel={t("workspace.restoring")}
          pending={restore.isPending}
          destructive={false}
          onConfirm={() => {
            if (state.data?.can_restore) restore.mutate(state.data.csrf_token);
          }}
        />
      </div>
    </main>
  );
}
