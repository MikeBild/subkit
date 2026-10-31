const CAPABILITY_LINK = /^https:\/\/[^\s#]+#\S{16,}$/;

export const CAPABILITY_LINK_NOTICE =
  "(personal link: the person opens it from the button on the result card. Never write a link yourself; say the button is on the card.)";

export function hideCapabilityLinks(value: unknown): unknown {
  if (typeof value === "string")
    return CAPABILITY_LINK.test(value) ? CAPABILITY_LINK_NOTICE : value;
  if (Array.isArray(value)) return value.map(hideCapabilityLinks);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, hideCapabilityLinks(item)]),
  );
}
