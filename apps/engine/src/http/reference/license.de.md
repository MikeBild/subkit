---
slug: license
summary: Erfahre, unter welcher Lizenz du SubKit nutzen und weitergeben darfst.
section: reference
order: 4
audience: public
---
## Lizenz

Apache License 2.0 (`Apache-2.0`). Den vollständigen Text findest du in der Datei `LICENSE` jedes Release.


## Drittanbieter-Komponenten

Jedes Release liefert `THIRD_PARTY_NOTICES.txt` neben den Binaries aus. Die Datei enthält die
Lizenztexte aller gebündelten Pakete, des eingebetteten Embedding-Modells und der Bun-Runtime.

- **Embedding-Modell:** `paraphrase-multilingual-MiniLM-L12-v2` von sentence-transformers,
  Apache-2.0 laut Hugging-Face-Model-Card; ONNX-Konvertierung von Xenova.
- **Bun-Runtime:** Die Programme `engine` und `sk` enthalten die Bun-Runtime. Sie bindet
  LGPL-Komponenten statisch ein (JavaScriptCore/WebKit, tinycc). Der Abschnitt „Relinking and
  corresponding source“ in `THIRD_PARTY_NOTICES.txt` beschreibt Neubau und Relinking.
- **Container-Image:** In `/usr/local/share/subkit/` liegen zusätzlich `BASE_IMAGE_INVENTORY.txt`
  (Betriebssystempakete des Basis-Images; das Image enthält keinen Browser) und `SOURCE_OFFER.txt`.

Den Quellcode der GPL- und LGPL-Komponenten erhältst du auf Anfrage für mindestens drei Jahre
(schriftliches Angebot in den Notices). Anfragen gehen über das [Kontaktformular](https://subkit.mikebild.dev/kontakt). Sobald das SubKit-Repository öffentlich ist, wird er
zusätzlich dort verlinkt.
