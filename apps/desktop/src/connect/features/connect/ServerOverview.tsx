import { Button } from "@ui/atoms/button";
import { Panel } from "@ui/atoms/pill";
import { StatusStrip } from "@ui/molecules/status-strip";
import { StepFooter } from "@ui/molecules/step-footer";
import { Server } from "lucide-react";
import { useSignIn } from "../../adapter/index.ts";
import type { Screen } from "../../domain/index.ts";
import { ConnectionOk } from "./connection-result.tsx";

type ServerScreen = Extract<Screen, { kind: "server" }>;

export function ServerOverview() {
  const { view, t, dispatch } = useSignIn();
  if (view?.screen.kind !== "server") return null;
  const s: ServerScreen = view.screen;
  const { strip } = s;
  return (
    <div className="flex flex-col gap-4" data-testid="server-overview">
      <h1 className="text-2xl font-semibold">{t("profiles.title")}</h1>
      <Panel className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <Server className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p data-testid="server-host" className="break-all font-mono text-base font-semibold">
              {s.host}
            </p>
            {s.label && <p className="text-sm text-muted-foreground">{s.label}</p>}
          </div>
        </div>
        {strip ? (
          <StatusStrip
            tone={strip.tone}
            className="mb-0"
            action={
              strip.action && (
                <Button
                  data-testid="server-notice-action"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    strip.action && dispatch({ type: "ActOnNotice", action: strip.action.action })
                  }
                >
                  {t(strip.action.label)}
                </Button>
              )
            }
          >
            {t(strip.title, strip.vars)}
          </StatusStrip>
        ) : (
          <div role="status">
            <ConnectionOk
              title={t("signin.connected")}
              chip={s.serverVersion ? t("chip.version", { version: s.serverVersion }) : null}
            />
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 text-sm">
          <dt className="text-muted-foreground">{t("signin.device")}</dt>
          <dd className="min-w-0 break-all">{s.device}</dd>
        </dl>
      </Panel>
      <div>
        <Button
          data-testid="server-other"
          variant="outline"
          onClick={() => dispatch({ type: "ConnectAnotherServer" })}
        >
          {t("relogin.other")}
        </Button>
      </div>
      <StepFooter
        testId="server"
        next={() => dispatch({ type: "OpenSubKit" })}
        label={t("signin.enter")}
        backLabel={t("common.back")}
        nextLabel={t("common.next")}
      />
    </div>
  );
}
