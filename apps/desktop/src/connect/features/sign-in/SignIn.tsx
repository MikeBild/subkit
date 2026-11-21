import { CircleCheck, Loader2 } from "lucide-react";
import { useSignIn } from "../../adapter/index.ts";
import { Button, Pill, StepFooter } from "../../ui/index.ts";
import { SignInNotice } from "./SignInNotice.tsx";
import { useSignInStep } from "./use-sign-in-step.ts";

function SignedInCard({ host, version }: { host: string; version: string | null }) {
  const { t } = useSignIn();
  return (
    <div
      role="status"
      data-testid="signin-done"
      className="mt-4 flex flex-col gap-2 rounded-xl border border-success/70 p-4"
    >
      <div className="flex items-center gap-3">
        <CircleCheck className="size-5 shrink-0 text-success-ink" aria-hidden />
        <p className="font-semibold">{t("signin.done")}</p>
        <Pill tone="success" className="ml-auto">
          {t("signin.connected")}
        </Pill>
      </div>
      <p className="min-w-0 break-all font-mono text-xs text-muted-foreground">
        {version ? `${host} · ${version}` : host}
      </p>
    </div>
  );
}

export function SignIn() {
  const { s, a } = useSignInStep("signin");
  const { t } = useSignIn();
  const { signin } = s;
  const busy = signin.phase === "waiting" || signin.phase === "exchanging";
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("signin.title")}</h1>
      <p className="mt-2">{t("signin.body")}</p>
      {signin.phase === "done" ? (
        <SignedInCard host={s.host} version={signin.serverVersion} />
      ) : (
        <>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{s.host}</p>
          {s.joining && (
            <p data-testid="signin-after-join" className="mt-3 text-sm">
              {t("signin.afterJoin")}
            </p>
          )}
          <SignInNotice model={signin} t={t} />
          <div className="mt-4">
            {busy ? (
              <div className="flex flex-wrap items-center gap-3">
                <p role="status" className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t(signin.phase === "waiting" ? "signin.waiting" : "signin.exchanging")}
                </p>
                {signin.phase === "waiting" && (
                  <Button
                    data-testid="signin-cancel"
                    size="sm"
                    variant="outline"
                    onClick={a.cancel}
                  >
                    {t("signin.cancel")}
                  </Button>
                )}
              </div>
            ) : (
              <Button data-testid="signin-open" onClick={() => a.open(s.origin)}>
                {t("signin.open")}
              </Button>
            )}
          </div>
        </>
      )}
      <StepFooter
        disabled
        label={t("common.next")}
        back={signin.phase === "done" ? undefined : a.back}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
      />
    </div>
  );
}
