import { useMutation, useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, PlugZap, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { apiRequest } from "@/api/client";
import type { components } from "@/api/schema";
import { useSession } from "@/app/session";
import { ContextHelp } from "@/components/cockpit/context-help";
import { IconButton } from "@/components/cockpit/icon-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
  authStateHint,
  authStateLabel,
  connectorAuthState,
  connectorHealthLabel,
  needsRenewal,
} from "@/lib/connector-auth-state";
import { useI18n } from "@/lib/i18n-context";

type ConnectorItem = components["schemas"]["ConnectorListItem"];
type ProbeResult = components["schemas"]["ConnectorProbeResult"];

export function ConnectorsPage() {
  const { t } = useI18n();
  const session = useSession();
  const allowed = session.permissions.includes("connector:read");
  const canTest = session.permissions.includes("connector:test");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const title = t("nav.connectors");

  const query = useQuery({
    queryKey: ["connectors", "cards", category],
    enabled: allowed,
    queryFn: () => {
      const params = new URLSearchParams({ limit: "200", sort: "name", order: "asc" });
      if (category !== "all") params.set("category", category);
      return apiRequest<{
        items: ConnectorItem[];
        categories: { category: string; count: number }[];
      }>(`/v1/connectors?${params}`);
    },
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      apiRequest<ProbeResult>(`/v1/connectors/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onMutate: (id) => setTesting(id),
    onSuccess: (result, id) => setProbes((current) => ({ ...current, [id]: result })),
    onSettled: () => setTesting(null),
  });

  if (!allowed)
    return (
      <main className="p-6" data-testid="resource-permission-denied">
        <Alert data-testid="resource-permission-alert">
          <AlertTitle>{t("resource.permission.title")}</AlertTitle>
          <AlertDescription>{t("resource.permission.description")}</AlertDescription>
        </Alert>
      </main>
    );

  const needle = search.trim().toLowerCase();
  const items = (query.data?.items ?? []).filter((item) =>
    needle ? item.display_name.toLowerCase().includes(needle) : true,
  );
  const categories = query.data?.categories ?? [];

  return (
    <main className="flex min-h-0 flex-1 flex-col" data-testid="connectors-page">
      <header
        className="flex shrink-0 flex-col items-stretch justify-between gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:px-8"
        data-testid="connectors-header"
      >
        <div className="flex items-center gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          <ContextHelp
            label={t("resource.about", { resource: title })}
            testId="connectors-description"
          >
            {t("resource.connectors.description")}
          </ContextHelp>
        </div>
        <IconButton
          variant="outline"
          label={t("common.refresh")}
          data-testid="connectors-refresh"
          onClick={() => void query.refetch()}
        >
          <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
        </IconButton>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <InputGroup className="w-full sm:max-w-sm">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("resource.search", { resource: title })}
            aria-label={t("resource.search", { resource: title })}
            data-testid="connectors-search"
          />
        </InputGroup>
        <Button
          variant={category === "all" ? "default" : "outline"}
          size="sm"
          data-testid="connectors-category-all"
          onClick={() => setCategory("all")}
        >
          {t("catalog.allCategories")}
        </Button>
        {categories.map((entry, index) => (
          <Button
            key={entry.category}
            variant={category === entry.category ? "default" : "outline"}
            size="sm"
            data-testid={`connectors-category-${index}`}
            onClick={() => setCategory(entry.category)}
          >
            {entry.category}
            <Badge variant="secondary" className="ml-2 tabular-nums">
              {entry.count}
            </Badge>
          </Button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {query.isPending ? (
          <div className="grid gap-3 md:grid-cols-2" role="status" aria-label={t("common.loading")}>
            <Skeleton className="h-44 w-full" />
            <Skeleton className="h-44 w-full" />
          </div>
        ) : query.error ? (
          <Alert variant="destructive" data-testid="connectors-error">
            <AlertTitle>{t("resource.loadFailed", { resource: title })}</AlertTitle>
            <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              data-testid="connectors-retry"
              onClick={() => void query.refetch()}
            >
              {t("session.retry")}
            </Button>
          </Alert>
        ) : items.length === 0 ? (
          <div className="rounded-lg border p-6 text-center" data-testid="connectors-empty">
            <p className="text-sm font-medium">
              {needle || category !== "all"
                ? t("resource.noMatches")
                : t("resource.connectors.empty")}
            </p>
            <Button asChild className="mt-3">
              <a
                href={`/cockpit/chat/new?prompt=${encodeURIComponent(t("resource.connectors.action"))}`}
                data-testid="connectors-empty-action"
              >
                {t("resource.connectors.action")}
              </a>
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2" data-testid="connectors-cards">
            {items.map((item, index) => (
              <ConnectorCard
                key={item.id}
                connector={item}
                index={index}
                probe={probes[item.id] ?? null}
                testing={testing === item.id}
                canTest={canTest}
                onTest={() => test.mutate(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function ConnectorCard({
  connector,
  index,
  probe,
  testing,
  canTest,
  onTest,
}: {
  connector: ConnectorItem;
  index: number;
  probe: ProbeResult | null;
  testing: boolean;
  canTest: boolean;
  onTest: () => void;
}) {
  const { t } = useI18n();
  const state = connectorAuthState(connector, probe);
  const healthLabel =
    connector.health_state === "ok" ? null : connectorHealthLabel(connector.health_state);
  const testId = `connector-card-${index}`;

  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{connector.display_name}</span>
          <Badge variant="outline" data-testid={`${testId}-environment`}>
            {connector.environment}
          </Badge>
          {!connector.enabled && <Badge variant="secondary">{t("connectors.disabled")}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        <p className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${
              state === "connected" || state === "not_required"
                ? "bg-emerald-500"
                : needsRenewal(state)
                  ? "bg-destructive"
                  : "bg-muted-foreground"
            }`}
          />
          <span className="font-medium" data-testid={`${testId}-auth`}>
            {t(authStateLabel(state))}
          </span>
          <span className="text-muted-foreground">· {connector.driver}</span>
        </p>
        <p className="text-xs text-muted-foreground">{t(authStateHint(state))}</p>
        {healthLabel && (
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-health`}>
            {t("connectors.health", { state: t(healthLabel) })}
            {connector.health_reason ? ` · ${connector.health_reason}` : ""}
          </p>
        )}
        {probe && (
          <div className="rounded-md border p-2 text-xs" data-testid={`${testId}-probe`}>
            <p
              className={`flex items-center gap-2 ${probe.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}
            >
              {probe.ok ? (
                <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
              )}
              {probe.ok
                ? t("connectors.probeOk", { ms: String(Math.round(probe.latency_ms)) })
                : (probe.detail ?? t("connectors.probeFailed"))}
            </p>
            {probe.missing_scopes && probe.missing_scopes.length > 0 && (
              <p className="mt-1 text-muted-foreground">
                {t("connectors.missingScopes", { scopes: probe.missing_scopes.join(", ") })}
              </p>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {canTest && (
          <Button
            variant="outline"
            size="sm"
            disabled={testing}
            data-testid={`${testId}-test`}
            onClick={onTest}
          >
            <PlugZap data-icon="inline-start" />
            {t(testing ? "connectors.testing" : "connectors.test")}
          </Button>
        )}
        {needsRenewal(state) && probe?.provider_action_url && (
          <Button variant="outline" size="sm" asChild>
            <a
              href={probe.provider_action_url}
              target="_blank"
              rel="noreferrer"
              data-testid={`${testId}-renew`}
            >
              {t("connectors.renew")}
            </a>
          </Button>
        )}
        <Button variant="ghost" size="sm" asChild>
          <a href={`/cockpit/connectors/${connector.id}`} data-testid={`${testId}-open`}>
            {t("common.open")}
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}
