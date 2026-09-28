import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { NotFoundPage, RouteErrorPage } from "@/components/failure-state";
import {
  AccessPage,
  NotificationsPage,
  OperationsPage,
  PeoplePage,
  SettingsPage,
} from "@/pages/admin";
import { ApiAccessPage } from "@/pages/api-access";
import { AuditPage } from "@/pages/audit";
import { CatalogPage } from "@/pages/catalog";
import { CatalogDetailPage, type DetailResource } from "@/pages/catalog-detail";
import { ChatPage } from "@/pages/chat";
import { DecisionsPage } from "@/pages/decisions";
import { OverviewPage } from "@/pages/overview";
import { RunsPage } from "@/pages/runs";
import { UsagePage } from "@/pages/usage";
import { absolute } from "./links";
import {
  CATALOG_RESOURCES,
  CHAT_ROUTES,
  PAGE_ROUTES,
  type PageRoute,
  REDIRECT_ROUTES,
  type RedirectRoute,
  RUN_ROUTES,
  redirectTarget,
} from "./route-table";
import { useSession } from "./session";
import { AppShell } from "./shell";

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

// One component behind all three chat paths: a conversation is chosen from the
// path, not from a different page. The paths are read off the table by
// position rather than mapped over it — a mapped tuple loses its literal types,
// and with them every `<Link to="/chat">` in the product.
const [CHAT_PATH, NEW_CHAT_PATH, CONVERSATION_PATH] = CHAT_ROUTES;

const chatRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: NEW_CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: CONVERSATION_PATH, component: ChatPage }),
];

// The run log and one run, behind one component and deliberately the same
// FUNCTION: React preserves a page's state across a route change only while
// the element type is identical, so a wrapper here — or a second detail page —
// would throw away the list, its filters and its page number the moment a
// reader opened a row, and would leave two run views to keep in step. The id
// selects a row in the sheet the list already has.
//
// Read off the table by position for the reason given above CHAT_ROUTES: a
// parameterised path inside a mapped tuple loses its literal type and makes
// `params` required on every `<Link>` in the same union.
const [RUNS_PATH, RUN_PATH] = RUN_ROUTES;

const runRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: RUNS_PATH, component: RunsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: RUN_PATH, component: RunsPage }),
];

// Every page is its own module (CUI-PAGE-2). There is no generic resource
// renderer any more: a list that cannot say which columns it has cannot say
// which relations matter either.
//
// The map is exhaustive over PAGE_ROUTES, so a page route that exists only
// here — invisible to the navigation and to the conformity sweep — cannot be
// added: it has to be in the table first, and then it is swept.
const PAGE_COMPONENTS: Record<PageRoute, () => React.ReactElement> = {
  "/": OverviewPage,
  "/decisions": DecisionsPage,
  "/audit": AuditPage,
  "/usage": UsagePage,
  "/people": PeoplePage,
  "/access": AccessPage,
  "/api-access": ApiAccessPage,
  "/notifications": NotificationsPage,
  "/operations": OperationsPage,
  "/settings": SettingsPage,
};

const dedicatedRoutes = PAGE_ROUTES.map((path) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: PAGE_COMPONENTS[path] }),
);

// A moved page keeps its old address as a redirect, query included: an OAuth
// callback issued before the move still lands with its result. `href` rather
// than `to` + `search`, because the router's default search serialiser would
// quote a value that looks like JSON (`renewed=1` → `renewed=%221%22`), and
// the page reads its query as plain text. The href carries the base; the
// router's basepath rewrite strips it on the way in.
const redirectRoutes = (Object.keys(REDIRECT_ROUTES) as RedirectRoute[]).map((path) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: ({ location }) => {
      throw redirect({
        href: absolute(redirectTarget(REDIRECT_ROUTES[path], location.searchStr)),
        replace: true,
      });
    },
  }),
);

const catalogRoutes = CATALOG_RESOURCES.flatMap((resource) => [
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}`,
    component: () => {
      const session = useSession();
      return (
        <CatalogPage resource={resource as DetailResource} permissions={session.permissions} />
      );
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}/$resourceId`,
    component: () => {
      const session = useSession();
      return (
        <CatalogDetailPage
          resource={resource as DetailResource}
          permissions={session.permissions}
        />
      );
    },
  }),
]);

const routeTree = rootRoute.addChildren([
  ...chatRoutes,
  ...runRoutes,
  ...dedicatedRoutes,
  ...redirectRoutes,
  ...catalogRoutes,
]);

// One catch-all for every route: a render fault keeps the shell, the language
// and a way out, instead of the router's own English default.
export const router = createRouter({
  routeTree,
  basepath: "/cockpit",
  trailingSlash: "never",
  defaultErrorComponent: RouteErrorPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
