# Cockpit PWA: mehrere Installationen pro Nutzer und Mandant

Status: Implementierungsvorbereitung zu [Issue #414](https://github.com/MikeBild/subkit/issues/414). **Noch keine installierbare oder isolierte PWA implementiert.** Das Design ist vor Codeänderungen mit der bestehenden Auth-/Session-Architektur und den Browsergrenzen abzugleichen.

## Produktziel

Eine angemeldete Person kann **mehrere eigenständig benannte Cockpit-PWAs** installieren, auch mehrere Installationen für unterschiedliche Mandanten desselben SubKit-Hosts. Das Öffnen einer Installation führt ausschließlich in den bei der Installation gewählten Mandanten. Eine bestehende andere PWA darf weder stillschweigend ihren Mandanten wechseln noch fremde Daten anzeigen. Der installierte Eintrag ist eine **Verknüpfung**, keine neue Identität oder zusätzliche Berechtigung.

## Befund auf main bei Entwurf

- Vite-Cockpit hat Basis `/cockpit/` (`apps/cockpit/vite.config.ts`); `apps/cockpit/index.html` besitzt Icon, aber kein PWA-Manifest.
- `apps/cockpit/src/app/session.tsx` liest die Server-Bootstrap-Identität und setzt bei Mandantenwechsel `changed`.
- `apps/cockpit/src/components/cockpit/workspace-switcher.tsx` verwendet `switchMembership`, Broadcast und anschließenden Reload; der derzeitige Browser-/Cookie-Kontext ist geteilt.
- Die App darf den Mandanten niemals aus unvalidiertem URL-/Manifest-/Storage-Text als wirksame Berechtigung annehmen.

## Architekturvertrag

1. **Installationsidentität:** Ein serverseitig erzeugter, opaker und nicht geheimer Installationsbezeichner verweist auf den vom angemeldeten Nutzer ausgewählten Mandanten. Manifest-`id` und `start_url` sollen sich pro Installation unterscheiden; `name`/`short_name` kennzeichnen den Mandanten verständlich. Für wiederholte Installation desselben Mandanten die erwünschte Duplikatpolitik ausdrücklich entscheiden (pro Mandant ein Eintrag oder mehrere benannte Einträge).
2. **Berechtigungsprüfung:** Ein Installationsbezeichner vermittelt **keinen** Zugriff. Jede Anfrage und jede Session werden serverseitig gegen eine aktive Mitgliedschaft und die bestehenden Rollen/Scopes geprüft. Ein entfernter oder gesperrter Mandant zeigt eine sichere Fehler-/Auswahlseite, keine automatische Fremdzuordnung.
3. **Getrennte Mandantenkontexte:** Wenn verschiedene Installationen auf demselben Origin dieselben Cookies teilen, ist eine rein URL-basierte `tenant_id`-Markierung **keine Isolation**. Auth-/Session-Owner sollen eine serverseitig begrenzte Installationskontext-Bindung oder eine äquivalente überprüfbare Alternative ausarbeiten; die bestehende Cookie-Sitzung darf nicht beim Wechsel in PWA A unbemerkt PWA B umschalten. Keine Auth-Tokens in Manifest, URL, lokalem Storage oder Service-Worker-Cache.
4. **Browsergrenzen nachweisen:** Installierbarkeit und getrennte App-Identitäten auf unterstützten Browsern testen (insbesondere Chrome/Edge Desktop, Safari/macOS nach unterstütztem Verhalten). Unterschiedliche Manifest-IDs garantieren nicht in jedem Browser voneinander unabhängige Cookie-Jars. Wenn echte gleichzeitige Isolation innerhalb eines Origins nicht erreichbar ist, diese Beschränkung zeigen und die UX entsprechend gestalten statt Isolierung zu behaupten.
5. **Navigation:** `start_url`, Manifest-Auslieferung und `scope` auf das bestehende Cockpit-Routing abstimmen; jeder Deep Link erhält den Installationskontext. Abmeldung, Sessionablauf, Mitgliedschaftswechsel, expliziter Ausstieg aus dem fest gebundenen Mandanten und neue Logins sind definiert. Nicht installierte Browser-Tabs behalten das gewohnte Wechselverhalten.
6. **Sicherheit und Cache:** Manifest-API darf Mandantennamen nur gegenüber Berechtigten ausgeben und braucht passende `Cache-Control`-/Auth-Regeln; keine privaten API-Antworten offline cachen. Service Worker nur bei belegtem Bedarf, mit strengem Cache-Scope, Versionswechsel und Löschstrategie. HTTPS-Voraussetzung, CSP, Icon- und Manifest-Content-Type prüfen.
7. **UI-/Designhoheit:** Der Installationsdialog wird nach dem bestehenden Cockpit-Muster und einer konkret geprüften Lovable-Vorlage gebaut (siehe `AGENTS.md`). Kein eigenständig gestalteter neuer Screen.

## Vorgeschlagene Lieferung in kleinen PRs

- **A – Vertrag und Tests:** Installations-/Tenant-Modell und Browsermachbarkeit; reproduzierbare Sicherheits- und Isolationskontrakte. Keine produktive Session-Änderung ohne nachgewiesene Sicherheit.
- **B – Backend:** tenant-gebundenes Manifest und sicheres Session-/Installationskontext-Binding; alte normale Cockpit-Sitzungen bleiben kompatibel.
- **C – Cockpit:** Installationsaktion, klarer Mandantenname, Installationshilfe, `beforeinstallprompt` nur wo vorhanden, iOS/macOS-Hinweise nur wo passend, Session-/Error-/Revocation-UX.
- **D – Integration:** manueller Browser-Test mit **zwei Installationen A/B gleichzeitig**, unabhängigen Aktionen/Tabwechseln, Auth-Ablauf und Deinstallation; gezielte automatisierte Security-/Contract-/Buildtests gemäß Repo-Regeln.

## Definition of Done

- [ ] Zwei installierte PWAs A und B sind klar unterscheidbar und öffnen jeweils den gewählten Tenant.
- [ ] In parallelen Fenstern und bei Login/Logout/Tenantwechsel bleibt der Kontext entweder korrekt isoliert **oder wird sicher gesperrt**; niemals Fremddaten, silent switch oder Rechteausweitung.
- [ ] Entfernte Mitgliedschaft, ungültige Installation, abgelaufene Sitzung, Widerruf und Recovery verhalten sich deterministisch.
- [ ] API-Key-/MCP-Zugriffe bleiben unverändert und erhalten durch Installations-IDs keine zusätzlichen Rechte.
- [ ] Browserkompatibilität und PWA-Installationsbedingungen real nachgewiesen und Einschränkungen dokumentiert.
- [ ] Tests, CSP-/Cache-/Auth-Review und menschliche Sichtabnahme bestanden; kein bestehendes Approval-Gate geändert.

## Verweise

- [Issue #414](https://github.com/MikeBild/subkit/issues/414) — PWA.
- [Issue #377](https://github.com/MikeBild/subkit/issues/377) — Mandantenmodell.
- `AGENTS.md`, `apps/cockpit/index.html`, `apps/cockpit/vite.config.ts`, `apps/cockpit/src/app/session.tsx`, `apps/cockpit/src/components/cockpit/workspace-switcher.tsx`.

Nicht Teil dieses Drafts: produktives Deployment, Änderung des aktiven Sessionmodells, neue UI, Release, Self-hosted Beta-/Cloud-Go.