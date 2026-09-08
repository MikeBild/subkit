# Changing something that is shared

This file is byte-identical in WorkKit, CodeKit, SubKit, ContentKit, WikiKit
and WatchKit. Shared text and token bytes travel together; product code,
configuration, identities, databases and deployments stay independent.

## Shared rules and local evidence

The common files in `contract/` are compared byte for byte.
`conformance.*` files are deliberately local: they record local tests,
stricter requirements, deviations and historical evidence. They must never
claim another product's verification.

`BOUNDED-AUTONOMY.md` owns authority semantics, localization and defaults.
`COCKPIT-UI.md` owns presentation rules; `cockpit-ui.css` owns token bytes.
Neither a matching digest nor a shared status label grants runtime authority.

## Change one coherent boundary

1. Inspect the affected rules and each product's local conformance record.
2. Make the smallest common change. Preserve stricter local rules explicitly.
3. Carry identical shared bytes to all six checkouts.
4. For token changes, update the originating design-system values, copy the
   sentinel regions into each product's own CSS, and update its local TypeScript
   token representation where present. Regenerate the token digest and ledger.
5. Rebuild affected Cockpits with their repository-owned command. Regenerate
   embedded assets and documentation with each product's own generators.
6. Run all affected local contract, accessibility, locale and browser checks,
   followed by the full repository gate.
7. Compare every sibling checkout before calling the portfolio verified.
   A missing checkout or a skipped comparison is not verification.
8. Record exact commits and verification evidence for every product.

Product-specific build commands and test names live in each repository's
`AGENTS.md`, package scripts and conformance records, not in a copied command
that silently invokes the wrong product's build.

## Auth surfaces

When changing shared authentication styles, update every participating local
implementation and its local digest assertion. The rendered marker must be
derived from actual bytes. A hand-written version number is not evidence of
matching styles. Approval callbacks still authenticate locally and enforce
their own CSRF, tenant, role and bound-decision checks.

## Verification

From a checkout containing the comparison script, run:

```sh
node scripts/verify-family-contracts.mjs --sibling ../workkit
node scripts/verify-family-contracts.mjs --sibling ../codekit
node scripts/verify-family-contracts.mjs --sibling ../subkit
node scripts/verify-family-contracts.mjs --sibling ../contentkit
node scripts/verify-family-contracts.mjs --sibling ../wikikit
node scripts/verify-family-contracts.mjs --sibling ../watchkit
```

The self-comparison is harmless but proves no sibling. All five foreign
checkouts must exist and their comparisons must succeed. Repository-local
checks remain runnable without sibling checkouts; the portfolio comparison is
an additional development-time gate, not a shared runtime dependency.

## Git and release boundaries

Follow the operator-approved Git workflow and repository protections. For the
bounded-autonomy implementation, use small green commits directly on the six
`main` branches, without PRs, force pushes or destructive resets. Keep user
changes intact. Collect commits locally until the whole portfolio is verified;
then recheck remote heads, integrate compatible changes, reverify affected
products and push normally.

Six repositories cannot be committed or pushed atomically. Report each actual
push result; a partial push is not portfolio completion. Code publication never
implies authority to deploy to production.
