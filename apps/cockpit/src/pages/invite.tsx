import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError, bootstrap } from "@/api/client";
import { absolute } from "@/app/links";
import { loginHref } from "@/app/session";
import {
  Button,
  CopyField,
  DataState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  StandalonePage,
} from "@/components/cockpit/patterns";
import {
  afterJoinTarget,
  INVITE_PAGE,
  type InvitePreview,
  type InviteSession,
  inviteToken,
  inviteView,
  joinCommand,
  type RefusedInvite,
  refusalActions,
  rememberInviteContinuation,
} from "@/features/admin";
import { NAME_MAX } from "@/features/setup";
import { nameFromEmail } from "@/features/setup/model";
import { formatDate, type TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";

function signInHref(): string {
  return loginHref({ pathname: "/cockpit", search: "" });
}

function continueAfterJoin(): void {
  window.location.replace(afterJoinTarget(window.location.origin, absolute("/")));
}

export function InvitePage() {
  const { t } = useI18n();
  const [token] = useState(() => inviteToken(window.location.hash));
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    rememberInviteContinuation(window.location.search, window.location.origin);
  }, []);
  const returned = new URLSearchParams(search);
  const waiting = token !== null && returned.get("joined") !== "1" && !returned.get("error");
  const preview = useQuery({
    queryKey: ["invite-preview"],
    queryFn: () =>
      apiCall("post", "/v1/identity/invites/preview", { body: { token: token ?? "" } }),
    retry: false,
    enabled: waiting,
  });
  const view = inviteView({
    search,
    token,
    preview: {
      data: preview.data,
      failed: preview.isError,
      code: preview.error instanceof ApiError ? preview.error.code : null,
    },
  });

  const session = useInviteSession(REFUSED_KINDS.has(view.kind));
  if (view.kind === "joined") return <InviteJoined />;
  if (view.kind === "open" && token) return <InviteOpen preview={view.preview} token={token} />;
  if (view.kind === "cli") {
    return (
      <StandalonePage title={t("invite.cli.title")} lead={t("invite.cli.body")} testId="invite-cli">
        <CopyField
          value={joinCommand(window.location.origin, view.token)}
          label={t("invite.cli.command")}
          testId="invite-cli-command"
        />
      </StandalonePage>
    );
  }
  if (
    view.kind === "mismatch" ||
    view.kind === "expired" ||
    view.kind === "gone" ||
    view.kind === "invalid" ||
    view.kind === "unavailable" ||
    view.kind === "unreachable"
  ) {
    return (
      <InviteRefused
        view={view}
        session={session}
        onOtherAddress={() => {
          window.history.replaceState(
            window.history.state,
            "",
            `${window.location.pathname}${window.location.hash}`,
          );
          setSearch("");
        }}
        onRetry={() => void preview.refetch()}
      />
    );
  }
  return (
    <StandalonePage title={t("invite.open.title")} busy testId="invite-loading">
      <DataState state="loading" testId="invite-loading-rows" />
    </StandalonePage>
  );
}

const REFUSED_KINDS: ReadonlySet<string> = new Set([
  "mismatch",
  "expired",
  "gone",
  "invalid",
  "unavailable",
  "unreachable",
]);

const REFUSAL_COPY: Readonly<
  Record<RefusedInvite["kind"], { title: TranslationKey; body: TranslationKey }>
> = {
  mismatch: { title: "invite.mismatch.title", body: "invite.mismatch.body" },
  expired: { title: "invite.expired.title", body: "invite.gone.body" },
  gone: { title: "invite.gone.title", body: "invite.gone.body" },
  invalid: { title: "invite.invalid.title", body: "invite.invalid.body" },
  unavailable: { title: "invite.unavailable.title", body: "invite.unavailable.body" },
  unreachable: { title: "invite.unreachable.title", body: "invite.unreachable.body" },
};

function useInviteSession(enabled: boolean): InviteSession {
  const session = useQuery({
    queryKey: ["invite-session"],
    queryFn: () => bootstrap(),
    retry: false,
    enabled,
  });
  if (session.data) return "signed-in";
  return session.isError ? "signed-out" : "unknown";
}

export function InviteRefused({
  view,
  session,
  onOtherAddress,
  onRetry,
}: {
  view: RefusedInvite;
  session: InviteSession;
  onOtherAddress(): void;
  onRetry(): void;
}) {
  const { t } = useI18n();
  const copy = REFUSAL_COPY[view.kind];
  const actions = refusalActions(view, session);
  const lead =
    view.kind === "mismatch" && !view.retry
      ? `${t(copy.body)} ${t("invite.mismatch.reopen")}`
      : t(copy.body);
  return (
    <StandalonePage
      title={t(copy.title)}
      lead={lead}
      testId={`invite-${view.kind}`}
      busy={session === "unknown"}
      actions={
        session === "unknown"
          ? {}
          : {
              back: actions.back ? (
                <Button asChild variant="ghost">
                  <a href={absolute("/")} data-testid="invite-back">
                    {t("invite.back")}
                  </a>
                </Button>
              ) : undefined,
              primary:
                actions.primary === "other-address" ? (
                  <Button onClick={onOtherAddress} data-testid="invite-mismatch-retry">
                    {t("invite.mismatch.action")}
                  </Button>
                ) : actions.primary === "retry" ? (
                  <Button onClick={onRetry} data-testid="invite-retry">
                    {t("failure.retry")}
                  </Button>
                ) : actions.primary === "home" ? (
                  <Button asChild>
                    <a href={absolute("/")} data-testid="invite-back">
                      {t("invite.back")}
                    </a>
                  </Button>
                ) : (
                  <Button asChild>
                    <a href={signInHref()} data-testid="invite-sign-in">
                      {t("invite.redeemed.signIn")}
                    </a>
                  </Button>
                ),
            }
      }
    />
  );
}

