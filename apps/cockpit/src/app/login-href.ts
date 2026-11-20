import { cockpitApiHref } from "./installation-context";

export function loginHref(
  location: Pick<Location, "pathname" | "search"> = window.location,
): string {
  const returnTo = `${location.pathname}${location.search}`;
  return cockpitApiHref(
    `/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}`,
    location.pathname,
  );
}
