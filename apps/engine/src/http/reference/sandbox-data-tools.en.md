---
slug: sandbox-data-tools
summary: Calculate, parse and validate data in JavaScript transforms with built-in helpers.
section: operate
order: 10
audience: operator
---
## Sandbox data tools

In a JavaScript transform step you calculate, parse and validate data with the built-in `sk` helpers. You need them when a workflow calculates amounts, reads CSV or XML, converts times across time zones or validates input. Afterwards you know what each helper does and where its limits are.

The helpers run synchronously and bounded inside the sandbox, the isolated runtime of the step. They never access the network, filesystem or credentials. Their namespaces are immutable. Promises and unseeded randomness are unsupported; for repeatable values use the execution clock and `sk.uuid()`.

| Task | Helpers | Rules |
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

### Limits and operation

Text inputs and outputs are limited to 1 MiB, structures to 100,000 nodes and
64 levels. Existing sandbox memory, execution and output budgets still apply.
Each helper is embedded and loaded only on first access in each sandbox.
Package versions and timezone data are pinned for each release. The helpers do not
bring document rendering, OCR or a browser.

JavaScript transforms, JSONata and binary parsing run in bounded worker processes.
The default lane runs up to two workers in parallel; hooks have a separate lane.
Per engine process, global and per-tenant queue limits apply across both lanes.
On Linux an RSS watchdog polls memory use regularly.
It is not a kernel-enforced memory ceiling.