export function InviteOpen({ preview, token }: { preview: InvitePreview; token: string }) {
  const { t, locale } = useI18n();
  const single = preview.providers.length === 1;
  const signIn = useMutation({
    mutationFn: (providerId: string) =>
      apiCall("post", "/v1/identity/invites/login", {
        body: { token, provider_id: providerId },
      }),
    onSuccess: (result) => window.location.assign(result.authorization_url),
    onError: (error) =>
      window.location.replace(
        `${absolute(INVITE_PAGE)}?error=${encodeURIComponent(
          error instanceof ApiError ? error.message : "invite_unavailable",
        )}${window.location.hash}`,
      ),
  });
  return (
    <StandalonePage
      title={t("invite.open.title")}
      lead={
        preview.invited_by_name
          ? t("invite.open.body", {
              inviter: preview.invited_by_name,
              workspace: preview.workspace_name,
            })
          : t("invite.open.bodyAnonymous", { workspace: preview.workspace_name })
      }
      busy={signIn.isPending}
      testId="invite-open"
      actions={{
        primary: (
          <div className="flex flex-wrap justify-end gap-2" data-testid="invite-sign-in">
            {preview.providers.map((provider, index) => (
              <Button
                key={provider.id}
                type="button"
                variant={index === 0 ? "default" : "outline"}
                disabled={signIn.isPending || signIn.isSuccess}
                onClick={() => signIn.mutate(provider.id)}
                data-testid={`invite-provider-${index}`}
              >
                {single
                  ? t("invite.open.action")
                  : t("invite.open.provider", { label: provider.label })}
              </Button>
            ))}
          </div>
        ),
      }}
    >
      <p className="text-xs text-muted-foreground" data-testid="invite-meta">
        {t("invite.open.meta", {
          email: preview.email_hint,
          date: formatDate(locale, preview.expires_at),
        })}
      </p>
    </StandalonePage>
  );
}

function InviteJoined() {
  const { t } = useI18n();
  const session = useQuery({
    queryKey: ["invite-session"],
    queryFn: () => bootstrap(),
    retry: false,
  });
  const named = Boolean(session.data?.principal.display_name?.trim());
  useEffect(() => {
    if (named) continueAfterJoin();
  }, [named]);
  if (session.data && !named) {
    return <InviteName email={session.data.principal.email ?? ""} />;
  }
  if (session.error instanceof ApiError && session.error.status === 401) {
    return (
      <StandalonePage
        title={t("invite.joined.title")}
        lead={t("invite.joined.signIn")}
        testId="invite-signed-out"
        actions={{
          primary: (
            <Button asChild>
              <a href={signInHref()} data-testid="invite-sign-in">
                {t("invite.redeemed.signIn")}
              </a>
            </Button>
          ),
        }}
      />
    );
  }
  if (session.isError) {
    return (
      <StandalonePage title={t("invite.joined.title")} testId="invite-session-failed">
        <DataState
          state="error"
          line={t("standalone.error")}
          onRetry={() => void session.refetch()}
          testId="invite-session-load-failed"
        />
      </StandalonePage>
    );
  }
  return (
    <StandalonePage title={t("invite.joined.title")} busy testId="invite-joining">
      <DataState state="loading" testId="invite-joining-rows" />
    </StandalonePage>
  );
}

export function InviteName({ email }: { email: string }) {
  const { t } = useI18n();
  const id = useId();
  const [name, setName] = useState(() => nameFromEmail(email).slice(0, NAME_MAX));
  const [checked, setChecked] = useState(false);
  const save = useMutation({
    mutationFn: () => apiCall("patch", "/v1/identity/me", { body: { display_name: name.trim() } }),
    onSuccess: continueAfterJoin,
  });
  const busy = save.isPending || save.isSuccess;
  const missing = checked && !name.trim();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (name.trim()) save.mutate();
  }

  return (
    <StandalonePage
      title={t("invite.joined.title")}
      testId="invite-name"
      actions={{
        primary: (
          <Button type="submit" form={`${id}-form`} pending={busy} data-testid="invite-join">
            {t("invite.joined.action")}
          </Button>
        ),
      }}
    >
      <form id={`${id}-form`} className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Field data-invalid={missing ? true : undefined}>
          <FieldLabel htmlFor={`${id}-name`}>{t("welcome.name")}</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="name"
            disabled={busy}
            aria-invalid={missing || undefined}
            aria-describedby={`${id}-note`}
            onChange={(event) => setName(event.target.value)}
            data-testid="invite-name-input"
          />
          {missing ? (
            <FieldError id={`${id}-note`} data-testid="invite-name-error">
              {t("welcome.nameError")}
            </FieldError>
          ) : (
            <FieldDescription id={`${id}-note`}>{t("invite.joined.nameHelp")}</FieldDescription>
          )}
        </Field>
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive" data-testid="invite-name-failed">
            {t("standalone.error")}
          </p>
        ) : null}
      </form>
    </StandalonePage>
  );
}
