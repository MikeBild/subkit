import { useMutation, useQuery } from "@tanstack/react-query";
import { IconButton } from "@ui/molecules/icon-button";
import { Eye, EyeOff } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { apiCall } from "@/api/call";
import { ApiError, bootstrap, logout } from "@/api/client";
import { absolute } from "@/app/links";
import { loginHref } from "@/app/session";
import {
  Button,
  ChoiceCards,
  DataState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  SectionHeading,
  StandalonePage,
  TimezoneSelect,
} from "@/components/cockpit/patterns";
import {
  OWN_KEY_PROVIDER_COPY,
  OWN_KEY_PROVIDERS,
  type OwnKeyProvider,
  PROVIDER_KEY_PAGES,
  PROVIDER_MARK,
} from "@/features/settings";
import {
  KEY_MAX,
  keyAfterSubmit,
  NAME_MAX,
  suggestedName,
  type WelcomeFailure,
  type WelcomeValues,
  welcomeErrors,
  welcomeFailure,
  welcomeFailureKey,
  welcomeFailurePlace,
  welcomeRequest,
  workspaceSuggestion,
} from "@/features/setup";
import { useI18n } from "@/lib/i18n-context";
import { browserTimeZone } from "@/lib/timezones";

type Pending = Awaited<ReturnType<typeof readPending>>;

function readPending() {
  return apiCall("get", "/v1/identity/onboarding", {});
}

function signInHref(): string {
  return loginHref({ pathname: "/cockpit", search: "" });
}

function failureOf(error: unknown): WelcomeFailure {
  return welcomeFailure(error instanceof ApiError ? error : { status: 0, code: null });
}

export function WelcomePage() {
  const { t } = useI18n();
  const pending = useQuery({
    queryKey: ["identity-onboarding"],
    queryFn: readPending,
    retry: false,
  });
  const missing = pending.error instanceof ApiError && pending.error.status === 401;
  const session = useQuery({
    queryKey: ["identity-onboarding-session"],
    queryFn: () => bootstrap(),
    retry: false,
    enabled: missing,
  });
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (session.data) window.location.replace(absolute("/"));
  }, [session.data]);

  if (expired || (missing && session.isError)) {
    return (
      <StandalonePage
        title={t("welcome.expired.title")}
        lead={t("welcome.expired.body")}
        testId="welcome-expired"
      >
        <Button asChild className="w-full sm:w-auto sm:self-start">
          <a href={signInHref()} data-testid="welcome-sign-in">
            {t("welcome.expired.action")}
          </a>
        </Button>
      </StandalonePage>
    );
  }
  if (pending.data) {
    return (
      <StandalonePage title={t("welcome.title")} lead={t("welcome.lead")} testId="welcome-page">
        <WelcomeForm
          pending={pending.data}
          onExpired={() => setExpired(true)}
          onStale={() => void pending.refetch()}
        />
      </StandalonePage>
    );
  }
  if (pending.isError && !missing) {
    return (
      <StandalonePage title={t("welcome.title")} testId="welcome-failed">
        <DataState
          state="error"
          line={t("standalone.error")}
          onRetry={() => void pending.refetch()}
          testId="welcome-load-failed"
        />
      </StandalonePage>
    );
  }
  return (
    <StandalonePage
      title={t("welcome.title")}
      lead={t("welcome.lead")}
      busy
      testId="welcome-loading"
    >
      <DataState state="loading" testId="welcome-loading-rows" />
    </StandalonePage>
  );
}

