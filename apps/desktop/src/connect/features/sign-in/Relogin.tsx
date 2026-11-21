import { Button } from "@ui/atoms/button";
import { Loader2, LockKeyhole } from "lucide-react";
import { useSignIn } from "../../adapter/index.ts";
import { SignInNotice } from "./SignInNotice.tsx";
import { useSignInStep } from "./use-sign-in-step.ts";

export function Relogin() {
  const { s, a } = useSignInStep("relogin");
  const { t } = useSignIn();
  const busy = s.signin.phase === "waiting" || s.signin.phase === "exchanging";
  return (
    <div className="m-auto max-w-md p-4">
      <LockKeyhole className="size-8 text-warning-ink" aria-hidden />
      <h1 className="mt-4 text-2xl font-semibold">{t("relogin.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("relogin.body")}</p>
      <p className="mt-2 font-mono text-xs text-muted-foreground">{s.host}</p>
      <SignInNotice model={s.signin} t={t} />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {busy ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="status" className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t(s.signin.phase === "waiting" ? "signin.waiting" : "signin.exchanging")}
            </p>
            {s.signin.phase === "waiting" && (
              <Button data-testid="relogin-cancel" size="sm" variant="outline" onClick={a.cancel}>
                {t("signin.cancel")}
              </Button>
            )}
          </div>
        ) : (
          <Button data-testid="relogin-open" onClick={() => a.open(s.origin)}>
            {t("relogin.button")}
          </Button>
        )}
        <Button data-testid="relogin-other" variant="link" onClick={a.other}>
          {t("relogin.other")}
        </Button>
      </div>
    </div>
  );
}
