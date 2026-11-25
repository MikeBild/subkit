---
slug: connectors
title: Connector- und Rezeptkatalog
summary: Finde die Connector-Vorlagen und Rezepte, die SubKit mitbringt.
section: reference
order: 3
audience: public
---
Eine Connector-Vorlage verbindet ein System: Adresse, Anmeldung, Endpunkte und ein Grundlagen-Skill des Anbieters. Viele Vorlagen bringen Rezepte mit, also fertige Workflows, die du klonst, statt bei null anzufangen. Sagst du im Chat, was du brauchst, nimmt SubKit das passende Rezept als ersten Entwurf. Ein System ohne Vorlage verbindest du aus der Beschreibung seiner Schnittstelle.

Manche Rezepte fragen beim Installieren nach einem Wert, etwa nach einer GA4-Property-ID oder bei den Web-Scraper-Rezepten nach `allowed_hosts`: den Hostnamen, auf die ihre Adresse zeigen darf. SubKit schreibt diese Werte vor deiner Freigabe in die Schritte, deshalb nennt die Freigabe sie. Ein Web-Scraper-Lauf ruft danach nur https-Adressen auf genau diesen Hosts ab und bricht bei jeder anderen Adresse mit `request_host_not_allowed` ab.

Der Katalog unten wird aus den Connector-Vorlagen erzeugt und ist deshalb auf Englisch.