export function WelcomeForm({
  pending,
  onExpired,
  onStale,
}: {
  pending: Pending;
  onExpired(): void;
  onStale(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [name, setName] = useState(() => suggestedName(pending));
  const [ownWorkspace, setOwnWorkspace] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [provider, setProvider] = useState<OwnKeyProvider>("anthropic");
  const [key, setKey] = useState("");
  const [keyShown, setKeyShown] = useState(false);
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<WelcomeFailure | null>(null);
  const values: WelcomeValues = {
    name,
    workspace:
      ownWorkspace ??
      workspaceSuggestion(name, (shown) => t("welcome.workspaceDefault", { name: shown })),
    timezone,
    provider,
    key,
  };
  const errors = checked ? welcomeErrors(values) : {};
  const submit = useMutation({
    mutationFn: () =>
      apiCall("post", "/v1/identity/onboarding", {
        headers: { "x-subkit-onboarding-csrf": pending.csrf_token },
        body: welcomeRequest(values),
      }),
    onSuccess: (result) => {
      setKey((current) => keyAfterSubmit(current, "created"));
      window.location.assign(result.redirect_to);
    },
    onError: (error) => {
      setKey((current) => keyAfterSubmit(current, "refused"));
      const next = failureOf(error);
      if (next === "expired") return onExpired();
      if (next === "stale") onStale();
      setFailure(next);
    },
  });
  const leave = useMutation({
    mutationFn: logout,
    onSettled: (result) => window.location.assign(result?.endSessionUrl ?? signInHref()),
  });
  const busy = submit.isPending || submit.isSuccess || leave.isPending;
  const place = failure ? welcomeFailurePlace(failure) : null;
  const timezoneError =
    errors.timezone ?? (place === "timezone" ? ("welcome.timezoneError" as const) : undefined);
  const keyError =
    errors.key ?? (failure && place === "key" ? welcomeFailureKey(failure) : undefined);
  const keyPage = PROVIDER_KEY_PAGES[provider];

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setChecked(true);
    setFailure(null);
    if (Object.keys(welcomeErrors(values)).length === 0) submit.mutate();
  }

  return (
    <form className="flex flex-col gap-8" onSubmit={onSubmit} noValidate data-testid="welcome-form">
      <WelcomeGroup title={t("welcome.group.you")} testId="welcome-group-you">
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={`${id}-name`}>{t("welcome.name")}</FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="name"
            disabled={busy}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={`${id}-name-note`}
            onChange={(event) => setName(event.target.value)}
            data-testid="welcome-name"
          />
          {errors.name ? (
            <FieldError id={`${id}-name-note`} data-testid="welcome-name-error">
              {t(errors.name)}
            </FieldError>
          ) : (
            <FieldDescription id={`${id}-name-note`}>{t("welcome.nameHelp")}</FieldDescription>
          )}
        </Field>
        <Field data-invalid={errors.workspace ? true : undefined}>
          <FieldLabel htmlFor={`${id}-workspace`}>{t("welcome.workspace")}</FieldLabel>
          <Input
            id={`${id}-workspace`}
            value={values.workspace}
            maxLength={NAME_MAX}
            autoComplete="organization"
            disabled={busy}
            aria-invalid={errors.workspace ? true : undefined}
            aria-describedby={`${id}-workspace-note`}
            onChange={(event) => setOwnWorkspace(event.target.value)}
            data-testid="welcome-workspace"
          />
          {errors.workspace ? (
            <FieldError id={`${id}-workspace-note`} data-testid="welcome-workspace-error">
              {t(errors.workspace)}
            </FieldError>
          ) : (
            <FieldDescription id={`${id}-workspace-note`}>
              {t("welcome.workspaceHelp")}
            </FieldDescription>
          )}
        </Field>
        <Field data-invalid={timezoneError ? true : undefined}>
          <FieldLabel htmlFor={`${id}-timezone`}>{t("welcome.timezone")}</FieldLabel>
          <TimezoneSelect
            id={`${id}-timezone`}
            value={timezone}
            onChange={setTimezone}
            label={t("welcome.timezone")}
            disabled={busy}
            invalid={Boolean(timezoneError)}
            describedBy={`${id}-timezone-note`}
            testId="welcome-timezone"
          />
          {timezoneError ? (
            <FieldError id={`${id}-timezone-note`} data-testid="welcome-timezone-error">
              {t(timezoneError)}
            </FieldError>
          ) : (
            <FieldDescription id={`${id}-timezone-note`}>
              {t("welcome.timezoneHelp")}
            </FieldDescription>
          )}
        </Field>
      </WelcomeGroup>
      <WelcomeGroup
        title={t("welcome.group.ai")}
        lead={t("welcome.ai.intro")}
        testId="welcome-group-ai"
      >
        <Field>
          <FieldLabel id={`${id}-provider`}>{t("welcome.ai.provider")}</FieldLabel>
          <fieldset
            aria-labelledby={`${id}-provider`}
            disabled={busy}
            className="min-w-0"
            data-testid="welcome-providers"
          >
            <ChoiceCards
              items={OWN_KEY_PROVIDERS.map((option) => ({
                icon: (
                  <span aria-hidden="true" className="text-[11px] font-semibold">
                    {PROVIDER_MARK[option]}
                  </span>
                ),
                title: t(OWN_KEY_PROVIDER_COPY[option].name),
                line: t(OWN_KEY_PROVIDER_COPY[option].line),
                selected: option === provider,
                onSelect: () => {
                  setProvider(option);
                  if (place === "key") setFailure(null);
                },
                testId: `welcome-provider-${option}`,
              }))}
            />
          </fieldset>
        </Field>
        <Field data-invalid={keyError ? true : undefined}>
          <FieldLabel htmlFor={`${id}-key`}>{t("welcome.ai.key")}</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-key`}
              type={keyShown ? "text" : "password"}
              value={key}
              maxLength={KEY_MAX}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={OWN_KEY_PROVIDER_COPY[provider].placeholder}
              disabled={busy}
              aria-invalid={keyError ? true : undefined}
              aria-describedby={`${id}-key-note`}
              onChange={(event) => {
                setKey(event.target.value);
                if (place === "key") setFailure(null);
              }}
              data-testid="welcome-key"
            />
            <IconButton
              type="button"
              variant="outline"
              size="icon"
              disabled={busy}
              aria-pressed={keyShown}
              label={t(keyShown ? "welcome.ai.keyHide" : "welcome.ai.keyShow")}
              onClick={() => setKeyShown((shown) => !shown)}
              data-testid="welcome-key-toggle"
            >
              {keyShown ? <EyeOff /> : <Eye />}
            </IconButton>
          </div>
          {keyError ? (
            <FieldError id={`${id}-key-note`} data-testid="welcome-key-error">
              {t(keyError)}
            </FieldError>
          ) : (
            <FieldDescription id={`${id}-key-note`}>{t("welcome.ai.keyHelp")}</FieldDescription>
          )}
          {keyPage ? (
            <a
              href={keyPage}
              target="_blank"
              rel="noreferrer"
              className="self-start text-xs font-medium text-foreground underline underline-offset-2"
              data-testid="welcome-key-where"
            >
              {t("settings.ai.key.where")}
            </a>
          ) : null}
        </Field>
      </WelcomeGroup>
      <div className="flex flex-col gap-3">
        {failure && place === "alert" ? (
          <p role="alert" className="text-sm text-destructive" data-testid="welcome-error">
            {t(welcomeFailureKey(failure))}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={busy}
          aria-busy={busy || undefined}
          className="w-full sm:w-auto sm:self-start"
          data-testid="welcome-submit"
        >
          {t(submit.isPending || submit.isSuccess ? "welcome.submitting" : "welcome.submit")}
        </Button>
        <p className="text-xs text-muted-foreground" data-testid="welcome-identity">
          {t("welcome.signedIn", { email: pending.email })}
          {" · "}
          <button
            type="button"
            disabled={busy}
            onClick={() => leave.mutate()}
            className="font-medium text-foreground underline underline-offset-2 disabled:opacity-60"
            data-testid="welcome-sign-out"
          >
            {t("welcome.signOut")}
          </button>
        </p>
      </div>
    </form>
  );
}

function WelcomeGroup({
  title,
  lead,
  testId,
  children,
}: {
  title: string;
  lead?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-5" data-testid={testId}>
      <div className="flex flex-col gap-1">
        <SectionHeading className="text-base font-semibold">{title}</SectionHeading>
        {lead ? <p className="text-sm leading-5 text-muted-foreground">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}
