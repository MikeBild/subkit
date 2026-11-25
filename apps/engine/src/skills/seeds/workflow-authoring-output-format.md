---
slug: workflow-authoring-output-format
scope: global
title: Workflow Output Format Fidelity
description: When the goal names an output format (markdown table, CSV, bulleted list, HTML, Slack message), render that format as the final output string instead of returning the rows behind it.
activates_when: [{"kind":"intent_keyword","word":"markdown"},{"kind":"intent_keyword","word":"csv"},{"kind":"intent_keyword","word":"tabelle"},{"kind":"intent_keyword","word":"as a table"},{"kind":"intent_keyword","word":"bulleted"},{"kind":"intent_keyword","word":"bullet list"},{"kind":"intent_keyword","word":"aufzählung"},{"kind":"intent_keyword","word":"html"},{"kind":"intent_keyword","word":"slack message"},{"kind":"intent_keyword","word":"slack-nachricht"},{"kind":"intent_keyword","word":"output format"},{"kind":"intent_keyword","word":"ausgabeformat"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, output]
audience: [authoring]
version: 1
---

# Workflow Output Format Fidelity

## Output format fidelity — emit the format the goal names, as a string

When the goal names a concrete output FORMAT — "a markdown table", "CSV",
"a bulleted list", "an HTML email body", "a slack message" — the final
payload (`output_transform_function`, or the last transform that feeds it)
MUST RENDER that format as a STRING. The correct data returned as a JSON
array/object does NOT satisfy "return a markdown table": the caller asked for
the table, not the rows behind it. This is a real miss — a single-shot build
can compute a correct ranking yet hand back structured data, and a reader
expecting markdown gets none.

Render the format explicitly in JS. A markdown table from an array of rows:

```json
{
  "id": "render_table",
  "kind": "transform",
  "language": "javascript",
  "expression": "const rows = input.scope.rank_cities.data; const head = '| rank | city | warmest_day | max_temp_c |\\n| ---: | --- | --- | ---: |'; const body = rows.map((r, i) => `| ${i + 1} | ${r.city} | ${r.warmest_day} | ${r.max_temp_c} |`).join('\\n'); return head + '\\n' + body;"
}
```

The rule generalizes: CSV → a header line + `\n`-joined comma rows; a bulleted
list → `lines.map(l => '- ' + l).join('\\n')`; HTML → the actual tag string.
The deterministic shape (a header, a separator row for markdown tables, one
row per record) is what a downstream reader — and the preview judge — checks
for. When the goal is format-specific, treat the rendered string as the
output contract, not an afterthought.
