export const settingsAiEn = {
  "settings.costs.budget.mockNoCost": "In test mode there are no costs.",
  "settings.costs.currency.ownNeeded":
    "The built-in prices exist only in US dollars and are shown in dollars. With {currency} you enter your own price for each model.",
  "settings.costs.allowed.kept":
    "Unticked models stay saved with their limits and can be selected again at any time.",
  "settings.ai.provider.question": "Which AI provider do you use?",
  "settings.ai.provider.help":
    "The provider supplies the AI. It bills you for the use, not SubKit.",
  "settings.ai.provider.later": "You can switch at any time later.",
  "settings.ai.provider.selected": "Selected",
  "settings.ai.provider.openai": "OpenAI",
  "settings.ai.provider.openai.line": "The company behind ChatGPT. A good start for most people.",
  "settings.ai.provider.anthropic": "Anthropic",
  "settings.ai.provider.anthropic.line":
    "The company behind Claude. Strong with long texts and careful answers.",
  "settings.ai.provider.gemini": "Google Gemini",
  "settings.ai.provider.gemini.line": "Google's AI. Good if you already work with Google.",
  "settings.ai.provider.azure": "Azure OpenAI",
  "settings.ai.provider.azure.line":
    "OpenAI through Microsoft. For companies that book everything with Microsoft.",
  "settings.ai.provider.bedrock": "AWS Bedrock",
  "settings.ai.provider.bedrock.line":
    "Various AI models through Amazon. For companies with an Amazon account.",
  "settings.ai.provider.vertex": "Google Vertex",
  "settings.ai.provider.vertex.line":
    "Gemini through Google Cloud. For companies with a Google Cloud contract.",
  "settings.ai.provider.ai_gateway": "AI gateway",
  "settings.ai.provider.ai_gateway.line":
    "One collection point for many providers with one access. Usually your IT sets it up.",
  "settings.ai.provider.mock": "Test mode without real AI",
  "settings.ai.provider.mock.line":
    "Answers with sample texts and costs nothing. For trying out, not for real work.",
  "settings.ai.provider.mockHint":
    "In test mode every answer is made up. Workflows that need the AI then deliver no real results.",
  "settings.ai.provider.itHint":
    "For this provider you need a few details from your IT. We ask for them right below.",
  "settings.ai.azure.resource": "Resource name",
  "settings.ai.azure.resourceHelp": "Shown in the Azure portal at your OpenAI service.",
  "settings.ai.bedrock.region": "Data centre (region)",
  "settings.ai.bedrock.regionHelp": "For example “eu-central-1” for Frankfurt.",
  "settings.ai.vertex.project": "Project",
  "settings.ai.vertex.location": "Location",
  "settings.ai.vertex.help": "Both are shown in the Google Cloud console.",
  "settings.ai.model.question": "Which model should {provider} use?",
  "settings.ai.model.help":
    "A model is a version of the AI. Larger models are smarter, but slower and more expensive.",
  "settings.ai.model.label": "Model",
  "settings.ai.badge.recommended": "Recommended",
  "settings.ai.badge.economical": "Economical",
  "settings.ai.badge.capable": "Capable",
  "settings.ai.model.price": "about {amount} per 1M text pieces",
  "settings.ai.model.priceShort": "about {amount}",
  "settings.ai.model.priceDetail":
    "Reading: about {inPrice} · Writing: about {outPrice} per 1M text pieces. What the AI writes costs more than what it reads.",
  "settings.ai.model.priceUnknown": "No price stored",
  "settings.ai.model.priceSource": "Prices from the price list",
  "settings.ai.model.default": "Default model of {provider}",
  "settings.ai.model.defaultHelp":
    "{provider} chooses. If the provider changes its default model, it changes here too.",
  "settings.ai.model.custom": "Enter another model by name",
  "settings.ai.model.customPlaceholder": "e.g. gpt-4.1-mini",
  "settings.ai.tokens.what": "What are text pieces?",
  "settings.ai.tokens.explain":
    "AI providers do not bill by words but by text pieces (technical term: tokens). A piece is roughly three quarters of a word. 1 million pieces are about 750,000 words, around ten thick books. A normal chat answer needs only a few hundred.",
  "settings.ai.fallback.question": "What happens if {provider} fails?",
  "settings.ai.fallback.toggle": "Use a replacement provider",
  "settings.ai.fallback.off": "If {provider} fails, the step stops with an error message.",
  "settings.ai.fallback.on":
    "If {provider} fails or its quota is used up, the replacement takes over.",
  "settings.ai.fallback.provider": "Replacement provider",
  "settings.ai.fallback.hint": "The replacement needs its own access key with that provider.",
  "settings.ai.fallback.same":
    "Choose a provider other than {provider}. Otherwise the replacement fails at the same time.",
  "settings.ai.model.defaultNamed": "Default – {model}",
  "settings.ai.summarize.question": "Which AI summarises long conversations?",
  "settings.ai.summarize.help":
    "Summaries run in the background whenever a conversation gets long. A small, cheap model is usually enough.",
  "settings.ai.summarize.provider": "Provider for summaries",
  "settings.ai.summarize.primary": "Same as the main model ({provider})",
  "settings.ai.suggestion.question": "Which model suggests the next questions?",
  "settings.ai.suggestion.help":
    "After each reply, {provider} proposes follow-up questions. This runs often, so a cheap model keeps costs down.",
  "settings.ai.key.question": "Is the access key for {provider} stored?",
  "settings.ai.key.help":
    "SubKit signs in to {provider} with the key. You get it in your account at {provider}.",
  "settings.ai.key.where": "Where do I find the key?",
  "settings.ai.key.store": "Store key",
  "settings.ai.key.replace": "Replace key",
  "settings.ai.key.covered": "Not needed · the key for {provider} is already stored",
  "settings.ai.key.security":
    "SubKit stores the key encrypted and never shows it again. Do not type it into the chat and do not share it by e-mail.",
  "settings.ai.key.replaceNote":
    "After saving, only the new key applies. Best delete the old one at {provider} too.",
  "settings.ai.key.readOnly": "Stored (only administrators can replace it)",
  "settings.ai.key.mock": "In test mode you need no key.",
  "settings.ai.key.elsewhere":
    "This provider signs in with details from your IT. You find them under all settings of this area.",
  "settings.costs.budget.question": "How many text pieces may the AI use per month?",
  "settings.costs.budget.help":
    "Counted from the 1st of each month. The limit protects you from nasty surprises on the bill.",
  "settings.costs.preset.none": "No limit",
  "settings.costs.preset.1m": "1M",
  "settings.costs.preset.10m": "10M",
  "settings.costs.preset.100m": "100M",
  "settings.costs.preset.custom": "Own value",
  "settings.costs.budget.custom": "Text pieces per month",
  "settings.costs.budget.invalid": "Enter a number from 1, for example 500000.",
  "settings.costs.budget.noLimitHint":
    "Without a limit SubKit never stops because of costs. Then check the bill at {provider} regularly yourself.",
  "settings.costs.budget.reached":
    "Once the limit is reached, AI steps pause until the next month. Workflows without AI keep running.",
  "settings.costs.budget.estimate":
    "SubKit estimates the costs from the models' prices. The real bill comes from {provider}.",
  "settings.costs.budget.usage": "This month: about {spent} of {amount}",
  "settings.costs.budget.usageNoLimit": "This month: about {spent}",
  "settings.costs.tokens": "{count} text pieces",
  "settings.costs.hosted.question": "How much may hosted workspaces cost?",
  "settings.costs.hosted.help":
    "Applies to all workspaces we run for you. An amount above 0 is required: 0 $ blocks every paid AI call.",
  "settings.costs.hosted.tenant": "Per workspace and month",
  "settings.costs.hosted.global": "All workspaces together per month",
  "settings.costs.hosted.unit": "US dollars",
  "settings.costs.hosted.invalid": "Enter an amount in US dollars above 0, for example 50.",
  "settings.costs.prices.question": "What does each model cost?",
  "settings.costs.prices.help":
    "SubKit knows the prices of common models. If you negotiated another price, enter it here.",
  "settings.costs.prices.unit": "per 1M text pieces, values from the price list",
  "settings.costs.prices.model": "Model",
  "settings.costs.prices.read": "Reading",
  "settings.costs.prices.write": "Writing",
  "settings.costs.prices.origin": "Origin",
  "settings.costs.prices.builtin": "Built in",
  "settings.costs.prices.own": "Own price",
  "settings.costs.prices.add": "Enter own price",
  "settings.costs.prices.dialog": "Own price for a model",
  "settings.costs.prices.dialogHelp": "The price applies once you save the page.",
  "settings.costs.prices.empty": "No prices known in this currency yet.",
  "settings.costs.prices.invalid": "Enter a model name and both prices.",
  "settings.costs.currency.question": "Which currency do you work in?",
  "settings.costs.currency.help":
    "The built-in prices exist only in US dollars. If you choose euros, you enter all prices yourself.",
  "settings.costs.currency.usd": "US dollar ($)",
  "settings.costs.currency.eur": "Euro (€)",
  "settings.costs.currency.other": "Other ({currency})",
  "settings.costs.allowed.question": "Which models may workspaces use?",
  "settings.costs.allowed.help":
    "Only ticked models are offered in the workspaces. This keeps costs under control.",
  "settings.costs.allowed.count": "{count} of {total} models allowed",
  "settings.costs.allowed.all": "Select all",
  "settings.costs.allowed.none": "Select none",
  "settings.costs.allowed.empty": "No model allowed. The AI is blocked in all workspaces.",
  "settings.costs.allowed.more": "New models are added under all settings of this area.",
} as const;

