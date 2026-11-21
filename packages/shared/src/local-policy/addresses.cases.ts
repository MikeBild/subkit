import type { AllowanceEnteredBy } from "../device/boundary.ts";
import type { DeviceRefusal } from "../device/protocol.ts";
import type { AddressClass } from "./addresses.ts";
import type { CaseDirection } from "./paths.cases.ts";

export interface AddressClassCase {
  readonly ip: string;
  readonly expected: AddressClass;
}

export const ADDRESS_CLASS_CASES: readonly AddressClassCase[] = [
  { ip: "8.8.8.8", expected: "public" },
  { ip: "1.1.1.1", expected: "public" },
  { ip: "93.184.216.34", expected: "public" },
  { ip: "172.15.255.255", expected: "public" },
  { ip: "172.32.0.0", expected: "public" },
  { ip: "100.63.255.255", expected: "public" },
  { ip: "100.128.0.0", expected: "public" },
  { ip: "192.169.0.1", expected: "public" },
  { ip: "126.255.255.255", expected: "public" },
  { ip: "128.0.0.0", expected: "public" },
  { ip: "223.255.255.255", expected: "public" },
  { ip: "127.0.0.1", expected: "loopback" },
  { ip: "127.255.255.254", expected: "loopback" },
  { ip: "10.0.0.1", expected: "private" },
  { ip: "10.255.255.255", expected: "private" },
  { ip: "172.16.0.1", expected: "private" },
  { ip: "172.31.255.255", expected: "private" },
  { ip: "192.168.1.1", expected: "private" },
  { ip: "100.64.0.1", expected: "private" },
  { ip: "100.127.255.255", expected: "private" },
  { ip: "169.254.169.254", expected: "link_local" },
  { ip: "169.254.0.1", expected: "link_local" },
  { ip: "0.0.0.0", expected: "reserved" },
  { ip: "0.1.2.3", expected: "reserved" },
  { ip: "192.0.0.8", expected: "reserved" },
  { ip: "192.0.2.1", expected: "reserved" },
  { ip: "192.88.99.1", expected: "reserved" },
  { ip: "198.18.0.1", expected: "reserved" },
  { ip: "198.19.255.255", expected: "reserved" },
  { ip: "198.20.0.0", expected: "public" },
  { ip: "198.51.100.7", expected: "reserved" },
  { ip: "203.0.113.9", expected: "reserved" },
  { ip: "224.0.0.251", expected: "reserved" },
  { ip: "239.255.255.250", expected: "reserved" },
  { ip: "240.0.0.1", expected: "reserved" },
  { ip: "255.255.255.255", expected: "reserved" },
  { ip: "2606:4700:4700::1111", expected: "public" },
  { ip: "2001:4860:4860::8888", expected: "public" },
  { ip: "[2a00:1450:4001:80b::200e]", expected: "public" },
  { ip: "::1", expected: "loopback" },
  { ip: "0:0:0:0:0:0:0:1", expected: "loopback" },
  { ip: "[::1]", expected: "loopback" },
  { ip: "::", expected: "reserved" },
  { ip: "fe80::1", expected: "link_local" },
  { ip: "fe80::1%en0", expected: "link_local" },
  { ip: "[fe80::1%25en0]", expected: "link_local" },
  { ip: "febf::1", expected: "link_local" },
  { ip: "fec0::1", expected: "private" },
  { ip: "fc00::1", expected: "private" },
  { ip: "fd12:3456:789a::1", expected: "private" },
  { ip: "ff02::1", expected: "reserved" },
  { ip: "::ffff:127.0.0.1", expected: "loopback" },
  { ip: "::ffff:7f00:1", expected: "loopback" },
  { ip: "::FFFF:192.168.0.1", expected: "private" },
  { ip: "::ffff:8.8.8.8", expected: "public" },
  { ip: "::ffff:0:10.0.0.1", expected: "private" },
  { ip: "::127.0.0.1", expected: "loopback" },
  { ip: "::8.8.8.8", expected: "reserved" },
  { ip: "64:ff9b::127.0.0.1", expected: "loopback" },
  { ip: "64:ff9b::c0a8:101", expected: "private" },
  { ip: "64:ff9b::808:808", expected: "public" },
  { ip: "64:ff9b:1::1", expected: "private" },
  { ip: "2002:7f00:1::", expected: "loopback" },
  { ip: "2002:c0a8:101::1", expected: "private" },
  { ip: "2002:808:808::1", expected: "public" },
  { ip: "2001::1", expected: "reserved" },
  { ip: "2001:db8::1", expected: "reserved" },
  { ip: "2001:10::1", expected: "reserved" },
  { ip: "2001:20::1", expected: "reserved" },
  { ip: "2001:30::1", expected: "public" },
  { ip: "3fff::1", expected: "reserved" },
  { ip: "3fff:1000::1", expected: "public" },
  { ip: "100::1", expected: "reserved" },
  { ip: "4000::1", expected: "reserved" },
  { ip: "1:2:3:4:5:6:7:8", expected: "reserved" },
  { ip: "2001:db8:0:0:0:0:2:1", expected: "reserved" },
  { ip: "", expected: "reserved" },
  { ip: "localhost", expected: "reserved" },
  { ip: "127.1", expected: "reserved" },
  { ip: "0x7f.0.0.1", expected: "reserved" },
  { ip: "2130706433", expected: "reserved" },
  { ip: "127.000.000.001", expected: "reserved" },
  { ip: "256.0.0.1", expected: "reserved" },
  { ip: "1.2.3.4.5", expected: "reserved" },
  { ip: "1:2:3:4:5:6:7:8:9", expected: "reserved" },
  { ip: "1::2::3", expected: "reserved" },
  { ip: "1:2:3:4:5:6:7::8", expected: "reserved" },
  { ip: "12345::1", expected: "reserved" },
  { ip: "::ffff:999.0.0.1", expected: "reserved" },
  { ip: "1:2:3:4:5:6:7", expected: "reserved" },
  { ip: ":::1", expected: "reserved" },
  { ip: "1:", expected: "reserved" },
];

