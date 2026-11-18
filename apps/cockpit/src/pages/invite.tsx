import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError, bootstrap } from "@/api/client";
import { cockpitApiHref } from "@/app/installation-context";
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
import { nameFromEmail } from "@/lib/display-name";
import { formatDate } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { type InvitePreview, inviteToken, inviteView, joinCommand } from "./invite-model";
import { NAME_MAX } from "./welcome-model";

function signInHref(): string {
  return loginHref({ pathname: "/cockpit", search: "" });
}

export function InvitePage() {
  const { t } = useI18n();
  const [token] = useState(() => inviteToken(window.location.hash));
  const [search, setSearch] = useState(() => window.location.search);
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
  if (view.kind === "mismatch") {
    return (
      <StandalonePage
        title={t("invite.mismatch.title")}
        lead={
          view.retry
            ? t("invite.mismatch.body")
            : `${t("invite.mismatch.body")} ${t("invite.mismatch.reopen")}`
        }
        testId="invite-mismatch"
      >
        {view.retry ? (
          <Button
            variant="outline"
            className="w-full sm:w-auto sm:self-start"
            onClick={() => {
              window.history.replaceState(
                window.history.state,
                "",
                `${window.location.pathname}${window.location.hash}`,
              );
              setSearch("");
            }}
            data-testid="invite-mismatch-retry"
          >
            {t("invite.mismatch.action")}
          </Button>
        ) : null}
      </StandalonePage>
    );
  }
  if (view.kind === "expired" || view.kind === "gone") {
    return (
      <StandalonePage
        title={t(view.kind === "expired" ? "invite.expired.title" : "invite.gone.title")}
        lead={t("invite.gone.body")}
        testId={`invite-${view.kind}`}
      >
        {view.kind === "gone" && view.signIn ? (
          <p className="text-sm">
            <a
              href={signInHref()}
              className="font-medium underline underline-offset-2"
              data-testid="invite-sign-in"
            >
              {t("invite.redeemed.signIn")}
            </a>
          </p>
        ) : null}
      </StandalonePage>
    );
  }
  if (view.kind === "invalid") {
    return (
      <StandalonePage
        title={t("invite.invalid.title")}
        lead={t("invite.invalid.body")}
        testId="invite-invalid"
      />
    );
  }
  if (view.kind === "unavailable") {
    return (
      <StandalonePage
        title={t("invite.unavailable.title")}
        lead={t("invite.unavailable.body")}
        testId="invite-unavailable"
      />
    );
  }
  if (view.kind === "unreachable") {
    return (
      <StandalonePage
        title={t("invite.unreachable.title")}
        lead={t("invite.unreachable.body")}
        testId="invite-unreachable"
      >
        <Button
          variant="outline"
          className="w-full sm:w-auto sm:self-start"
          onClick={() => void preview.refetch()}
          data-testid="invite-retry"
        >
          {t("familyFailure.retry")}
        </Button>
      </StandalonePage>
    );
  }
  return (
    <StandalonePage title={t("invite.open.title")} busy testId="invite-loading">
      <DataState state="loading" testId="invite-loading-rows" />
    </StandalonePage>
  );
}

export function InviteOpen({ preview, token }: { preview: InvitePreview; token: string }) {
  const { t, locale } = useI18n();
  const single = preview.providers.length === 1;
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
      testId="invite-open"
    >
      <form
        method="post"
        action={cockpitApiHref("/v1/identity/invites/login")}
        className="flex flex-col gap-3"
        data-testid="invite-sign-in-form"
      >
        <input type="hidden" name="token" value={token} />
        {preview.providers.map((provider, index) => (
          <Button
            key={provider.id}
            type="submit"
            name="provider_id"
            value={provider.id}
            variant={index === 0 ? "default" : "outline"}
            className="w-full sm:w-auto sm:self-start"
            data-testid={`invite-provider-${index}`}
          >
            {single
              ? t("invite.open.action")
              : t("invite.open.provider", { label: provider.label })}
          </Button>
        ))}
        <p className="text-xs text-muted-foreground" data-testid="invite-meta">
          {t("invite.open.meta", {
            email: preview.email_hint,
            date: formatDate(locale, preview.expires_at),
          })}
        </p>
      </form>
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
    if (named) window.location.replace(absolute("/"));
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
      >
        <Button asChild variant="outline" className="w-full sm:w-auto sm:self-start">
          <a href={signInHref()} data-testid="invite-sign-in">
            {t("invite.redeemed.signIn")}
          </a>
        </Button>
      </StandalonePage>
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
    onSuccess: () => window.location.replace(absolute("/")),
  });
  const busy = save.isPending || save.isSuccess;
  const missing = checked && !name.trim();

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    if (name.trim()) save.mutate();
  }

  return (
    <StandalonePage title={t("invite.joined.title")} testId="invite-name">
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
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
        <Button
          type="submit"
          pending={busy}
          className="w-full sm:w-auto sm:self-start"
          data-testid="invite-join"
        >
          {t("invite.joined.action")}
        </Button>
      </form>
    </StandalonePage>
  );
}
