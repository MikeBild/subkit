import { cockpitApiHref } from "./installation-context";

export function loginHref(
  location: Pick<Location, "pathname" | "search"> = window.location,
  options: { reauth?: boolean } = {},
): string {
  const returnTo = `${location.pathname}${location.search}`;
  const reauth = options.reauth ? "&reauth=1" : "";
  return cockpitApiHref(
    `/v1/identity/cockpit-login?return_to=${encodeURIComponent(returnTo)}${reauth}`,
    location.pathname,
  );
}