export interface OriginCase {
  readonly id: string;
  readonly direction: CaseDirection;
  readonly url: string;
  readonly allowances: readonly { origin: string; entered_by: AllowanceEnteredBy }[];
  readonly resolved_ip?: string;
  readonly expected: "ok" | DeviceRefusal;
}

const SHOP = { origin: "https://shop.example.com", entered_by: "approval" as const };
const ROUTER = { origin: "http://192.168.1.1", entered_by: "person" as const };
const NAS = { origin: "http://nas.local:5000", entered_by: "person" as const };
const LLM = { origin: "http://localhost:11434", entered_by: "person" as const };

function allowed(
  id: string,
  url: string,
  allowances: OriginCase["allowances"],
  resolved_ip?: string,
): OriginCase {
  return {
    id,
    direction: "needless_ask",
    url,
    allowances,
    expected: "ok",
    ...(resolved_ip === undefined ? {} : { resolved_ip }),
  };
}

function refused(
  id: string,
  url: string,
  allowances: OriginCase["allowances"],
  expected: DeviceRefusal,
  resolved_ip?: string,
): OriginCase {
  return {
    id,
    direction: "over_permission",
    url,
    allowances,
    expected,
    ...(resolved_ip === undefined ? {} : { resolved_ip }),
  };
}

