---
slug: supabase-backed-product-workflows
summary: Nutze Daten deines Supabase-Projekts in Produkt-Workflows, ohne Schlüssel preiszugeben.
section: operate
order: 7
audience: operator
---
## Produkt-Workflows mit Supabase

Mit dem `supabase`-Connector greifen deine Produkt-Workflows auf dein Supabase-Projekt zu, ohne direkten PostgreSQL-Zugang und ohne SQL-Schritte. Du brauchst das, wenn eine App über SubKit Daten ihrer Nutzer lesen oder ändern soll. Danach liegen alle Schlüssel verschlüsselt am Connector, und nutzereigene Daten erreichst du über den geprüften Aufrufer statt über ein mitgeschicktes Nutzer-Token.

Dieser Abschnitt behandelt nur den `supabase`-Connector. Welcher Identitätsanbieter die Nutzer der App anmeldet, spielt dafür keine Rolle. Workflows baust du wie gewohnt.

### Zugangsdaten am Connector

Speichere die nötigen Gateway-Header als verschlüsselte Zugangsdaten am Connector:

- `apikey` ist der öffentliche Projektschlüssel.
- `Authorization` trägt das JWT (ein signiertes Token) für die vorgesehene Datenbankrolle.
- `x-subkit-token` kann eine geschützte Server-zu-Server-RPC zusätzlich verlangen. Es liegt nur am Connector und weist SubKit gegenüber deinem Produkt-Backend aus. Es ist nicht die Identität des Endnutzers und ersetzt nie das unveränderliche `$caller` des Workflows.

Verwende `service_role` nicht für Zugriffe im Namen eines Aufrufers: Diese Rolle umgeht RLS, die zeilenweisen Zugriffsregeln der Datenbank. Zugangsdaten gehören nie in App-Code, Workflow-Eingaben oder -Schritte, Client-Kontext, generierten Workflow-Quelltext oder Logs.

### Daten einzelner Nutzer

Ein Zugangsdatum am Connector gilt für den ganzen Mandanten (im Cockpit: Arbeitsbereich) und kann keine einzelnen mobilen Nutzer abbilden. Übergib das JWT eines App-Nutzers deshalb nie als Workflow-Eingabe. Braucht ein Workflow nutzereigene Daten, nimm eine RPC, also eine Datenbankfunktion hinter einem Endpunkt, die den Eigentümer aus dem unveränderlichen `$caller` ableitet.

Binde Produkt-Workflows an ihr Produkt und die erforderliche Aufruferart. Leite Eigentümerkennungen aus `$caller` ab. Erlaubt eine atomare Rechteprüfung oder Kontingent-Reservierung den nächsten Schritt nicht ausdrücklich, muss der Workflow mit einem Fehler abbrechen, statt weiterzulaufen.
