import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, Bot, RefreshCw, Search, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { apiRequest } from "@/api/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ResourceConfig {
  title: string;
  description: string;
  endpoint: string | readonly string[];
  permission: string;
  action?: string;
  empty: string;
}

export const RESOURCE_CONFIGS: Record<string, ResourceConfig> = {
  inbox: {
    title: "Inbox",
    description: "Pending notifications and work that needs attention.",
    endpoint: "/v1/notifications/inbox?limit=200",
    permission: "notification:read",
    empty: "Nothing needs your attention.",
  },
  workflows: {
    title: "Workflows",
    description: "Governed, versioned workflows in this tenant.",
    endpoint: "/v1/workflows?limit=200",
    permission: "workflow:read",
    action: "Create with Subkit",
    empty: "No workflows yet.",
  },
  runs: {
    title: "Runs",
    description: "Execution status, evidence and failures.",
    endpoint: "/v1/executions?limit=200",
    permission: "execution:read",
    empty: "No runs yet.",
  },
  connectors: {
    title: "Connectors",
    description: "Verified interfaces between workflows and external systems.",
    endpoint: "/v1/connectors",
    permission: "connector:read",
    action: "Connect a service",
    empty: "No connectors configured.",
  },
  knowledge: {
    title: "Knowledge",
    description: "Tenant-scoped sources available to governed authoring.",
    endpoint: "/v1/knowledge-sources?limit=200",
    permission: "knowledge:read",
    action: "Add knowledge",
    empty: "No knowledge sources.",
  },
  skills: {
    title: "Skills",
    description: "Human-approved operating knowledge used by Subkit.",
    endpoint: "/v1/skills?limit=200",
    permission: "skill:read",
    action: "Draft a skill",
    empty: "No approved skills.",
  },
  files: {
    title: "Files",
    description: "Shared inputs and outputs with tenant-scoped links.",
    endpoint: "/v1/files?limit=100",
    permission: "file:read",
    empty: "No files stored.",
  },
  approvals: {
    title: "Approvals",
    description: "Proposals stay inactive until an operator explicitly decides.",
    endpoint: ["/v1/skill-candidates?limit=200", "/v1/patch-candidates?limit=200"],
    permission: "conversation:approve",
    empty: "No skill or patch candidates await review.",
  },
  audit: {
    title: "Audit log",
    description: "Append-only records of state-changing operations.",
    endpoint: "/v1/audit-log?limit=200",
    permission: "audit:read",
    empty: "No audit records found.",
  },
  usage: {
    title: "Usage",
    description: "Tenant runtime and execution statistics.",
    endpoint: "/v1/stats/executions",
    permission: "stats:read:all",
    empty: "No execution statistics yet.",
  },
  people: {
    title: "People",
    description: "Users, sessions and tenant membership.",
    endpoint: "/v1/identity/users",
    permission: "identity:read",
    empty: "No users found.",
  },
  access: {
    title: "Access",
    description: "Roles, grants and effective permissions.",
    endpoint: "/v1/rbac/roles",
    permission: "rbac:read",
    empty: "No roles found.",
  },
  "api-access": {
    title: "API access",
    description: "API keys and machine access owned by this tenant.",
    endpoint: "/v1/identity/api-keys",
    permission: "api_key:read",
    empty: "No API keys found.",
  },
  operations: {
    title: "Operations",
    description: "Health, drift, queues and repair proposals.",
    endpoint: "/v1/operator/health-digest",
    permission: "stats:read:all",
    empty: "No operational data returned.",
  },
  settings: {
    title: "Settings",
    description: "Resolved tenant configuration and its source layers.",
    endpoint: "/v1/settings",
    permission: "identity:read",
    empty: "No settings available.",
  },
};

function rowsFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
    );
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) return rowsFrom(record.items);
  return [record];
}

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return Array.isArray(value) ? `${value.length} items` : "Details";
  return String(value);
}

function primaryColumns(rows: Record<string, unknown>[]): string[] {
  const preferred = [
    "name",
    "title",
    "slug",
    "status",
    "type",
    "category",
    "email",
    "action",
    "created_at",
    "updated_at",
    "id",
  ];
  const keys = new Set(rows.flatMap((row) => Object.keys(row)));
  return preferred.filter((key) => keys.has(key)).slice(0, 5);
}