export const ORIGIN_CASES: readonly OriginCase[] = [
  allowed("same-origin-root", "https://shop.example.com/", [SHOP]),
  allowed("same-origin-path", "https://shop.example.com/products?id=1#top", [SHOP]),
  allowed("same-origin-case", "HTTPS://Shop.Example.COM/a", [SHOP]),
  allowed("explicit-default-port", "https://shop.example.com:443/a", [SHOP]),
  allowed("trailing-dot-host", "https://shop.example.com./a", [SHOP]),
  allowed("public-resolution", "https://shop.example.com/a", [SHOP], "93.184.216.34"),
  allowed("router-entered", "http://192.168.1.1/admin", [ROUTER]),
  allowed("router-entered-resolved", "http://192.168.1.1/", [ROUTER], "192.168.1.1"),
  allowed("nas-entered-port", "http://nas.local:5000/share", [NAS], "192.168.1.20"),
  allowed("local-model-entered", "http://localhost:11434/api/tags", [LLM], "127.0.0.1"),
  allowed("allowance-with-path", "https://shop.example.com/x", [
    { origin: "https://shop.example.com/ignored", entered_by: "approval" },
  ]),
  allowed(
    "entered-public-name-resolving-private",
    "https://intranet.example.com/",
    [{ origin: "https://intranet.example.com", entered_by: "person" }],
    "10.1.2.3",
  ),
  refused("other-origin", "https://evil.example.net/", [SHOP], "origin_not_allowed"),
  refused("subdomain", "https://api.shop.example.com/", [SHOP], "origin_not_allowed"),
  refused("parent-domain", "https://example.com/", [SHOP], "origin_not_allowed"),
  refused("scheme-downgrade", "http://shop.example.com/", [SHOP], "origin_not_allowed"),
  refused("other-port", "https://shop.example.com:8443/", [SHOP], "origin_not_allowed"),
  refused(
    "port-only-by-approval",
    "https://shop.example.com:8443/",
    [{ origin: "https://shop.example.com:8443", entered_by: "approval" }],
    "origin_not_allowed",
  ),
  refused("credentials-in-url", "https://user:pw@shop.example.com/", [SHOP], "origin_not_allowed"),
  refused("username-only", "https://user@shop.example.com/", [SHOP], "origin_not_allowed"),
  refused("file-scheme", "file:///etc/passwd", [SHOP], "origin_not_allowed"),
  refused("javascript-scheme", "javascript:alert(1)", [SHOP], "origin_not_allowed"),
  refused("data-scheme", "data:text/html,hi", [SHOP], "origin_not_allowed"),
  refused("ftp-scheme", "ftp://shop.example.com/", [SHOP], "origin_not_allowed"),
  refused("not-a-url", "shop.example.com", [SHOP], "origin_not_allowed"),
  refused("empty", "", [SHOP], "origin_not_allowed"),
  refused("no-allowances", "https://shop.example.com/", [], "origin_not_allowed"),
  refused("page-suggested-router", "http://192.168.1.1/", [SHOP], "private_address"),
  refused(
    "router-by-approval",
    "http://192.168.1.1/",
    [{ origin: "http://192.168.1.1", entered_by: "approval" }],
    "private_address",
  ),
  refused("other-private-host", "http://192.168.1.2/", [ROUTER], "private_address"),
  refused("loopback-literal", "http://127.0.0.1/", [SHOP], "private_address"),
  refused("loopback-hex", "http://0x7f.1/", [SHOP], "private_address"),
  refused("loopback-decimal", "http://2130706433/", [SHOP], "private_address"),
  refused("loopback-octal", "http://0177.0.0.1/", [SHOP], "private_address"),
  refused("loopback-short", "http://127.1/", [SHOP], "private_address"),
  refused("loopback-v6", "http://[::1]/", [SHOP], "private_address"),
  refused("mapped-v6", "http://[::ffff:127.0.0.1]/", [SHOP], "private_address"),
  refused("nat64", "http://[64:ff9b::7f00:1]/", [SHOP], "private_address"),
  refused("metadata-service", "http://169.254.169.254/latest/meta-data", [SHOP], "private_address"),
  refused("localhost", "http://localhost:3000/", [SHOP], "private_address"),
  refused("localhost-sub", "http://app.localhost/", [SHOP], "private_address"),
  refused("dot-local", "http://printer.local/", [SHOP], "private_address"),
  refused("home-arpa", "http://router.home.arpa/", [SHOP], "private_address"),
  refused("single-label", "http://intranet/", [SHOP], "private_address"),
  refused("unspecified", "http://0.0.0.0/", [SHOP], "private_address"),
  refused("cgnat", "http://100.64.1.1/", [SHOP], "private_address"),
  refused("ula", "http://[fd00::1]/", [SHOP], "private_address"),
  refused("loopback-other-port", "http://localhost:8080/", [LLM], "private_address"),
  refused("dns-rebinding", "https://shop.example.com/", [SHOP], "private_address", "127.0.0.1"),
  refused(
    "dns-rebinding-private",
    "https://shop.example.com/",
    [SHOP],
    "private_address",
    "10.0.0.5",
  ),
  refused(
    "dns-rebinding-mapped",
    "https://shop.example.com/",
    [SHOP],
    "private_address",
    "::ffff:192.168.0.1",
  ),
  refused(
    "dns-rebinding-metadata",
    "https://shop.example.com/",
    [SHOP],
    "private_address",
    "169.254.169.254",
  ),
  refused("dns-garbage", "https://shop.example.com/", [SHOP], "private_address", "not-an-ip"),
  refused(
    "redirect-off-origin",
    "https://login.evil.example.net/",
    [SHOP],
    "origin_not_allowed",
    "93.184.216.34",
  ),
];

