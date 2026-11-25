import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { workflowHref } from "@/app/links";
import { useSession } from "@/app/session";
import {
  ActionMenu,
  type ActionMenuItem,
  ConfirmDialog,
  DataState,
  FactList,
  InfiniteSentinel,
  RecordSheet,
  Section,
  StatusBadge,
  useConfirmTarget,
} from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { useI18n } from "@/lib/i18n-context";
import { AppSettingsDialog } from "./app-settings-dialog";
import { AppSignInDialog } from "./app-sign-in-dialog";
import {
  appKey,
  appSaveError,
  environmentLabel,
  fetchApp,
  settingValue,
  useAppSettingsSave,
  useSettingsSnapshot,
} from "./apps-data";
import { type Envelope, refusalToast, type UserItem, usePeopleList } from "./data";
import {
  APP_READINESS_LABEL,
  type AppSignIn,
  type AppSummary,
  type AppView,
  appBearerProvider,
  appCheckLines,
  appGoneFromList,
  appReadiness,
  appUserLabel,
  appUserLastSeen,
  mayEraseAppUsers,
  PRODUCTS_PATH,
  PROVIDERS_PATH,
  personNameText,
  withProduct,
} from "./model/apps-model";

export function ReadinessBadge({
  app,
  testId,
}: {
  app: Pick<AppSummary, "configured" | "ready">;
  testId?: string;
}) {
  const { t } = useI18n();
  const readiness = appReadiness(app);
  return (
    <StatusBadge state={readiness} label={t(APP_READINESS_LABEL[readiness])} testId={testId} />
  );
}

