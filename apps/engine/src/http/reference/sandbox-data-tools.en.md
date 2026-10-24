---
slug: sandbox-data-tools
summary: Which sk helpers JavaScript transforms can use and where their limits are.
section: operate
order: 10
audience: operator
---
## Sandbox data tools

JavaScript workflow transforms can use bounded, synchronous `sk` helpers. They
perform no network, filesystem or credential access. Namespaces are immutable.
Promises and unseeded randomness are unsupported; use the execution clock and
`sk.uuid()` for repeatable values.

| Task | Helpers | Contract |
| --- | --- | --- |
| Decimal amounts | `sk.money.add/sub/mul/div/round/compare` | Decimal strings; `div` and `round` require scale and `down`, `halfUp`, `halfEven` or `up`. No currency conversion. |
| CSV | `sk.csv.parse/stringify` | Explicit delimiter/header options; export escapes spreadsheet formulas by default. Up to 10,000 rows. |
| Dates | `sk.date.parse/format/add/startOf/convertZone` | Date-only values stay dates. Local datetimes require an IANA zone; ambiguous or missing DST times require explicit `earlier`/`later`. |
| Validation | `sk.schema.validate/assert`, `sk.assert` | Local schema references only; no remote resolution or asynchronous validators. |
| URLs | `sk.url.parse/build/query/encode/decode` | WHATWG parsing, repeated query entries, UTF-8 percent encoding. No requests. |
| XML | `sk.xml.parse/build` | Ordered `{name, attributes, children}` trees retain mixed text; no DTD or custom entities. |
| Text and records | `sk.template.render`, `sk.diff.records` | Escaped HTML by default, explicit text mode; bounded list sections. Record diff requires a unique key. |

```javascript
return {
  total: sk.money.add("19.90", "4.95"),
  csv: sk.csv.stringify([{ name: "Ada", amount: "24.85" }]),
  tomorrow: sk.date.add("2024-02-28", 1, "days"),
  greeting: sk.template.render("Hello {{name}}", { name: "Ada" })
};
```

Text inputs and outputs are limited to 1 MiB, structures to 100,000 nodes and
64 levels. Existing sandbox memory, execution and output budgets still apply.
Each helper is embedded and loaded on first access in each sandbox.
Package versions and timezone data are pinned for each release. These tools do not add document rendering, OCR or a browser.
JavaScript transforms, JSONata and binary parsing use bounded worker processes.
The default lane can run two workers in parallel; hooks have a separate lane.
Per-engine-process global and per-tenant queue limits apply across default and
hook workers.
The RSS watchdog is available on Linux; it is a polling limit rather than a
kernel-enforced memory ceiling.