export interface PersonalOriginCase {
  readonly id: string;
  readonly direction: CaseDirection;
  readonly url: string;
  readonly resolved_ip?: string;
  readonly expected: "ok" | DeviceRefusal;
}

export const PERSONAL_SITE_OPTIONS = {
  entered_by_person: [
    "http://192.168.1.1",
    "http://nas.local:5000",
    "https://intranet.example.com",
  ],
} as const;

function ref(
  id: string,
  url: string,
  expected: "ok" | DeviceRefusal,
  resolved_ip?: string,
): PersonalOriginCase {
  return {
    id: `ref-${id}`,
    direction: expected === "ok" ? "needless_ask" : "over_permission",
    url,
    expected,
    ...(resolved_ip === undefined ? {} : { resolved_ip }),
  };
}

export const PERSONAL_ORIGIN_CASES: readonly PersonalOriginCase[] = [
  ref("public", "https://example.com/", "ok"),
  ref("public-path", "https://news.example.org/a?b=1#c", "ok"),
  ref("public-http", "http://example.com/", "ok"),
  ref("public-resolved", "https://example.com/", "ok", "93.184.216.34"),
  ref("router-entered", "http://192.168.1.1/admin", "ok"),
  ref("router-entered-resolved", "http://192.168.1.1/", "ok", "192.168.1.1"),
  ref("nas-entered-port", "http://nas.local:5000/share", "ok", "192.168.1.20"),
  ref("entered-name-resolving-private", "https://intranet.example.com/", "ok", "10.1.2.3"),
  ref("other-private", "http://192.168.1.2/", "private_address"),
  ref("loopback", "http://127.0.0.1/", "private_address"),
  ref("localhost", "http://localhost:3000/", "private_address"),
  ref("metadata", "http://169.254.169.254/latest", "private_address"),
  ref("dot-local", "http://printer.local/", "private_address"),
  ref("nas-other-port", "http://nas.local:8080/", "private_address"),
  ref("mapped-v6", "http://[::ffff:127.0.0.1]/", "private_address"),
  ref("public-other-port", "https://example.com:8443/", "origin_not_allowed"),
  ref("credentials", "https://user:pw@example.com/", "origin_not_allowed"),
  ref("file", "file:///etc/passwd", "origin_not_allowed"),
  ref("not-a-url", "example.com", "origin_not_allowed"),
  ref("dns-rebinding", "https://example.com/", "private_address", "10.0.0.5"),
  ref("dns-rebinding-loopback", "https://example.com/", "private_address", "::1"),
];
