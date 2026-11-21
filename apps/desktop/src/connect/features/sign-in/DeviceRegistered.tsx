import { Laptop } from "lucide-react";
import { useSignIn } from "../../adapter/index.ts";
import { Pill, StepFooter } from "../../ui/index.ts";
import { useSignInStep } from "./use-sign-in-step.ts";

export function DeviceRegistered() {
  const { s, a } = useSignInStep("signed-in");
  const { t } = useSignIn();
  return (
    <div role="status">
      <div className="flex items-center gap-3">
        <Laptop className="size-8 shrink-0 text-success-ink" aria-hidden />
        <h1 className="text-2xl font-semibold">{t("signin.doneTitle")}</h1>
      </div>
      <p className="mt-2 text-sm">{t("signin.doneLead")}</p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl border p-4 text-sm">
        <dt className="text-muted-foreground">{t("signin.device")}</dt>
        <dd>{s.device}</dd>
        <dt className="text-muted-foreground">{t("signin.server")}</dt>
        <dd className="min-w-0 break-all font-mono text-xs leading-5">
          {s.serverVersion ? `${s.host} · ${s.serverVersion}` : s.host}
        </dd>
        <dt className="text-muted-foreground">{t("signin.status")}</dt>
        <dd>
          <Pill tone="success">{t("signin.connected")}</Pill>
        </dd>
      </dl>
      <StepFooter
        next={a.enter}
        label={t("signin.enter")}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
      />
    </div>
  );
}