function WorkflowDetail({ selected }: { selected: Record<string, unknown> }) {
  const workflowId = typeof selected.id === "string" ? selected.id : null;
  const query = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => apiRequest<Record<string, unknown>>(`/v1/workflows/${workflowId}`),
    enabled: Boolean(workflowId),
  });
  const steps = query.data && Array.isArray(query.data.steps) ? rowsFrom(query.data.steps) : [];
  const workflowName = cell(selected.name ?? selected.slug ?? selected.id);
  const repairPrompt = encodeURIComponent(`Inspect and improve the workflow ${workflowName}`);

  return (
    <div className="space-y-4 p-4">
      <Button asChild className="w-full">
        <a href={`/cockpit/chat?prompt=${repairPrompt}`}>
          <Bot />
          Edit safely with Subkit
        </a>
      </Button>
      {query.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : query.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load workflow definition</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : steps.length === 0 ? (
        <Empty className="min-h-48 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Workflow />
            </EmptyMedia>
            <EmptyTitle>No committed steps</EmptyTitle>
            <EmptyDescription>
              Start in chat to inspect, validate and preview a draft.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <section className="rounded-xl border bg-muted/30 p-4" aria-label="Workflow step map">
          <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground">
            <span>Committed step map</span>
            <span>{steps.length} steps</span>
          </div>
          <div className="flex flex-col items-center">
            {steps.map((step, index) => (
              <div className="contents" key={cell(step.id ?? index)}>
                <Card className="w-full bg-background shadow-sm">
                  <CardHeader className="gap-2 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="font-mono text-sm">{cell(step.id)}</CardTitle>
                      <Badge variant="secondary">{cell(step.kind)}</Badge>
                    </div>
                    {typeof step.description === "string" && (
                      <CardDescription>{step.description}</CardDescription>
                    )}
                  </CardHeader>
                </Card>
                {index < steps.length - 1 && (
                  <ArrowDown className="my-2 size-4 text-muted-foreground" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">Engine representation</summary>
        <pre className="mt-3 overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
          {JSON.stringify(query.data ?? selected, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function ResourcePage({
  resource,
  permissions,
}: {
  resource: string;
  permissions: readonly string[];
}) {
  const config = RESOURCE_CONFIGS[resource];
  if (!config) throw new Error(`Unknown cockpit resource: ${resource}`);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const query = useQuery({
    queryKey: ["resource", resource],
    queryFn: async () => {
      const endpoints = typeof config.endpoint === "string" ? [config.endpoint] : config.endpoint;
      const results = await Promise.all(endpoints.map((endpoint) => apiRequest<unknown>(endpoint)));
      return results.flatMap(rowsFrom);
    },
    enabled: permissions.includes(config.permission),
  });
  const rows = useMemo(() => rowsFrom(query.data), [query.data]);
  const filtered = useMemo(
    () => rows.filter((row) => JSON.stringify(row).toLowerCase().includes(search.toLowerCase())),
    [rows, search],
  );
  const columns = primaryColumns(rows);
  const chatPrompt = encodeURIComponent(
    `${config.action || "Help me work with"} ${config.title.toLowerCase()}`,
  );

  if (!permissions.includes(config.permission))
    return (
      <main className="p-6">
        <Alert>
          <AlertTitle>Permission required</AlertTitle>
          <AlertDescription>
            Your current role does not include {config.permission}.
          </AlertDescription>
        </Alert>
      </main>
    );
  return (
    <main className="flex min-h-0 flex-1 flex-col" data-cockpit-ui="resource-page">
      <div className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{config.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{config.description}</p>
        </div>
        {config.action && (
          <Button asChild>
            <a href={`/cockpit/chat?prompt=${chatPrompt}`}>
              <Bot />
              {config.action}
            </a>
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2 p-4">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Search ${config.title.toLowerCase()}`}
            className="pl-9"
          />
        </div>
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => query.refetch()}>
          <RefreshCw className={query.isFetching ? "animate-spin" : ""} />
        </Button>
      </div>
      {query.isPending ? (
        <div className="space-y-3 p-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : query.error ? (
        <Alert variant="destructive" className="m-6">
          <AlertTitle>Could not load {config.title.toLowerCase()}</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : filtered.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>{search ? "No matching records" : config.empty}</EmptyTitle>
            <EmptyDescription>
              {search ? "Try a broader search." : "Subkit will show tenant-scoped records here."}
            </EmptyDescription>
          </EmptyHeader>
          {config.action && (
            <EmptyContent>
              <Button asChild variant="outline">
                <a href={`/cockpit/chat?prompt=${chatPrompt}`}>
                  <Bot />
                  {config.action}
                </a>
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
          <Card>
            <CardHeader className="sr-only">
              <CardTitle>{config.title}</CardTitle>
              <CardDescription>{filtered.length} records</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map((column) => (
                      <TableHead key={column}>{column.replaceAll("_", " ")}</TableHead>
                    ))}
                    <TableHead className="w-12">
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row, index) => (
                    <TableRow
                      key={typeof row.id === "string" ? row.id : `${resource}-${index}`}
                      className="cursor-pointer"
                      onClick={() => setSelected(row)}
                    >
                      {columns.map((column) => (
                        <TableCell key={column}>
                          {column === "status" ? (
                            <Badge variant="outline">{cell(row[column])}</Badge>
                          ) : (
                            cell(row[column])
                          )}
                        </TableCell>
                      ))}
                      <TableCell>
                        <ArrowRight className="size-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
            <CardFooter className="justify-between border-t py-3 text-xs text-muted-foreground">
              <span>{filtered.length} records</span>
              <span>Tenant scoped</span>
            </CardFooter>
          </Card>
        </ScrollArea>
      )}
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>
              {selected
                ? cell(selected.name ?? selected.title ?? selected.slug ?? selected.id)
                : "Details"}
            </SheetTitle>
            <SheetDescription>
              Current engine representation for this tenant-scoped record.
            </SheetDescription>
          </SheetHeader>
          {selected && resource === "workflows" ? (
            <WorkflowDetail selected={selected} />
          ) : selected ? (
            <div className="p-4">
              <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
                {JSON.stringify(selected, null, 2)}
              </pre>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </main>
  );
}
