import { Button } from "@ui/atoms/button";
import { IconTile } from "@ui/atoms/icon-tile";
import { Panel, Pill } from "@ui/atoms/pill";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { StepFooter } from "@ui/molecules/step-footer";
import { Accessibility, Monitor, Power, RefreshCw, Settings2 } from "lucide-react";
import { useEffect } from "react";
import type { PermissionKey } from "../../../shared/local/permission-model.ts";
import { useSignIn } from "../../adapter/index.ts";
import type { PermissionCard as Card } from "../../domain/index.ts";

const ICONS = { accessibility: Accessibility, screen: Monitor };

function PermissionCard({ card }: { card: Card }) {
  const { t, dispatch } = useSignIn();
  const { key, granted, restart } = card;
  return (
    <Panel className="flex h-80 min-w-0 flex-col">
      <div className="flex items-center justify-between gap-3">
        <IconTile icon={ICONS[key]} size="lg" />
        <Pill tone={granted ? "success" : "warning"}>
          {t(granted ? "permissions.granted" : "permissions.missing")}
        </Pill>
      </div>
      <h2 className="mt-4 text-lg font-semibold">{t(`permissions.name.${key}`)}</h2>
      <p className="mt-2 min-h-20 text-sm text-muted-foreground">{t(`permissions.why.${key}`)}</p>
      <div className="mt-auto flex flex-col gap-2">
        <Button
          data-testid={`permission-${key}-open`}
          variant="outline"
          className="w-full whitespace-normal"
          onClick={() => dispatch({ type: "OpenPermissionSettings", key })}
        >
          <Settings2 className="size-4 shrink-0" aria-hidden />
          {t("permissions.open")}
        </Button>
        <Button
          data-testid={`permission-${key}-${restart ? "restart" : "check"}`}
          variant={restart ? "default" : "outline"}
          className="w-full"
          onClick={() => dispatch({ type: restart ? "RestartApp" : "CheckPermissions" })}
        >
          {restart ? (
            <Power className="size-4" aria-hidden />
          ) : (
            <RefreshCw className="size-4" aria-hidden />
          )}
          {t(restart ? "permissions.restart" : "permissions.check")}
        </Button>
      </div>
    </Panel>
  );
}

export function PermissionSetup() {
  const { view, t, dispatch } = useSignIn();
  useEffect(() => {
    const check = () => dispatch({ type: "CheckPermissions" });
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [dispatch]);
  if (view?.screen.kind !== "permissions") return null;
  const { setup } = view.screen;
  const later = () => dispatch({ type: "ClosePermissions" });
  const finish = () => dispatch({ type: "FinishPermissions" });
  const back = () => dispatch({ type: "GoBack" });
  const nav = view.nav ?? { back: "common.back" as const, later: false };
  const firstMissing: PermissionKey =
    setup.cards.find((card) => !card.granted)?.key ?? "accessibility";
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t("permissions.title")}</h1>
      {setup.supported ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {setup.cards.map((card) => (
            <PermissionCard key={card.key} card={card} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("permissions.unsupported")}</p>
      )}
      {setup.lost && (
        <ErrorNotice
          kind="macPermission"
          tone="warning"
          testId="permissions-lost"
          primary={{
            label: t("permissions.open"),
            onClick: () => dispatch({ type: "OpenPermissionSettings", key: firstMissing }),
          }}
        />
      )}
      <StepFooter
        testId="permissions"
        label={t("permissions.done")}
        next={finish}
        disabled={!setup.done}
        skip={nav.later ? later : undefined}
        skipLabel={t("permissions.later")}
        back={nav.back ? back : undefined}
        backLabel={t(nav.back ?? "common.back")}
        nextLabel={t("permissions.done")}
      />
    </div>
  );
}
