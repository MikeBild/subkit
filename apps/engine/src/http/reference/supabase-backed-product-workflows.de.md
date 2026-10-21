---
slug: supabase-backed-product-workflows
summary: Führe Produkt-Workflows mit dem supabase-Konnektor gegen dein Supabase-Projekt aus.
section: operate
order: 7
audience: operator
---
## Produkt-Workflows mit Supabase

Dieser Abschnitt behandelt nur den `supabase`-Konnektor; er hängt nicht davon ab, welcher
Identitätsanbieter die Benutzer der App anmeldet. Verwende Supabase über den
`supabase`-Konnektor und gewöhnliche Workflow-Erstellung; Workflows benötigen weder direkten
PostgreSQL-Zugriff noch SQL-Schritte. Speichere erforderliche Gateway-Header als
verschlüsselte Konnektor-Zugangsdaten. `apikey` ist der öffentliche Projektschlüssel;
`Authorization` trägt das JWT für die vorgesehene Datenbankrolle. Eine mandantenweite
Konnektor-Zugangsdatei kann nicht einzelne mobile Benutzer abbilden; übergib das JWT eines
App-Benutzers nie als Workflow-Eingabe. Verwende eine Owner-Binding-RPC, die das unveränderliche
`$caller` abbildet, wenn ein Workflow benutzereigene Daten benötigt. Eine geschützte
Server-zu-Server-RPC kann zusätzlich `x-subkit-token` verlangen, das nur am Konnektor gespeichert
wird. Es authentifiziert SubKit gegenüber dem Produkt-Backend; es ist nicht die Identität des
Endbenutzers und ersetzt nie das unveränderliche `$caller` des Workflows. Lege Zugangsdaten
nie in App-Code, Workflow-Eingaben oder -Schritten, Client-Kontext, generiertem Workflow-Quelltext
oder Logs ab. Verwende `service_role` nicht für aufruferbezogenen Zugriff, da es RLS umgeht.
Binde Produkt-Workflows an ihr Produkt und die erforderliche Aufruferart, leite
Eigentümerkennungen aus `$caller` ab und schlage geschlossen fehl, wenn eine atomare
Autorisierung oder Kontingentreservierung den nächsten Schritt nicht ausdrücklich erlaubt.
