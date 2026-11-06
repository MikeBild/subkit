export const settingsHelpEn = {
  "settings.help.server.hosted_rate_limit.tenant_per_month":
    "Monthly request allowance for each hosted workspace. A zero value blocks requests.",
  "settings.help.server.hosted_rate_limit.principal_per_minute":
    "Request ceiling per authenticated identity and workspace per minute; zero blocks requests.",
  "settings.help.server.hosted_rate_limit.peer_per_minute":
    "Ingress ceiling per verified connection peer per minute; zero blocks ingress.",
  "settings.help.server.hosted_rate_limit.tenant_per_minute":
    "Request ceiling per hosted workspace per minute; zero blocks requests.",
  "settings.help.server.hosted_rate_limit.global_per_minute":
    "Shared ingress ceiling across hosted workspaces per minute; zero blocks ingress.",
  "settings.help.server.trusted_proxy_hops":
    "Forwarding hops trusted from the right of X-Forwarded-For. Zero ignores forwarding headers.",
  "settings.help.server.trusted_proxy_ips":
    "Exact socket-peer IP addresses of trusted reverse proxies. Every configured hop must match.",
  "settings.help.database.pool_max":
    "Maximum application connections per pool and replica. Requires a restart.",
  "settings.help.database.connect_timeout_ms":
    "Deadline in milliseconds to acquire or establish a PostgreSQL connection. Requires a restart.",
  "settings.help.database.query_timeout_ms":
    "Client-side deadline for PostgreSQL queries in milliseconds. Requires a restart.",
  "settings.help.database.statement_timeout_ms":
    "Server-side statement deadline in milliseconds, applied on each session. Requires a restart.",
  "settings.help.database.idle_timeout_ms":
    "Milliseconds before an unused pooled connection closes. Requires a restart.",
  "settings.help.database.keepalive_delay_ms":
    "Initial TCP keepalive delay for database connections in milliseconds. Requires a restart.",
  "settings.help.llm.hosted.enabled":
    "Enable hosted paid-model mode, which requires a workspace context independently of signup policy.",
  "settings.help.llm.hosted.tenant_monthly_microunits":
    "Budget per workspace in millionths of a US dollar. Zero blocks paid model calls.",
  "settings.help.llm.hosted.global_monthly_microunits":
    "Shared hosted budget in millionths of a US dollar. Zero blocks paid model calls.",
  "settings.help.llm.hosted.models":
    "Exact provider and model allowlist with verified provider context limits and maximum USD rates, including long-context tiers. Paid native tools and multimodal inputs are unsupported.",
  "settings.help.auth.hosted.enabled":
    "Enable identity-first hosted browser authentication for explicitly selected providers. Requires a restart.",
  "settings.help.auth.hosted.registration_enabled":
    "Allow new identities to create a workspace. Existing memberships and reviewed invitations remain available while registration is closed.",
  "settings.help.auth.hosted.admission.tenant_creations_per_minute":
    "Global ceiling for new self-service workspaces per minute. Idempotent callbacks do not consume it.",
  "settings.help.auth.hosted.admission.retained_tenants":
    "Ceiling for retained workspace records, including erased ownership records. Zero blocks new workspaces.",
  "settings.help.auth.hosted.admission.mcp_clients_per_peer_per_minute":
    "Hosted dynamic MCP client registrations allowed per verified peer per minute.",
  "settings.help.auth.hosted.admission.mcp_clients_per_minute":
    "Global ceiling for hosted dynamic MCP client registrations per minute.",
  "settings.help.auth.hosted.admission.retained_mcp_clients":
    "Ceiling for retained MCP clients, including retired and disabled registrations. Zero blocks new clients.",
  "settings.help.storage.hosted.tenant_bytes":
    "Shared logical byte quota for files, reservations and retained content, including copies and revisions. This is not a physical disk quota.",
  "settings.help.storage.hosted.retained_rows_per_resource":
    "Retained row ceiling per resource table, including histories and soft-deleted rows. Zero blocks creation.",
  "settings.help.storage.hosted.max_file_bytes":
    "Maximum declared bytes for each new hosted file. Zero blocks file admission.",
  "settings.help.queue.hosted.execution_concurrency":
    "Ceiling for simultaneous root runs per hosted workspace. Zero blocks work.",
  "settings.help.queue.hosted.chat_concurrency":
    "Ceiling for simultaneous chat steps per hosted workspace, including direct calls. Zero blocks work.",
  "settings.help.queue.hosted.pending_jobs":
    "Ceiling for queued run and conversation jobs per workspace. Zero blocks queue admission.",
  "settings.help.auth.enable_signup":
    "Creates a member account for someone signing in by SSO for the first time. Off: only people who already have an account get in.",
  "settings.help.auth.mcp_oauth.access_token_ttl_seconds":
    "How long a connected client's access stays valid before it renews it silently.",
  "settings.help.auth.mcp_oauth.authorization_code_ttl_seconds":
    "How long the one-time code of a sign-in stays valid. Rarely needs changing.",
  "settings.help.auth.mcp_oauth.dynamic_registration_enabled":
    "Lets such clients register themselves on first connect. Off: each client has to be registered by hand.",
  "settings.help.auth.mcp_oauth.enabled":
    "Lets AI clients such as ChatGPT, Claude or Cursor connect by signing in. Off: they need an API key.",
  "settings.help.auth.mcp_oauth.refresh_token_ttl_seconds":
    "How long a client stays connected without anyone signing in again.",
  "settings.help.auth.mcp_oauth.scopes_supported":
    "The permissions a client may ask for. metrics:read always stays in the list.",
  "settings.help.products":
    "Per product: the environment its signed-in users run in, and the assistant workflow whose daily limit the app shows.",
  "settings.help.auth.providers":
    "How people sign in to the cockpit. Keep at least one provider you can use yourself; removing the last one locks everybody out.",
  "settings.help.auth.session.secret":
    "Signs sign-in sessions. Generated on first start if empty; replacing it signs everybody out.",
  "settings.help.database.url":
    "Set only through the DATABASE_URL environment variable at startup. To change it, rotate the variable and restart every replica.",
  "settings.help.egress.mode":
    "Whether workflows may reach addresses inside your network: strict blocks private and local hosts, permissive allows them. Not set follows the environment.",
  "settings.help.errors.ring_size":
    "How many recent errors the engine keeps in memory for diagnosis. Read at startup.",
  "settings.help.llm.api_key":
    "Key for the primary provider. A key stored under the provider below takes the same role; one of the two is enough.",
  "settings.help.llm.context_1m":
    "Lets supported models read up to one million tokens per turn. Long turns then cost markedly more.",
  "settings.help.llm.reasoning_effort":
    "How much the model thinks before each authoring step. Default: deep thinking on Claude models only once a draft is validated, saved or being reworked. none, low, medium or high applies to every authoring stage on OpenAI reasoning models and supported Claude models; a forced tool call still turns thinking off on Claude. More effort costs more output tokens.",
  "settings.help.llm.critic.enabled":
    "Has a second model review every workflow draft after the automatic checks pass. Catches more mistakes and costs an extra call per draft.",
  "settings.help.llm.critic.max_consecutive_rejections":
    "After this many rejections in a row the review is skipped, so a draft cannot loop forever.",
  "settings.help.llm.critic.min_steps": "Drafts with fewer steps skip the review.",
  "settings.help.llm.fallback_model":
    "The model the fallback provider runs. Empty uses that provider's default model.",
  "settings.help.llm.fallback_provider":
    "Takes over when the primary provider fails or is out of quota. Not set means no fallback: a failure ends the turn.",
  "settings.help.llm.model":
    "The model the primary provider runs. Empty uses that provider's own default model.",
  "settings.help.llm.output_guard":
    "What happens when a reply trips the safety check: soft rewrites and logs, hard stops the reply, off skips the check. Never off in production.",
  "settings.help.llm.provider":
    "The AI provider every conversation and authoring step uses first. Its key must be stored under that provider below.",
  "settings.help.llm.providers.ai_gateway.api_key":
    "Key for the AI gateway. Needed only when the AI gateway is the primary, fallback or summary provider.",
  "settings.help.llm.providers.ai_gateway.model":
    "Model the AI gateway runs when it is chosen. Empty uses the model set above.",
  "settings.help.llm.providers.anthropic.api_key":
    "Key for Anthropic. Needed only when Anthropic is the primary, fallback or summary provider.",
  "settings.help.llm.providers.anthropic.base_url":
    "Only for a proxy or a private endpoint in front of Anthropic. Empty uses the provider's public address.",
  "settings.help.llm.providers.anthropic.model":
    "Model Anthropic runs when it is chosen. Empty uses the model set above.",
  "settings.help.llm.providers.azure.api_key":
    "Key for Azure OpenAI. Needed only when Azure OpenAI is the primary, fallback or summary provider.",
  "settings.help.llm.providers.azure.api_version":
    "The Azure OpenAI API version sent with each request. Empty uses the client's default.",
  "settings.help.llm.providers.azure.base_url":
    "Only for a proxy or a private endpoint in front of Azure OpenAI. Empty uses the provider's public address.",
  "settings.help.llm.providers.azure.model":
    "Model Azure OpenAI runs when it is chosen. Empty uses the model set above.",
  "settings.help.llm.providers.azure.resource_name":
    "Name of your Azure OpenAI resource; the endpoint address is built from it unless a base URL is set.",
  "settings.help.llm.providers.azure.use_deployment_based_urls":
    "Addresses the model through its deployment name in the URL, as older Azure deployments expect.",
  "settings.help.llm.providers.bedrock.access_key_id":
    "AWS access key ID with Bedrock permission. Stored together with the secret access key.",
  "settings.help.llm.providers.bedrock.base_url":
    "Only for a proxy or a private endpoint in front of Amazon Bedrock. Empty uses the provider's public address.",
  "settings.help.llm.providers.bedrock.model":
    "Model Amazon Bedrock runs when it is chosen. Empty uses the model set above.",
  "settings.help.llm.providers.bedrock.region":
    "AWS region the Bedrock models run in, for example eu-central-1.",
  "settings.help.llm.providers.bedrock.secret_access_key": "The secret half of the AWS access key.",
  "settings.help.llm.providers.bedrock.session_token":
    "Only for temporary AWS credentials; permanent keys need none.",
  "settings.help.llm.providers.gemini.api_key":
    "Key for Gemini. Needed only when Gemini is the primary, fallback or summary provider.",
  "settings.help.llm.providers.gemini.base_url":
    "Only for a proxy or a private endpoint in front of Gemini. Empty uses the provider's public address.",
  "settings.help.llm.providers.gemini.model":
    "Model Gemini runs when it is chosen. Empty uses the model set above.",
  "settings.help.llm.providers.openai.api_key":
    "Key for OpenAI. Needed only when OpenAI is the primary, fallback or summary provider.",
  "settings.help.llm.providers.openai.base_url":
    "Only for a proxy or a private endpoint in front of OpenAI. Empty uses the provider's public address.",
  "settings.help.llm.providers.openai.model":
    "Model OpenAI runs when it is chosen. Empty uses the model set above.",
  "settings.help.llm.providers.vertex.api_key":
    "Key for Google Vertex AI. Needed only when Google Vertex AI is the primary, fallback or summary provider.",
  "settings.help.llm.providers.vertex.client_email":
    "Service account email; together with its private key an alternative to an API key.",
  "settings.help.llm.providers.vertex.google_application_credentials":
    "Path to a service account key file on the engine's host, instead of email and key.",
  "settings.help.llm.providers.vertex.location":
    "Google Cloud region for Vertex AI, for example europe-west4.",
  "settings.help.llm.providers.vertex.model":
    "Model Google Vertex AI runs when it is chosen. Empty uses the model set above.",
  "settings.help.llm.providers.vertex.private_key":
    "Private key of the service account named above.",
  "settings.help.llm.providers.vertex.project":
    "Google Cloud project that runs the Vertex AI models.",
  "settings.help.llm.suggestion_model":
    "Small model that proposes the next questions after a reply. It runs often, so a cheap model keeps costs down.",
  "settings.help.llm.summarize_model":
    "Model for summaries. A small, cheap model is usually enough.",
  "settings.help.llm.summarize_provider":
    "Provider for summarising long conversations. Not set uses the primary provider.",
  "settings.help.llm.web_search":
    "Lets the assistant search the web on Anthropic models. Every search is billed by the provider.",
  "settings.help.log.format":
    "How each log line is written. ndjson and json suit a log collector; pretty and dev are for reading in a terminal.",
  "settings.help.log.level":
    "How much the engine writes to its log. Debug and trace help while hunting a fault and fill the log quickly.",
  "settings.help.notifications.inbox.retention_days":
    "How long a finished inbox task is kept before it is deleted.",
  "settings.help.notifications.push.enabled":
    "Sends a desktop notification when a long run in sk finishes.",
  "settings.help.notifications.push.quietHoursEnd": "End of the quiet hours, as HH:MM.",
  "settings.help.notifications.push.quietHoursStart":
    "Start of the quiet hours, as HH:MM. Empty: no quiet hours.",
  "settings.help.notifications.push.thresholdSec": "Only runs longer than this notify you.",
  "settings.help.operations.seed_skills_at_boot":
    "Refreshes the built-in skills for every workspace at startup.",
  "settings.help.operations.update_check_enabled":
    "Checks at startup whether a newer engine release exists.",
  "settings.help.platform.googlechat.audience":
    "Audience Google Chat signs its requests for; they are checked against it. Read at startup: takes effect after a restart.",
  "settings.help.platform.googlechat.client_email":
    "Service account email the Chat app replies with. Read at startup: takes effect after a restart.",
  "settings.help.platform.googlechat.private_key":
    "Private key of that service account. Read at startup: takes effect after a restart.",
  "settings.help.platform.googlechat.project_id":
    "Google Cloud project of your Chat app. Read at startup: takes effect after a restart.",
  "settings.help.platform.slack.client_id":
    "Client ID of your Slack app. Read at startup: takes effect after a restart.",
  "settings.help.platform.slack.client_secret":
    "Client secret of your Slack app. Read at startup: takes effect after a restart.",
  "settings.help.platform.slack.signing_secret":
    "Verifies that incoming Slack requests really come from Slack. Read at startup: takes effect after a restart.",
  "settings.help.queue.concurrency":
    "How many runs one engine instance executes at once. More means faster throughput and more memory; takes effect after a restart.",
  "settings.help.repl.permissionMode":
    "How sk confirms before acting: ask asks every time, auto asks when it matters, plan only plans, yolo lifts the confirmation for destructive actions.",
  "settings.help.server.port":
    "The port the engine listens on. A change takes effect only after a restart, and anything pointing at the old port must follow.",
  "settings.help.server.public_base_url":
    "The address people and connected apps reach this installation at. Links in mails, sign-in callbacks and approvals are built from it.",
  "settings.help.server.restart_supervised":
    "A supervisor (systemd with Restart=on-failure, Docker with a restart policy) starts the engine again after it ends. Only then can SubKit restart itself from here.",
  "settings.help.tokens.currency":
    "Currency of the prices below. The built-in price list is in USD and applies only while this is USD.",
  "settings.help.tokens.monthly_budget":
    "Most tokens this installation may use in a calendar month. When it is reached, AI steps stop until the next month. 0 means no limit.",
  "settings.help.tokens.prices":
    "Your own prices per million tokens, per model. An entry replaces that model's built-in price; a model with neither is shown as unpriced.",
  "settings.help.ui.personality": "How long the assistant's answers in sk are.",
  "settings.help.ui.statusline.format": "How much the status line under the sk prompt shows.",
  "settings.help.ui.theme": "Colours of the sk terminal. auto follows the terminal.",
  "settings.help.ui.title.format": "What the sk terminal window title shows.",
} as const;

