# SubKit Cockpit design system

Keep the existing calm, high-contrast operational UI: white/light surfaces, slate text, blue actions, subtle borders and semantic green/amber/red status. Preserve the SubKit wordmark and Lucide icon family. Avoid decorative gradients or oversized hero treatments.

## Responsive composition
- The persistent sidebar defines the usable page width. Data-heavy lists and overview dashboards should expand and center within the remaining canvas with a generous max width (target 1600–1760 CSS px at ultra-wide viewports).
- Keep prose and reading content at a readable measure; use contextual side panels only when they contain relevant content.
- Chat centers its transcript and composer in a responsive reading column capped at 80rem; assistant messages may grow from 72ch to 88ch on ultra-wide screens. Calculate inspector eligibility from the width left after the conversation list, and dock only when the transcript/composer retains at least 680px. Scale the inspector between 320px and 640px as space allows. Show it only for an active conversation; a saved wide-layout open choice must not produce an empty panel. A close/open choice is scoped to the narrow or wide layout where it was made, so a narrow-screen close does not suppress the wide inspector default. The context toggle exposes `aria-controls` only while its target exists.
- Tables allocate control/action columns explicitly, constrain long status badges to their cells while retaining the full accessible label, and switch to compact cards before controls become cramped. Never permit overlapping controls or text.
- In chat, keep the conversation list above the transcript until the workspace can fit its fixed 264px list and 680px transcript; then reserve the list width before sizing the transcript and optional inspector.
- Settings use a balanced navigation/form layout, with descriptions and controls aligned in a responsive two-column grid.

## Density
Use space to strengthen hierarchy and scanability: responsive KPI grids, aligned collection headers, sensible row spacing, and clear action ownership. Do not stretch paragraphs or add empty decorative cards to fill width.

## Status language
- A status label describes the state, not an inferred cause or frequency. Use “Eingeschränkt” / “Limited” for `degraded`; reserve repeated-failure language for a state that explicitly measures repeated failures.
- The same state uses the same visible label and semantic tone wherever it appears. A surface may add context to an accessible name, but must not change the state wording.
- Use the shared `StatusBadge` for status shape, dot, and semantic color. Keep green for healthy/success, amber for limited or attention-needed, red for failed/critical, and neutral for inactive or unknown.

## Current visual foundations
See `.superdesign/init/theme.md` for actual color tokens, type styles and raw CSS; `.superdesign/init/layouts.md` and `components.md` preserve shared implementations.
