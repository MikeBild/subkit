import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { NotFoundPage, RouteErrorPage } from "@/components/failure-state";
import { ConnectorsPage } from "@/features/connectors";
import {
  FilePage,
  FilesPage,
  InboxEntryPage,
  InboxPage,
  SkillCandidatesPage,
  SkillPage,
  SkillsPage,
  SourcePage,
  SourcesPage,
} from "@/features/knowledge";
import { NotesPage } from "@/features/notes";
import { UsagePage } from "@/features/usage";
import { ApiAccessPage } from "@/pages/api-access";
import { AuditPage } from "@/pages/audit";
import { CatalogPage } from "@/pages/catalog";
import { CatalogDetailPage, type DetailResource } from "@/pages/catalog-detail";
import { ChatPage } from "@/pages/chat";
import { DocsArticlePage, DocsIndexPage } from "@/pages/docs";
import { OverviewPage } from "@/pages/overview";
import { RunPage } from "@/pages/run-page";
import { SettingsPage } from "@/pages/settings";
import { TaskPage, TasksPage } from "@/pages/tasks";
import { cockpitBasePath } from "./installation-context";
import { absolute } from "./links";
import {
  CHAT_ROUTES,
  movedTarget,
  PAGE_ROUTES,
  type PageRoute,
  REDIRECT_ROUTES,
} from "./route-table";
import { useSession } from "./session";
import { AppShell } from "./shell";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const [CHAT_PATH, NEW_CHAT_PATH, CONVERSATION_PATH] = CHAT_ROUTES;

const chatRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: NEW_CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: CONVERSATION_PATH, component: ChatPage }),
];

const PAGE_COMPONENTS: Record<PageRoute, () => React.ReactElement> = {
  "/": OverviewPage,
  "/audit": AuditPage,
  "/usage": UsagePage,
  "/api-access": ApiAccessPage,
  "/settings": SettingsPage,
};

const dedicatedRoutes = PAGE_ROUTES.map((path) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: PAGE_COMPONENTS[path] }),
);

const redirectRoutes = REDIRECT_ROUTES.map((path) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      window.location.replace(absolute(movedTarget(window.location.search)));
    },
  }),
);

const knowledgeRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/intake", component: InboxPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/intake/$resourceId",
    component: InboxEntryPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/knowledge", component: SourcesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge/$resourceId",
    component: SourcePage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/skills", component: SkillsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/candidates",
    component: SkillCandidatesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/skills/$resourceId",
    component: SkillPage,
  }),
];

const taskRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks",
    component: () => <TasksPage permissions={useSession().permissions} />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks/$resourceId",
    component: () => <TaskPage permissions={useSession().permissions} />,
  }),
];

const notesRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/notes", component: NotesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/notes/$resourceId",
    component: NotesPage,
  }),
];

const filesRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/files", component: FilesPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/incoming/files",
    component: FilesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/files/$resourceId",
    component: FilePage,
  }),
];

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunPage,
});

const docsRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/docs", component: DocsIndexPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/docs/$slug", component: DocsArticlePage }),
];

const CATALOG_PAGES = ["workflows", "connectors"] as const satisfies readonly DetailResource[];

const catalogRoutes = CATALOG_PAGES.flatMap((resource) => [
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}`,
    component: () => {
      const session = useSession();
      if (resource === "connectors") return <ConnectorsPage />;
      return <CatalogPage permissions={session.permissions} />;
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}/$resourceId`,
    component: () => {
      const session = useSession();
      return <CatalogDetailPage resource={resource} permissions={session.permissions} />;
    },
  }),
]);

const routeTree = rootRoute.addChildren([
  ...chatRoutes,
  ...dedicatedRoutes,
  ...redirectRoutes,
  ...catalogRoutes,
  ...knowledgeRoutes,
  ...taskRoutes,
  ...notesRoutes,
  ...filesRoutes,
  ...docsRoutes,
  runRoute,
]);

export const router = createRouter({
  routeTree,
  basepath: cockpitBasePath(),
  trailingSlash: "never",
  defaultErrorComponent: RouteErrorPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