export const settingsHelpDe: Record<keyof typeof settingsHelpEn, string> = {
  "settings.help.server.hosted_rate_limit.tenant_per_month":
    "Monatliches Anfragekontingent je Hosted-Arbeitsbereich. Der Wert null sperrt Anfragen.",
  "settings.help.server.hosted_rate_limit.principal_per_minute":
    "Anfragegrenze je angemeldeter Identität und Arbeitsbereich pro Minute; null sperrt Anfragen.",
  "settings.help.server.hosted_rate_limit.peer_per_minute":
    "Eingangsgrenze je geprüfter Verbindungsgegenstelle pro Minute; null sperrt den Zugang.",
  "settings.help.server.hosted_rate_limit.tenant_per_minute":
    "Anfragegrenze je Hosted-Arbeitsbereich pro Minute; null sperrt Anfragen.",
  "settings.help.server.hosted_rate_limit.global_per_minute":
    "Gemeinsame Eingangsgrenze aller Hosted-Arbeitsbereiche pro Minute; null sperrt den Zugang.",
  "settings.help.server.trusted_proxy_hops":
    "Vertrauenswürdige Schritte von rechts in X-Forwarded-For. Null ignoriert Weiterleitungsheader.",
  "settings.help.server.trusted_proxy_ips":
    "Exakte IP-Adressen vertrauenswürdiger Reverse-Proxys. Jeder konfigurierte Schritt muss passen.",
  "settings.help.database.pool_max":
    "Maximale Anwendungsverbindungen je Pool und Replikat. Erfordert einen Neustart.",
  "settings.help.database.connect_timeout_ms":
    "Zeitlimit in Millisekunden zum Erhalten oder Aufbauen einer PostgreSQL-Verbindung. Erfordert einen Neustart.",
  "settings.help.database.query_timeout_ms":
    "Clientseitiges Zeitlimit für PostgreSQL-Abfragen in Millisekunden. Erfordert einen Neustart.",
  "settings.help.database.statement_timeout_ms":
    "Serverseitiges Zeitlimit für Anweisungen in Millisekunden, gesetzt je Sitzung. Erfordert einen Neustart.",
  "settings.help.database.idle_timeout_ms":
    "Millisekunden bis zum Schließen einer ungenutzten Pool-Verbindung. Erfordert einen Neustart.",
  "settings.help.database.keepalive_delay_ms":
    "Anfängliche TCP-Keepalive-Wartezeit für Datenbankverbindungen in Millisekunden. Erfordert einen Neustart.",
  "settings.help.llm.hosted.enabled":
    "Aktiviert den Hosted-Modus für kostenpflichtige Modelle. Ein Arbeitsbereichskontext ist unabhängig von der Registrierung nötig.",
  "settings.help.llm.hosted.tenant_monthly_microunits":
    "Budget je Arbeitsbereich in Millionstel US-Dollar. Null sperrt kostenpflichtige Modellaufrufe.",
  "settings.help.llm.hosted.global_monthly_microunits":
    "Gemeinsames Hosted-Budget in Millionstel US-Dollar. Null sperrt kostenpflichtige Modellaufrufe.",
  "settings.help.llm.hosted.models":
    "Exakte Anbieter- und Modellliste mit geprüften Kontextgrenzen und maximalen USD-Preisen einschließlich großer Kontexte. Kostenpflichtige native Werkzeuge und multimodale Eingaben werden nicht unterstützt.",
  "settings.help.auth.hosted.enabled":
    "Aktiviert die identitätsbasierte Hosted-Browseranmeldung für ausdrücklich ausgewählte Anbieter. Erfordert einen Neustart.",
  "settings.help.auth.hosted.registration_enabled":
    "Erlaubt neuen Identitäten, einen Arbeitsbereich anzulegen. Bestehende Mitgliedschaften und geprüfte Einladungen bleiben bei geschlossener Registrierung nutzbar.",
  "settings.help.auth.hosted.admission.tenant_creations_per_minute":
    "Globale Grenze neuer Self-Service-Arbeitsbereiche pro Minute. Wiederholte identische Rückrufe verbrauchen das Kontingent nicht.",
  "settings.help.auth.hosted.admission.retained_tenants":
    "Grenze aufbewahrter Arbeitsbereichsdatensätze einschließlich gelöschter Eigentumsnachweise. Null sperrt neue Arbeitsbereiche.",
  "settings.help.auth.hosted.admission.mcp_clients_per_peer_per_minute":
    "Erlaubte dynamische Hosted-MCP-Clientregistrierungen je geprüfter Gegenstelle pro Minute.",
  "settings.help.auth.hosted.admission.mcp_clients_per_minute":
    "Globale Grenze dynamischer Hosted-MCP-Clientregistrierungen pro Minute.",
  "settings.help.auth.hosted.admission.retained_mcp_clients":
    "Grenze aufbewahrter MCP-Clients einschließlich stillgelegter und deaktivierter Registrierungen. Null sperrt neue Clients.",
  "settings.help.storage.hosted.tenant_bytes":
    "Gemeinsames logisches Bytekontingent für Dateien, Reservierungen und aufbewahrte Inhalte einschließlich Kopien und Revisionen. Dies ist kein physisches Datenträgerlimit.",
  "settings.help.storage.hosted.retained_rows_per_resource":
    "Datensatzgrenze je Ressourcentabelle einschließlich Historien und vorgemerkter Löschungen. Null sperrt neue Datensätze.",
  "settings.help.storage.hosted.max_file_bytes":
    "Maximale angegebene Bytezahl je neuer Hosted-Datei. Null sperrt die Dateiübernahme.",
  "settings.help.queue.hosted.execution_concurrency":
    "Grenze gleichzeitiger Hauptausführungen je Hosted-Arbeitsbereich. Null sperrt Arbeit.",
  "settings.help.queue.hosted.chat_concurrency":
    "Grenze gleichzeitiger Chatschritte je Hosted-Arbeitsbereich einschließlich direkter Aufrufe. Null sperrt Arbeit.",
  "settings.help.queue.hosted.pending_jobs":
    "Grenze eingereihter Ausführungs- und Gesprächsaufträge je Arbeitsbereich. Null sperrt die Aufnahme in die Warteschlange.",
  "settings.help.auth.enable_signup":
    "Legt beim ersten SSO-Login ein Mitgliedskonto an. Aus: nur wer schon ein Konto hat, kommt hinein.",
  "settings.help.auth.mcp_oauth.access_token_ttl_seconds":
    "Wie lange der Zugang eines verbundenen Clients gilt, bevor er ihn still erneuert.",
  "settings.help.auth.mcp_oauth.authorization_code_ttl_seconds":
    "Wie lange der Einmal-Code einer Anmeldung gilt. Muss selten geändert werden.",
  "settings.help.auth.mcp_oauth.dynamic_registration_enabled":
    "Lässt diese Clients sich beim ersten Verbinden selbst registrieren. Aus: jeder Client muss von Hand eingetragen werden.",
  "settings.help.auth.mcp_oauth.enabled":
    "Lässt KI-Clients wie ChatGPT, Claude oder Cursor per Anmeldung verbinden. Aus: sie brauchen einen API-Schlüssel.",
  "settings.help.auth.mcp_oauth.refresh_token_ttl_seconds":
    "Wie lange ein Client verbunden bleibt, ohne dass sich jemand erneut anmeldet.",
  "settings.help.auth.mcp_oauth.scopes_supported":
    "Die Berechtigungen, die ein Client anfragen darf. metrics:read bleibt immer in der Liste.",
  "settings.help.products":
    "Je Produkt: die Umgebung, in der seine angemeldeten Personen ausführen, und der Assistenz-Workflow, dessen Tageslimit die App zeigt.",
  "settings.help.auth.providers":
    "Wie sich Menschen im Cockpit anmelden. Behalte mindestens einen Anbieter, den du selbst nutzen kannst; ohne ihn ist niemand mehr drin.",
  "settings.help.auth.session.secret":
    "Signiert Anmelde-Sitzungen. Wird beim ersten Start erzeugt, wenn leer; ein neuer Wert meldet alle ab.",
  "settings.help.database.url":
    "Wird nur beim Start über die Umgebungsvariable DATABASE_URL gesetzt. Zum Ändern die Variable tauschen und jede Instanz neu starten.",
  "settings.help.egress.mode":
    "Ob Workflows Adressen im eigenen Netz erreichen dürfen: „strict“ sperrt private und lokale Hosts, „permissive“ erlaubt sie. Nicht gesetzt: je nach Umgebung.",
  "settings.help.errors.ring_size":
    "Wie viele jüngste Fehler die Engine zur Diagnose im Speicher hält. Wird beim Start gelesen.",
  "settings.help.llm.api_key":
    "Schlüssel für den Hauptanbieter. Ein weiter unten beim Anbieter hinterlegter Schlüssel erfüllt denselben Zweck; einer von beiden genügt.",
  "settings.help.llm.context_1m":
    "Erlaubt unterstützten Modellen bis zu einer Million Tokens je Schritt. Lange Schritte kosten dann deutlich mehr.",
  "settings.help.llm.reasoning_effort":
    "Wie stark das Modell vor jedem Authoring-Schritt nachdenkt. Standard: tiefes Nachdenken nur bei Claude-Modellen, sobald ein Entwurf geprüft, gespeichert oder nachgebessert wird. none, low, medium oder high gilt für jede Authoring-Stufe bei OpenAI-Reasoning-Modellen und unterstützten Claude-Modellen; ein erzwungener Tool-Aufruf schaltet das Nachdenken bei Claude weiterhin ab. Mehr Stärke kostet mehr Ausgabe-Tokens.",
  "settings.help.llm.critic.enabled":
    "Lässt ein zweites Modell jeden Workflow-Entwurf prüfen, nachdem die automatischen Prüfungen bestanden sind. Findet mehr Fehler, kostet einen Aufruf je Entwurf.",
  "settings.help.llm.critic.max_consecutive_rejections":
    "Nach so vielen Ablehnungen in Folge entfällt die Prüfung, damit ein Entwurf nicht endlos kreist.",
  "settings.help.llm.critic.min_steps": "Entwürfe mit weniger Schritten überspringen die Prüfung.",
  "settings.help.llm.fallback_model":
    "Das Modell des Ersatzanbieters. Leer: dessen Standardmodell.",
  "settings.help.llm.fallback_provider":
    "Springt ein, wenn der Hauptanbieter ausfällt oder sein Kontingent erschöpft ist. Nicht gesetzt: kein Ersatz, ein Fehler beendet den Schritt.",
  "settings.help.llm.model":
    "Das Modell, das der Hauptanbieter verwendet. Leer: das Standardmodell des Anbieters.",
  "settings.help.llm.output_guard":
    "Was geschieht, wenn eine Antwort die Sicherheitsprüfung auslöst: „soft“ schreibt um und protokolliert, „hard“ bricht ab, „off“ prüft nicht. Im Betrieb nie „off“.",
  "settings.help.llm.provider":
    "Der KI-Anbieter, den jedes Gespräch und jeder Entwurf zuerst nutzt. Sein Schlüssel muss weiter unten beim Anbieter hinterlegt sein.",
  "settings.help.llm.providers.ai_gateway.api_key":
    "Schlüssel für das KI-Gateway. Nur nötig, wenn das KI-Gateway Haupt-, Ersatz- oder Zusammenfassungsanbieter ist.",
  "settings.help.llm.providers.ai_gateway.model":
    "Modell, das das KI-Gateway verwendet, wenn der Anbieter gewählt ist. Leer: das oben gesetzte Modell.",
  "settings.help.llm.providers.anthropic.api_key":
    "Schlüssel für Anthropic. Nur nötig, wenn Anthropic Haupt-, Ersatz- oder Zusammenfassungsanbieter ist.",
  "settings.help.llm.providers.anthropic.base_url":
    "Nur für einen Proxy oder privaten Endpunkt vor Anthropic. Leer: die öffentliche Adresse des Anbieters.",
  "settings.help.llm.providers.anthropic.model":
    "Modell, das Anthropic verwendet, wenn der Anbieter gewählt ist. Leer: das oben gesetzte Modell.",
  "settings.help.llm.providers.azure.api_key":
    "Schlüssel für Azure OpenAI. Nur nötig, wenn Azure OpenAI Haupt-, Ersatz- oder Zusammenfassungsanbieter ist.",
  "settings.help.llm.providers.azure.api_version":
    "Die Azure-OpenAI-API-Version, die jede Anfrage mitschickt. Leer: der Standard des Clients.",
  "settings.help.llm.providers.azure.base_url":
    "Nur für einen Proxy oder privaten Endpunkt vor Azure OpenAI. Leer: die öffentliche Adresse des Anbieters.",
  "settings.help.llm.providers.azure.model":
    "Modell, das Azure OpenAI verwendet, wenn der Anbieter gewählt ist. Leer: das oben gesetzte Modell.",
  "settings.help.llm.providers.azure.resource_name":
    "Name deiner Azure-OpenAI-Ressource; daraus entsteht die Endpunkt-Adresse, solange keine Basisadresse gesetzt ist.",
  "settings.help.llm.providers.azure.use_deployment_based_urls":
    "Spricht das Modell über den Deployment-Namen in der Adresse an, wie ältere Azure-Deployments es erwarten.",
  "settings.help.llm.providers.bedrock.access_key_id":
    "AWS-Zugriffsschlüssel-ID mit Bedrock-Berechtigung. Gehört zum geheimen Zugriffsschlüssel.",
  "settings.help.llm.providers.bedrock.base_url":
    "Nur für einen Proxy oder privaten Endpunkt vor Amazon Bedrock. Leer: die öffentliche Adresse des Anbieters.",
  "settings.help.llm.providers.bedrock.model":
    "Modell, das Amazon Bedrock verwendet, wenn der Anbieter gewählt ist. Leer: das oben gesetzte Modell.",
  "settings.help.llm.providers.bedrock.region":
    "AWS-Region, in der die Bedrock-Modelle laufen, etwa eu-central-1.",
  "settings.help.llm.providers.bedrock.secret_access_key":
    "Der geheime Teil des AWS-Zugriffsschlüssels.",
  "settings.help.llm.providers.bedrock.session_token":
    "Nur für temporäre AWS-Zugangsdaten; dauerhafte Schlüssel brauchen keinen.",
  "settings.help.llm.providers.gemini.api_key":
    "Schlüssel für Gemini. Nur nötig, wenn Gemini Haupt-, Ersatz- oder Zusammenfassungsanbieter ist.",
  "settings.help.llm.providers.gemini.base_url":
    "Nur für einen Proxy oder privaten Endpunkt vor Gemini. Leer: die öffentliche Adresse des Anbieters.",
  "settings.help.llm.providers.gemini.model":
    "Modell, das Gemini verwendet, wenn der Anbieter gewählt ist. Leer: das oben gesetzte Modell.",
  "settings.help.llm.providers.openai.api_key":
    "Schlüssel für OpenAI. Nur nötig, wenn OpenAI Haupt-, Ersatz- oder Zusammenfassungsanbieter ist.",
  "settings.help.llm.providers.openai.base_url":
    "Nur für einen Proxy oder privaten Endpunkt vor OpenAI. Leer: die öffentliche Adresse des Anbieters.",
  "settings.help.llm.providers.openai.model":
    "Modell, das OpenAI verwendet, wenn der Anbieter gewählt ist. Leer: das oben gesetzte Modell.",
  "settings.help.llm.providers.vertex.api_key":
    "Schlüssel für Google Vertex AI. Nur nötig, wenn Google Vertex AI Haupt-, Ersatz- oder Zusammenfassungsanbieter ist.",
  "settings.help.llm.providers.vertex.client_email":
    "E-Mail des Dienstkontos; mit dessen privatem Schlüssel eine Alternative zum API-Schlüssel.",
  "settings.help.llm.providers.vertex.google_application_credentials":
    "Pfad zu einer Dienstkonto-Schlüsseldatei auf dem Rechner der Engine, statt E-Mail und Schlüssel.",
  "settings.help.llm.providers.vertex.location":
    "Google-Cloud-Region für Vertex AI, etwa europe-west4.",
  "settings.help.llm.providers.vertex.model":
    "Modell, das Google Vertex AI verwendet, wenn der Anbieter gewählt ist. Leer: das oben gesetzte Modell.",
  "settings.help.llm.providers.vertex.private_key":
    "Privater Schlüssel des oben genannten Dienstkontos.",
  "settings.help.llm.providers.vertex.project":
    "Google-Cloud-Projekt, in dem die Vertex-AI-Modelle laufen.",
  "settings.help.llm.suggestion_model":
    "Kleines Modell, das nach einer Antwort nächste Fragen vorschlägt. Es läuft oft; ein günstiges Modell hält die Kosten niedrig.",
  "settings.help.llm.summarize_model":
    "Modell für Zusammenfassungen. Meist genügt ein kleines, günstiges Modell.",
  "settings.help.llm.summarize_provider":
    "Anbieter für Zusammenfassungen langer Gespräche. Nicht gesetzt: der Hauptanbieter.",
  "settings.help.llm.web_search":
    "Erlaubt dem Assistenten bei Anthropic-Modellen die Websuche. Jede Suche berechnet der Anbieter.",
  "settings.help.log.format":
    "Wie jede Protokollzeile geschrieben wird. „ndjson“ und „json“ passen zu einem Log-Sammler, „pretty“ und „dev“ zum Lesen im Terminal.",
  "settings.help.log.level":
    "Wie viel die Engine protokolliert. „debug“ und „trace“ helfen bei der Fehlersuche und füllen das Protokoll schnell.",
  "settings.help.notifications.inbox.retention_days":
    "Wie lange eine erledigte Postfach-Aufgabe aufbewahrt wird, bevor sie gelöscht wird.",
  "settings.help.notifications.push.enabled":
    "Schickt eine Desktop-Mitteilung, wenn ein langer Lauf in sk fertig ist.",
  "settings.help.notifications.push.quietHoursEnd": "Ende der Ruhezeit, als HH:MM.",
  "settings.help.notifications.push.quietHoursStart":
    "Beginn der Ruhezeit, als HH:MM. Leer: keine Ruhezeit.",
  "settings.help.notifications.push.thresholdSec": "Nur Läufe, die länger dauern, melden sich.",
  "settings.help.operations.seed_skills_at_boot":
    "Frischt beim Start die mitgelieferten Skills für jeden Arbeitsbereich auf.",
  "settings.help.operations.update_check_enabled":
    "Prüft beim Start, ob es eine neuere Engine-Version gibt.",
  "settings.help.platform.googlechat.audience":
    "Empfänger, für den Google Chat seine Anfragen signiert; sie werden dagegen geprüft. Wird beim Start gelesen: wirkt nach einem Neustart.",
  "settings.help.platform.googlechat.client_email":
    "E-Mail des Dienstkontos, mit dem die Chat-App antwortet. Wird beim Start gelesen: wirkt nach einem Neustart.",
  "settings.help.platform.googlechat.private_key":
    "Privater Schlüssel dieses Dienstkontos. Wird beim Start gelesen: wirkt nach einem Neustart.",
  "settings.help.platform.googlechat.project_id":
    "Google-Cloud-Projekt deiner Chat-App. Wird beim Start gelesen: wirkt nach einem Neustart.",
  "settings.help.platform.slack.client_id":
    "Client-ID deiner Slack-App. Wird beim Start gelesen: wirkt nach einem Neustart.",
  "settings.help.platform.slack.client_secret":
    "Client-Secret deiner Slack-App. Wird beim Start gelesen: wirkt nach einem Neustart.",
  "settings.help.platform.slack.signing_secret":
    "Prüft, dass eingehende Slack-Anfragen wirklich von Slack stammen. Wird beim Start gelesen: wirkt nach einem Neustart.",
  "settings.help.queue.concurrency":
    "Wie viele Läufe eine Engine-Instanz gleichzeitig ausführt. Mehr heißt mehr Durchsatz und mehr Speicher; wirkt nach einem Neustart.",
  "settings.help.repl.permissionMode":
    "Wie sk vor einer Aktion nachfragt: „ask“ jedes Mal, „auto“ wenn es darauf ankommt, „plan“ plant nur, „yolo“ hebt die Bestätigung für zerstörende Aktionen auf.",
  "settings.help.server.port":
    "Der Port, auf dem die Engine lauscht. Wirkt erst nach einem Neustart; alles, was auf den alten Port zeigt, muss mitziehen.",
  "settings.help.server.public_base_url":
    "Die Adresse, unter der Menschen und verbundene Apps diese Installation erreichen. Links in Mails, Anmelde-Rückrufe und Freigaben werden daraus gebaut.",
  "settings.help.server.restart_supervised":
    "Ein Aufseher (systemd mit Restart=on-failure, Docker mit restart-Policy) startet die Engine nach einem Ende neu. Nur dann kann SubKit sich von hier aus selbst neu starten.",
  "settings.help.tokens.currency":
    "Währung der Preise darunter. Die eingebaute Preisliste ist in USD und gilt nur, solange hier USD steht.",
  "settings.help.tokens.monthly_budget":
    "Höchstens so viele Tokens darf die Installation je Kalendermonat verbrauchen. Ist die Grenze erreicht, halten KI-Schritte bis zum nächsten Monat an. 0 heißt: keine Grenze.",
  "settings.help.tokens.prices":
    "Eigene Preise je Million Tokens und Modell. Ein Eintrag ersetzt den eingebauten Preis; ein Modell ohne beides erscheint als „ohne Preis“.",
  "settings.help.ui.personality": "Wie ausführlich der Assistent in sk antwortet.",
  "settings.help.ui.statusline.format": "Wie viel die Statuszeile unter der sk-Eingabe zeigt.",
  "settings.help.ui.theme": "Farben des sk-Terminals. „auto“ folgt dem Terminal.",
  "settings.help.ui.title.format": "Was der Fenstertitel des sk-Terminals zeigt.",
};
