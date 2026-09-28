import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { NotFoundPage, RouteErrorPage } from "@/components/failure-state";
import { NotificationsPage, PeopleAndAccessPage } from "@/pages/admin";
import { ApiAccessPage } from "@/pages/api-access";
import { AuditPage } from "@/pages/audit";
import { CatalogPage } from "@/pages/catalog";
import { CatalogDetailPage, type DetailResource } from "@/pages/catalog-detail";
import { ChatPage } from "@/pages/chat";
import { RunsPage } from "@/pages/runs";
import { SettingsPage } from "@/pages/settings";
import { TodayPage } from "@/pages/today";
import { UsagePage } from "@/pages/usage";
import { absolute } from "./links";
import {
  CATALOG_RESOURCES,
  CHAT_ROUTES,
  legacyTarget,
  PAGE_ROUTES,
  type PageRoute,
  REDIRECT_ROUTES,
  RUN_ROUTES,
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
  "/": TodayPage,
  "/audit": AuditPage,
  "/usage": UsagePage,
  "/people": PeopleAndAccessPage,
  "/api-access": ApiAccessPage,
  "/notifications": NotificationsPage,
  "/settings": SettingsPage,
};

const dedicatedRoutes = PAGE_ROUTES.map((path) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: PAGE_COMPONENTS[path] }),
);

// A moved page keeps its old address as a redirect, query included: an OAuth
// callback issued before the move still lands with its result.
//
// The query is read from `window.location.search` and the browser is sent on
// with `location.replace`, never through the router. Both of the router's own
// paths run the query through its JSON search serialiser: `location.searchStr`
// is `stringify(parse(raw))`, and a `redirect({ href })` is parsed again on
// commit — so `connected=1e5` arrived as `100000`, a long all-digit name lost
// precision, and `to` + `search` would quote `renewed=1`. A moved address is
// rare enough that a full load is the honest price for its query arriving
// exactly as it was sent.
const redirectRoutes = REDIRECT_ROUTES.map((path) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      window.location.replace(absolute(legacyTarget(path, window.location.search)));
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