function SignInFacts({ provider, index }: { provider: AppSignIn; index: number }) {
  const { t } = useI18n();
  return (
    <FactList
      testId={`apps-sign-in-${index}`}
      items={[
        {
          label: provider.label || provider.id,
          value: (
            <span className="flex flex-col">
              <span>
                {t(
                  provider.protocol === "oidc_bearer"
                    ? "apps.signIn.oidcBearer"
                    : "apps.signIn.oidc",
                )}
              </span>
              <span className="break-all font-mono text-xs text-muted-foreground">
                {provider.id}
              </span>
            </span>
          ),
        },
        {
          label: t("apps.field.issuer"),
          value: <span className="break-all">{provider.issuer_url}</span>,
        },
        ...(provider.audience
          ? [{ label: t("apps.field.audience"), value: provider.audience }]
          : []),
        { label: t("apps.field.tenant"), value: provider.tenant_slug },
        ...(provider.protocol === "oidc_bearer"
          ? [
              {
                label: t("apps.field.claims"),
                value:
                  provider.required_claims.length === 0 ? (
                    <span className="text-muted-foreground">{t("apps.claims.none")}</span>
                  ) : (
                    <ul className="grid gap-0.5">
                      {provider.required_claims.map((claim) => (
                        <li key={claim.path} className="break-all font-mono text-xs">
                          {claim.path} = {JSON.stringify(claim.equals)}
                        </li>
                      ))}
                    </ul>
                  ),
              },
            ]
          : []),
        ...(provider.reject_anonymous !== null
          ? [
              {
                label: t("apps.field.anonymous"),
                value: t(
                  provider.reject_anonymous ? "apps.anonymous.rejected" : "apps.anonymous.allowed",
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

function AppUsers({ app }: { app: AppView }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const client = useQueryClient();
  const canErase = mayEraseAppUsers(session);
  const list = usePeopleList(true, app.id);
  const users = list.view.data?.items ?? [];
  const targetConfirm = useConfirmTarget<UserItem>();
  const target = targetConfirm.target;
  const erase = useMutation({
    mutationFn: (user: UserItem) =>
      apiCall("delete", "/v1/apps/{id}/users/{user_id}", {
        path: { id: app.id, user_id: user.id },
      }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "apps"] }),
        client.invalidateQueries({ queryKey: ["admin", "people"] }),
      ]),
  });
  if (list.view.error)
    return (
      <DataState
        state="error"
        line={t("apps.users.loadFailed")}
        onRetry={() => void list.view.refetch()}
        testId="apps-users-load-failed"
      />
    );
  if (list.view.isPending) return null;
  if (users.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="apps-users-none">
        {t("apps.users.none")}
      </p>
    );
  return (
    <>
      <ul className="grid gap-2" data-testid="apps-users-list">
        {users.map((user, index) => {
          const seen = appUserLastSeen(user, app.id);
          return (
            <li
              key={user.id}
              className="flex items-center justify-between gap-3"
              data-testid={`apps-users-${index}`}
            >
              <span className="flex min-w-0 flex-col">
                <span className="break-words text-sm" data-testid={`apps-users-${index}-name`}>
                  {personNameText(user, t)}
                </span>
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono">{user.id.slice(0, 8)}</span>
                  {" · "}
                  {t("apps.users.lastSeen")}: {seen ? dateTime(seen) : t("apps.users.never")}
                </span>
              </span>
              {canErase ? (
                <ActionMenu
                  size="sm"
                  items={[
                    {
                      label: t("apps.users.erase"),
                      destructive: true,
                      onSelect: () => targetConfirm.ask(user),
                      testId: `apps-users-${index}-erase`,
                    },
                  ]}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      <InfiniteSentinel infinite={list.infinite} testId="apps-users-more" />
      <ConfirmDialog
        {...targetConfirm.dialog()}
        object={t("apps.users.erase.object", {
          person: target ? appUserLabel(target, t) : "",
          id: app.id,
        })}
        verb={t("apps.users.erase.verb")}
        consequence={t("apps.users.erase.consequence")}
        destructive
        pending={erase.isPending}
        onConfirm={async () => {
          if (!target) return;
          await erase
            .mutateAsync(target)
            .then(() => {
              targetConfirm.close();
              toast.success(t("apps.users.erase.done"));
            })
            .catch((error) => refusalToast(error, t));
        }}
        testId="apps-users-erase-confirm"
      />
    </>
  );
}

export function AppSheet({ appId, onClose }: { appId: string | null; onClose(): void }) {
  const { t, dateTime } = useI18n();
  const session = useSession();
  const canWrite = session.permissions.includes("settings:write:global");
  const canPeople = session.permissions.includes("identity:read");
  const detail = useQuery({
    queryKey: appKey(appId ?? ""),
    queryFn: () => fetchApp(appId ?? ""),
    enabled: appId !== null,
  });
  const app = appId !== null ? detail.data : undefined;
  const settings = useSettingsSnapshot(canWrite && appId !== null);
  const bearer = appId
    ? appBearerProvider(settingValue(settings.data, PROVIDERS_PATH), appId)
    : null;
  const dialogs = useConfirmTarget<"settings" | "signIn" | "remove">();
  const remove = useAppSettingsSave();
  const client = useQueryClient();
  const close = () => {
    dialogs.close();
    onClose();
  };
  const menu: ActionMenuItem[] =
    canWrite && app
      ? [
          {
            label: t(app.configured ? "apps.action.editSettings" : "apps.action.configure"),
            onSelect: () => dialogs.ask("settings"),
            testId: "apps-edit-settings",
          },
          {
            label: t(bearer ? "apps.action.editSignIn" : "apps.action.addSignIn"),
            onSelect: () => dialogs.ask("signIn"),
            testId: "apps-edit-sign-in",
          },
          ...(app.configured
            ? [
                {
                  label: t("apps.action.remove"),
                  destructive: true,
                  onSelect: () => dialogs.ask("remove"),
                  testId: "apps-remove",
                },
              ]
            : []),
        ]
      : [];
  const checks = app ? appCheckLines(app.checks, t) : [];
  return (
    <>
      <RecordSheet
        dock
        open={appId !== null}
        onOpenChange={(open) => !open && close()}
        title={<span className="break-all">{appId}</span>}
        badge={app ? <ReadinessBadge app={app} testId="apps-sheet-readiness" /> : null}
        menu={menu.length > 0 ? <ActionMenu items={menu} testId="apps-sheet-menu" /> : null}
        loading={appId !== null && detail.isPending}
        testId="apps-sheet"
        closeTestId="apps-sheet-close"
      >
        {detail.error ? (
          <DataState
            state="error"
            line={t("resource.loadFailed", { resource: t("people.section.apps") })}
            onRetry={() => void detail.refetch()}
            testId="apps-sheet-load-failed"
          />
        ) : null}
        {app ? (
          <>
            <Section label={t("apps.section.settings")} testId="apps-sheet-settings">
              {app.settings ? (
                <FactList
                  testId="apps-sheet-settings-facts"
                  items={[
                    {
                      label: t("apps.field.environment"),
                      value: environmentLabel(app.settings.execution_environment, t),
                    },
                    {
                      label: t("apps.field.assistant"),
                      value: (
                        <Link
                          to={workflowHref(app.settings.assistant_workflow.id)}
                          className="underline-offset-2 hover:underline"
                          data-testid="apps-sheet-assistant"
                        >
                          {app.settings.assistant_workflow.name ??
                            app.settings.assistant_workflow.slug ??
                            app.settings.assistant_workflow.id}
                        </Link>
                      ),
                    },
                    { label: t("apps.field.bucket"), value: app.settings.budget_bucket },
                    {
                      label: t("apps.field.dailyLimit"),
                      value: app.settings.daily_limit
                        ? t("apps.dailyLimit.value", {
                            limit: app.settings.daily_limit.limit_per_caller,
                            tz: app.settings.daily_limit.tz,
                          })
                        : t("apps.budget.none"),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="apps-sheet-settings-none">
                  {t("apps.settings.none")}
                </p>
              )}
            </Section>
            <Section label={t("apps.section.signIn")} testId="apps-sheet-sign-in">
              {app.sign_in.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("apps.signIn.none")}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {app.sign_in.map((provider, index) => (
                    <SignInFacts key={provider.id} provider={provider} index={index} />
                  ))}
                </div>
              )}
            </Section>
            <Section label={t("apps.section.workflows")} testId="apps-sheet-workflows">
              {app.workflows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("apps.workflows.none")}</p>
              ) : (
                <FactList
                  testId="apps-sheet-workflow-facts"
                  items={app.workflows.map((workflow) => ({
                    testId: `apps-sheet-workflow-${workflow.id}`,
                    label: (
                      <Link
                        to={workflowHref(workflow.id)}
                        className="break-all text-foreground underline-offset-2 hover:underline"
                        data-testid={`apps-sheet-workflow-${workflow.id}-link`}
                      >
                        {workflow.name || workflow.slug}
                      </Link>
                    ),
                    value: (
                      <span className="flex flex-wrap gap-1">
                        <StatusBadge state={workflow.lifecycle} />
                        {workflow.is_assistant ? (
                          <StatusBadge state="assistant" label={t("apps.workflow.assistant")} />
                        ) : null}
                        {workflow.definition_valid ? null : (
                          <StatusBadge state="failed" label={t("apps.workflow.invalid")} />
                        )}
                      </span>
                    ),
                  }))}
                />
              )}
            </Section>
            <Section label={t("apps.section.users")} testId="apps-sheet-users">
              <FactList
                testId="apps-sheet-user-facts"
                items={[
                  { label: t("apps.users.count"), value: app.users.count },
                  {
                    label: t("apps.users.lastSeen"),
                    value: app.users.last_seen_at
                      ? dateTime(app.users.last_seen_at)
                      : t("apps.users.never"),
                  },
                ]}
              />
              {canPeople ? <AppUsers app={app} /> : null}
            </Section>
            <Section label={t("apps.section.budget")} testId="apps-sheet-budget">
              {app.budget_today ? (
                <FactList
                  testId="apps-sheet-budget-facts"
                  items={[
                    { label: t("apps.budget.day"), value: app.budget_today.day },
                    { label: t("apps.budget.consumed"), value: app.budget_today.consumed },
                    { label: t("apps.budget.reserved"), value: app.budget_today.reserved },
                    { label: t("apps.budget.refusals"), value: app.budget_today.refusals_today },
                    {
                      label: t("apps.budget.resets"),
                      value: dateTime(app.budget_today.resets_at),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t("apps.budget.none.detail")}</p>
              )}
            </Section>
            <Section label={t("apps.section.checks")} testId="apps-sheet-checks">
              <FactList
                testId="apps-sheet-check-facts"
                items={checks.map((check) => ({
                  testId: `apps-check-${check.key}`,
                  label: check.label,
                  value: (
                    <span className="flex flex-col gap-1">
                      <span>
                        <StatusBadge state={check.state} />
                      </span>
                      {check.detail ? (
                        <span className="font-normal text-muted-foreground">{check.detail}</span>
                      ) : null}
                      {check.next ? (
                        <span className="font-normal" data-testid={`apps-check-${check.key}-next`}>
                          {t("apps.check.next", { action: check.next })}
                        </span>
                      ) : null}
                    </span>
                  ),
                }))}
              />
            </Section>
          </>
        ) : null}
      </RecordSheet>
      {app ? (
        <>
          <AppSettingsDialog app={app} {...dialogs.dialog({ only: "settings" })} />
          <AppSignInDialog app={app} {...dialogs.dialog({ only: "signIn" })} />
          <ConfirmDialog
            {...dialogs.dialog({ only: "remove" })}
            object={t("apps.remove.object", { id: app.id })}
            verb={t("apps.remove.verb")}
            consequence={t("apps.remove.consequence")}
            destructive
            pending={remove.isPending}
            onConfirm={async () => {
              await remove
                .mutateAsync({ [PRODUCTS_PATH]: (value) => withProduct(value, app.id, null) })
                .then((outcome) => {
                  if (
                    appGoneFromList(
                      client.getQueryData<Envelope<AppSummary>>(["admin", "apps"]),
                      app.id,
                    )
                  )
                    close();
                  else dialogs.close();
                  toast.success(
                    t(outcome === "active" ? "apps.save.removed" : "apps.save.restartRequired"),
                  );
                })
                .catch((error) => reportFailure(appSaveError(error, t), error));
            }}
            testId="apps-remove-confirm"
          />
        </>
      ) : null}
    </>
  );
}
