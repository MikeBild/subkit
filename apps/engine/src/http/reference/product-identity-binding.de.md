---
slug: product-identity-binding
summary: Binde die angemeldeten Benutzer deines Produkts an eine minimale SubKit-Identität.
section: operate
order: 5
audience: operator
---
## Produkt-Identitätsbindung

Für einen mit `product_id` konfigurierten OIDC-Anbieter legt ein Betreiber zuerst einen aktiven
Mandantenbenutzer an, weist eine minimale benutzerdefinierte Rolle zu und gewährt nur die
vorgesehenen gespeicherten Workflows. Eingebaute Mitgliedsrollen erlauben eine breitere
Workflow-Ausführung.

Binde dessen verifiziertes Aussteller-Subject mit
`POST /v1/identity/users/{id}/provider-identities` und dem JSON
`{"provider_id":"<provider-id>","subject":"<verified-subject>"}`. Das erfordert Administrator-Policy
und `identity:write`. Mandant, Aussteller und Produkt stammen aus der Anbieterkonfiguration. Exakte
Wiederholungen sind idempotent; Konflikte bei Eigentümer, Subject, Aussteller oder Produkt werden
abgelehnt. Der Endpunkt ändert weder Rollen noch Grants.

Produktanbieter erfordern diese Bindung und deaktivieren Kontoerstellung und E-Mail-Verknüpfung,
auch wenn die Registrierung global aktiviert ist. Ältere Produktbindungen erfordern, dass ein
Betreiber vor der Anmeldung denselben Eigentümer und dasselbe Subject festschreibt. Ungebundene
Anbieter behalten die E-Mail-Verknüpfung standardmäßig; setze `link_by_email: false`, um sie
zu deaktivieren. Ältere ungebundene Bindungen schreiben den konfigurierten Aussteller bei ihrer
ersten verifizierten Anmeldung fest; das kann keine historische Herkunft des Ausstellers belegen.

Festschreibungen werden bei neuen Anmeldungen geprüft. Das Ändern der Anbieterkonfiguration
widerruft bestehende Browsersitzungen nicht; widerrufe diese separat oder lass ihre
konfigurierte Lebensdauer ablaufen.