export const settingsAiDe: Record<keyof typeof settingsAiEn, string> = {
  "settings.costs.budget.mockNoCost": "Im Testmodus entstehen keine Kosten.",
  "settings.costs.currency.ownNeeded":
    "Die eingebauten Preise gibt es nur in US-Dollar und sie stehen hier in Dollar. Mit {currency} trägst du für jedes Modell einen eigenen Preis ein.",
  "settings.costs.allowed.kept":
    "Abgewählte Modelle bleiben mit ihren Grenzen gespeichert und lassen sich jederzeit wieder auswählen.",
  "settings.ai.provider.question": "Welchen KI-Anbieter nutzt du?",
  "settings.ai.provider.help":
    "Der Anbieter liefert die KI. Er stellt dir die Nutzung in Rechnung, nicht SubKit.",
  "settings.ai.provider.later": "Du kannst später jederzeit wechseln.",
  "settings.ai.provider.selected": "Ausgewählt",
  "settings.ai.provider.openai": "OpenAI",
  "settings.ai.provider.openai.line": "Die Firma hinter ChatGPT. Ein guter Start für die meisten.",
  "settings.ai.provider.anthropic": "Anthropic",
  "settings.ai.provider.anthropic.line":
    "Die Firma hinter Claude. Stark bei langen Texten und sorgfältigen Antworten.",
  "settings.ai.provider.gemini": "Google Gemini",
  "settings.ai.provider.gemini.line": "Die KI von Google. Gut, wenn du schon mit Google arbeitest.",
  "settings.ai.provider.azure": "Azure OpenAI",
  "settings.ai.provider.azure.line":
    "OpenAI über Microsoft. Für Firmen, die alles bei Microsoft gebucht haben.",
  "settings.ai.provider.bedrock": "AWS Bedrock",
  "settings.ai.provider.bedrock.line":
    "Verschiedene KI-Modelle über Amazon. Für Firmen mit Amazon-Konto.",
  "settings.ai.provider.vertex": "Google Vertex",
  "settings.ai.provider.vertex.line":
    "Gemini über Google Cloud. Für Firmen mit Google-Cloud-Vertrag.",
  "settings.ai.provider.ai_gateway": "KI-Gateway",
  "settings.ai.provider.ai_gateway.line":
    "Eine Sammelstelle für viele Anbieter mit einem Zugang. Meist richtet sie deine IT ein.",
  "settings.ai.provider.mock": "Testmodus ohne echte KI",
  "settings.ai.provider.mock.line":
    "Antwortet mit Beispieltexten und kostet nichts. Zum Ausprobieren, nicht für echte Arbeit.",
  "settings.ai.provider.mockHint":
    "Im Testmodus sind alle Antworten erfunden. Workflows, die die KI brauchen, liefern dann keine echten Ergebnisse.",
  "settings.ai.provider.itHint":
    "Für diesen Anbieter brauchst du ein paar Angaben von deiner IT. Wir fragen sie gleich ab.",
  "settings.ai.azure.resource": "Name der Ressource",
  "settings.ai.azure.resourceHelp": "Steht im Azure-Portal bei deinem OpenAI-Dienst.",
  "settings.ai.bedrock.region": "Rechenzentrum (Region)",
  "settings.ai.bedrock.regionHelp": "Zum Beispiel „eu-central-1“ für Frankfurt.",
  "settings.ai.vertex.project": "Projekt",
  "settings.ai.vertex.location": "Standort",
  "settings.ai.vertex.help": "Beides steht in der Google-Cloud-Konsole.",
  "settings.ai.model.question": "Welches Modell soll {provider} verwenden?",
  "settings.ai.model.help":
    "Ein Modell ist eine Version der KI. Größere Modelle sind klüger, aber langsamer und teurer.",
  "settings.ai.model.label": "Modell",
  "settings.ai.badge.recommended": "Empfohlen",
  "settings.ai.badge.economical": "Günstig",
  "settings.ai.badge.capable": "Leistungsstark",
  "settings.ai.model.price": "ca. {amount} pro 1 Mio. Textbausteine",
  "settings.ai.model.priceShort": "ca. {amount}",
  "settings.ai.model.priceDetail":
    "Lesen: ca. {inPrice} · Schreiben: ca. {outPrice} je 1 Mio. Textbausteine. Was die KI schreibt, kostet mehr als das, was sie liest.",
  "settings.ai.model.priceUnknown": "Preis nicht hinterlegt",
  "settings.ai.model.priceSource": "Preise aus der Preisliste",
  "settings.ai.model.default": "Standardmodell von {provider}",
  "settings.ai.model.defaultHelp":
    "{provider} wählt selbst. Wechselt der Anbieter sein Standardmodell, wechselt es hier mit.",
  "settings.ai.model.custom": "Anderes Modell per Namen eingeben",
  "settings.ai.model.customPlaceholder": "z. B. gpt-4.1-mini",
  "settings.ai.tokens.what": "Was sind Textbausteine?",
  "settings.ai.tokens.explain":
    "KI-Anbieter rechnen nicht nach Wörtern ab, sondern nach Textbausteinen (Fachwort: Tokens). Ein Baustein ist ungefähr ein Dreiviertel-Wort. 1 Million Bausteine sind etwa 750.000 Wörter, also rund zehn dicke Bücher. Eine normale Chat-Antwort braucht nur wenige hundert.",
  "settings.ai.fallback.question": "Was passiert, falls {provider} ausfällt?",
  "settings.ai.fallback.toggle": "Ersatzanbieter verwenden",
  "settings.ai.fallback.off":
    "Fällt {provider} aus, bricht der Schritt mit einer Fehlermeldung ab.",
  "settings.ai.fallback.on":
    "Fällt {provider} aus oder ist das Kontingent dort aufgebraucht, übernimmt der Ersatz.",
  "settings.ai.fallback.provider": "Ersatzanbieter",
  "settings.ai.fallback.hint":
    "Für den Ersatz brauchst du einen eigenen Zugangsschlüssel bei diesem Anbieter.",
  "settings.ai.fallback.same":
    "Wähl einen anderen Anbieter als {provider}. Sonst fällt der Ersatz gleichzeitig mit aus.",
  "settings.ai.model.defaultNamed": "Standard – {model}",
  "settings.ai.summarize.question": "Welche KI fasst lange Gespräche zusammen?",
  "settings.ai.summarize.help":
    "Zusammenfassungen laufen im Hintergrund, sobald ein Gespräch lang wird. Meist genügt ein kleines, günstiges Modell.",
  "settings.ai.summarize.provider": "Anbieter für Zusammenfassungen",
  "settings.ai.summarize.primary": "Wie Hauptmodell ({provider})",
  "settings.ai.suggestion.question": "Welches Modell schlägt die nächsten Fragen vor?",
  "settings.ai.suggestion.help":
    "Nach jeder Antwort schlägt {provider} passende Anschlussfragen vor. Das läuft oft; ein günstiges Modell hält die Kosten niedrig.",
  "settings.ai.key.question": "Ist der Zugangsschlüssel für {provider} hinterlegt?",
  "settings.ai.key.help":
    "Mit dem Schlüssel meldet sich SubKit bei {provider} an. Du bekommst ihn in deinem Konto bei {provider}.",
  "settings.ai.key.where": "Wo finde ich den Schlüssel?",
  "settings.ai.key.store": "Schlüssel hinterlegen",
  "settings.ai.key.replace": "Schlüssel ersetzen",
  "settings.ai.key.covered": "Nicht nötig · Schlüssel bei {provider} ist schon hinterlegt",
  "settings.ai.key.security":
    "SubKit speichert den Schlüssel verschlüsselt und zeigt ihn nie wieder an. Gib ihn nicht in den Chat ein und teil ihn nicht per E-Mail.",
  "settings.ai.key.replaceNote":
    "Nach dem Speichern gilt nur noch der neue Schlüssel. Den alten löschst du am besten auch bei {provider}.",
  "settings.ai.key.readOnly": "Hinterlegt (nur Administratoren können ihn ersetzen)",
  "settings.ai.key.mock": "Im Testmodus brauchst du keinen Schlüssel.",
  "settings.ai.key.elsewhere":
    "Dieser Anbieter meldet sich mit Angaben deiner IT an. Du findest sie unter allen Einstellungen dieses Bereichs.",
  "settings.costs.budget.question": "Wie viele Textbausteine darf die KI pro Monat verbrauchen?",
  "settings.costs.budget.help":
    "Gezählt wird ab dem 1. jedes Monats. Das Limit schützt vor bösen Überraschungen auf der Rechnung.",
  "settings.costs.preset.none": "Kein Limit",
  "settings.costs.preset.1m": "1 Mio.",
  "settings.costs.preset.10m": "10 Mio.",
  "settings.costs.preset.100m": "100 Mio.",
  "settings.costs.preset.custom": "Eigener Wert",
  "settings.costs.budget.custom": "Textbausteine pro Monat",
  "settings.costs.budget.invalid": "Gib eine Zahl ab 1 ein, zum Beispiel 500000.",
  "settings.costs.budget.noLimitHint":
    "Ohne Limit stoppt SubKit nie wegen der Kosten. Prüf die Rechnung bei {provider} dann regelmäßig selbst.",
  "settings.costs.budget.reached":
    "Ist das Limit erreicht, pausieren KI-Schritte bis zum nächsten Monat. Workflows ohne KI laufen weiter.",
  "settings.costs.budget.estimate":
    "Die Kosten schätzt SubKit aus den Preisen der Modelle. Die echte Rechnung kommt von {provider}.",
  "settings.costs.budget.usage": "Diesen Monat: ca. {spent} von {amount}",
  "settings.costs.budget.usageNoLimit": "Diesen Monat: ca. {spent}",
  "settings.costs.tokens": "{count} Textbausteine",
  "settings.costs.hosted.question": "Wie viel dürfen gehostete Arbeitsbereiche kosten?",
  "settings.costs.hosted.help":
    "Gilt für alle von uns betriebenen Arbeitsbereiche. Ein Betrag über 0 ist Pflicht: 0 $ sperrt jeden kostenpflichtigen KI-Aufruf.",
  "settings.costs.hosted.tenant": "Je Arbeitsbereich pro Monat",
  "settings.costs.hosted.global": "Alle Arbeitsbereiche zusammen pro Monat",
  "settings.costs.hosted.unit": "US-Dollar",
  "settings.costs.hosted.invalid": "Gib einen Betrag in US-Dollar über 0 ein, zum Beispiel 50.",
  "settings.costs.prices.question": "Was kostet welches Modell?",
  "settings.costs.prices.help":
    "SubKit kennt die Preise der gängigen Modelle. Hast du einen anderen Preis ausgehandelt, trag ihn hier ein.",
  "settings.costs.prices.unit": "je 1 Mio. Textbausteine, Werte aus der Preisliste",
  "settings.costs.prices.model": "Modell",
  "settings.costs.prices.read": "Lesen",
  "settings.costs.prices.write": "Schreiben",
  "settings.costs.prices.origin": "Herkunft",
  "settings.costs.prices.builtin": "Eingebaut",
  "settings.costs.prices.own": "Eigener Preis",
  "settings.costs.prices.add": "Eigenen Preis eintragen",
  "settings.costs.prices.dialog": "Eigener Preis für ein Modell",
  "settings.costs.prices.dialogHelp": "Der Preis gilt, sobald du die Seite speicherst.",
  "settings.costs.prices.empty": "In dieser Währung sind noch keine Preise bekannt.",
  "settings.costs.prices.invalid": "Gib einen Modellnamen und beide Preise ein.",
  "settings.costs.currency.question": "In welcher Währung rechnest du?",
  "settings.costs.currency.help":
    "Die eingebauten Preise gibt es nur in US-Dollar. Wählst du Euro, trägst du alle Preise selbst ein.",
  "settings.costs.currency.usd": "US-Dollar ($)",
  "settings.costs.currency.eur": "Euro (€)",
  "settings.costs.currency.other": "Andere ({currency})",
  "settings.costs.allowed.question": "Welche Modelle dürfen Arbeitsbereiche nutzen?",
  "settings.costs.allowed.help":
    "Nur angehakte Modelle stehen in den Arbeitsbereichen zur Auswahl. Damit hältst du Kosten im Griff.",
  "settings.costs.allowed.count": "{count} von {total} Modellen erlaubt",
  "settings.costs.allowed.all": "Alle auswählen",
  "settings.costs.allowed.none": "Keine auswählen",
  "settings.costs.allowed.empty":
    "Kein Modell erlaubt. Die KI ist in allen Arbeitsbereichen gesperrt.",
  "settings.costs.allowed.more":
    "Neue Modelle nimmst du unter allen Einstellungen dieses Bereichs auf.",
};
