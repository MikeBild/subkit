---
slug: product-identity-binding
summary: Verknüpfe Nutzer deiner App mit einem SubKit-Konto, das nur wenig darf.
section: operate
order: 5
audience: operator
---
## Produkt-Identitätsbindung

Mit einer Identitätsbindung landet ein Nutzer deiner App, der sich über deinen eigenen Anmeldedienst anmeldet, in SubKit bei genau einem vorbereiteten Konto. Du brauchst das, wenn eine App oder ein Kundenportal ausgewählte Workflows starten soll, ohne dass ihre Nutzer volle SubKit-Konten bekommen. Danach ist jede Anmeldung an ein Konto mit minimalen Rechten gebunden, und neue Konten entstehen nicht von selbst.

Drei Begriffe vorab. Ein Produkt ist eine eigene App oder ein Dienst, den du in SubKit mit `product_id` kennzeichnest. OIDC (OpenID Connect) ist ein Standard, mit dem ein externer Anmeldedienst, der Aussteller, bestätigt, wer sich angemeldet hat. Das Subject ist die feste Nutzerkennung, die dieser Aussteller liefert.

### Konto vorbereiten

Für einen OIDC-Anbieter mit `product_id` bereitest du als Betreiber zuerst das Konto vor:

1. Lege im Mandanten (im Cockpit: Arbeitsbereich) einen aktiven Benutzer an.
2. Gib ihm eine eigene Rolle mit minimalen Rechten.
3. Erlaube ihm nur die vorgesehenen gespeicherten Workflows.

Nimm dafür keine eingebaute Mitgliedsrolle. Sie erlaubt die Ausführung von deutlich mehr Workflows.

### Subject binden

Binde das geprüfte Subject des Ausstellers an diesen Benutzer:

```http
POST /v1/identity/users/{id}/provider-identities

{"provider_id":"<provider-id>","subject":"<verified-subject>"}
```

Dafür brauchst du die Administrator-Policy und `identity:write`. Mandant, Aussteller und Produkt kommen aus der Konfiguration des Anbieters. Eine exakt wiederholte Anfrage ändert nichts. Widerspricht sie einer bestehenden Bindung bei Eigentümer, Subject, Aussteller oder Produkt, lehnt SubKit sie ab. Rollen und Rechtezuweisungen ändert der Endpunkt nicht.

### Was bei der Anmeldung gilt

Produkt-Anbieter verlangen diese Bindung. Sie legen keine Konten an und verknüpfen keine über die E-Mail-Adresse, auch wenn die Registrierung global eingeschaltet ist. Bei älteren Produktbindungen muss ein Betreiber vor der Anmeldung denselben Eigentümer und dasselbe Subject festschreiben.

Anbieter ohne Produktbindung verknüpfen standardmäßig über die E-Mail-Adresse; `link_by_email: false` schaltet das ab. Ältere Bindungen ohne Produkt schreiben bei ihrer ersten geprüften Anmeldung den konfigurierten Aussteller fest. Welcher Aussteller früher galt, lässt sich damit nicht belegen.

Festschreibungen werden bei neuen Anmeldungen geprüft. Änderst du die Konfiguration des Anbieters, bleiben bestehende Browsersitzungen gültig. Widerrufe sie gesondert oder lass ihre konfigurierte Lebensdauer ablaufen.
