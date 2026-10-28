import type { DocsBundle } from "@shared/llms-index.ts";

export const DOCS: DocsBundle = {
  "locales": [
    "en",
    "de"
  ],
  "sections": [
    {
      "id": "start",
      "locales": {
        "en": {
          "title": "Getting started",
          "description": "Get to know SubKit, choose the cloud or your own engine, set it up and build your first workflow, in this order."
        },
        "de": {
          "title": "Erste Schritte",
          "description": "Lerne SubKit kennen, wähle Cloud oder eigene Engine, richte sie ein und baue deinen ersten Workflow, in dieser Reihenfolge."
        }
      }
    },
    {
      "id": "work",
      "locales": {
        "en": {
          "title": "Working with SubKit",
          "description": "Use SubKit from the terminal, an AI client, a coding agent, the browser or your own app, and keep knowledge and costs in view."
        },
        "de": {
          "title": "Mit SubKit arbeiten",
          "description": "Arbeite mit SubKit im Terminal, aus einem KI-Client, einem Coding-Agenten, dem Browser oder deiner App, und behalte Wissen und Kosten im Blick."
        }
      }
    },
    {
      "id": "operate",
      "locales": {
        "en": {
          "title": "Operating SubKit",
          "description": "Run your own engine: decide who may do what, how apps and connectors sign in, how the Cockpit looks and where the sandbox ends."
        },
        "de": {
          "title": "Selbst betreiben",
          "description": "Betreibe deine eigene Engine: Lege fest, wer was darf, wie sich Apps und Konnektoren anmelden, wie das Cockpit aussieht und wo die Sandbox endet."
        }
      }
    },
    {
      "id": "reference",
      "locales": {
        "en": {
          "title": "Reference",
          "description": "Look up sk commands, settings, the connector catalog and the license."
        },
        "de": {
          "title": "Referenz",
          "description": "Schlag sk-Befehle, Einstellungen, den Konnektor-Katalog und die Lizenz nach."
        }
      }
    }
  ],
  "pages": [
    {
      "slug": "intro",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "start",
      "order": 1,
      "generated": false,
      "locales": {
        "en": {
          "title": "What is SubKit?",
          "summary": "Learn which recurring work SubKit takes over and how to start.",
          "headings": [
            {
              "depth": 2,
              "text": "What is SubKit?",
              "anchor": "what-is-subkit"
            }
          ],
          "images": [
            {
              "src": "/docs-images/intro-overview.en.webp?v=8dfed08b2c2d",
              "alt": "Overview with key figures for runs, success rate, connector health and cost, the \"Needs you\" list with open decisions and the latest failed runs",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            },
            {
              "src": "/docs-images/intro-docs.en.webp?v=85684f500db6",
              "alt": "Documentation page with search, the \"Getting started\" path with steps 1 to 4 and the \"Working with SubKit\" list",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            }
          ],
          "sha256": "cda4c8d5b9ad480589a7efb8363d02b64d5c004890bc5caac08e6ae536605056",
          "body": "## What is SubKit?\n\nSubKit runs recurring business tasks that span several systems and today depend on one person or a fragile script.\nIt is for teams that want such routine work to run reliably without writing software for it.\nYou describe the task in your own words, the AI drafts a workflow from it, and a person checks it and approves what it may touch.\nAfter that it runs in fixed steps, with only the approved permissions.\nEvery run is recorded.\n\nYou work in the Cockpit in the browser, with the `sk` command line, or from AI clients such as Claude Code over MCP; the Web Clipper also collects web pages into your inbox.\n\n![Overview with key figures for runs, success rate, connector health and cost, the \"Needs you\" list with open decisions and the latest failed runs](/docs-images/intro-overview.en.webp?v=8dfed08b2c2d)\n\nThe **Overview** shows at a glance what ran, what failed and what is waiting for your decision.\nHow to track cost and budget is in \"Keep track of usage and costs\".\n\nUse it as SubKit Cloud or run your own engine:\n\n- \"Use SubKit Cloud\": SubKit runs for you, and you sign in from the browser.\n- \"Run the engine\": you run SubKit on your own server.\n\nThen build your first workflow with \"Your first workflow\".\n\n![Documentation page with search, the \"Getting started\" path with steps 1 to 4 and the \"Working with SubKit\" list](/docs-images/intro-docs.en.webp?v=85684f500db6)"
        },
        "de": {
          "title": "Was ist SubKit?",
          "summary": "Verstehe, welche wiederkehrende Arbeit SubKit übernimmt und wie du startest.",
          "headings": [
            {
              "depth": 2,
              "text": "Was ist SubKit?",
              "anchor": "was-ist-subkit"
            }
          ],
          "images": [
            {
              "src": "/docs-images/intro-overview.de.webp?v=24a2727bea03",
              "alt": "Übersicht mit Kennzahlen zu Läufen, Erfolgsquote, Konnektorzustand und Kosten, der Liste „Braucht dich“ mit offenen Entscheidungen und den letzten fehlgeschlagenen Läufen",
              "build": "10.6.0",
              "width": 1440,
              "height": 787
            },
            {
              "src": "/docs-images/intro-docs.de.webp?v=e1b4efdfa9f7",
              "alt": "Dokumentationsseite mit Suche, dem Pfad „Erste Schritte“ mit den Schritten 1 bis 4 und der Liste „Mit SubKit arbeiten“",
              "build": "10.6.0",
              "width": 1440,
              "height": 787
            }
          ],
          "sha256": "c2bf604ba18912e1b0f0de4addcac9263b9af1f1ef31c37a84a0c7cee7ed90ab",
          "body": "## Was ist SubKit?\n\nSubKit übernimmt wiederkehrende Geschäftsaufgaben, die mehrere Systeme berühren und heute an einer Person oder einem anfälligen Skript hängen.\nEs ist für Teams gedacht, die solche Routine verlässlich laufen lassen wollen, ohne dafür Software zu entwickeln.\nDu beschreibst die Aufgabe in eigenen Worten, die KI entwirft daraus einen Workflow, und eine Person prüft ihn und gibt frei, was er berühren darf.\nDanach läuft er in festen Schritten, nur mit den freigegebenen Rechten.\nJeder Lauf wird aufgezeichnet.\n\nDu arbeitest im Cockpit im Browser, mit der Kommandozeile `sk` oder aus KI-Clients wie Claude Code über MCP; der Web Clipper sammelt dazu Webseiten in deinem Eingang.\n\n![Übersicht mit Kennzahlen zu Läufen, Erfolgsquote, Konnektorzustand und Kosten, der Liste „Braucht dich“ mit offenen Entscheidungen und den letzten fehlgeschlagenen Läufen](/docs-images/intro-overview.de.webp?v=24a2727bea03)\n\nDie **Übersicht** zeigt dir auf einen Blick, was gelaufen ist, was gescheitert ist und was auf deine Entscheidung wartet.\nWie du Kosten und Kontingent verfolgst, steht in „Nutzung und Kosten im Blick“.\n\nNutze SubKit Cloud oder betreibe deine eigene Engine:\n\n- „SubKit Cloud nutzen“: SubKit läuft für dich, und du meldest dich im Browser an.\n- „Die Engine betreiben“: Du betreibst SubKit auf deinem eigenen Server.\n\nDanach baust du mit „Dein erster Workflow“ deinen ersten Workflow.\n\n![Dokumentationsseite mit Suche, dem Pfad „Erste Schritte“ mit den Schritten 1 bis 4 und der Liste „Mit SubKit arbeiten“](/docs-images/intro-docs.de.webp?v=e1b4efdfa9f7)"
        }
      }
    },
    {
      "slug": "subkit-cloud",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "start",
      "order": 2,
      "generated": false,
      "path_choice": "hosting",
      "locales": {
        "en": {
          "title": "Use SubKit Cloud",
          "summary": "Use SubKit in the browser without running your own server.",
          "headings": [
            {
              "depth": 2,
              "text": "Use SubKit Cloud",
              "anchor": "use-subkit-cloud"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Get access",
              "anchor": "get-access"
            },
            {
              "depth": 3,
              "text": "Sign in",
              "anchor": "sign-in"
            },
            {
              "depth": 3,
              "text": "Switch accounts",
              "anchor": "switch-accounts"
            },
            {
              "depth": 3,
              "text": "Switch workspaces",
              "anchor": "switch-workspaces"
            },
            {
              "depth": 3,
              "text": "Delete a workspace",
              "anchor": "delete-a-workspace"
            },
            {
              "depth": 3,
              "text": "Sign in with the sk CLI",
              "anchor": "sign-in-with-the-sk-cli"
            },
            {
              "depth": 3,
              "text": "Connect an MCP client",
              "anchor": "connect-an-mcp-client"
            },
            {
              "depth": 3,
              "text": "Collect web pages",
              "anchor": "collect-web-pages"
            },
            {
              "depth": 3,
              "text": "What is different from self-hosting",
              "anchor": "what-is-different-from-self-hosting"
            },
            {
              "depth": 3,
              "text": "Limits and their messages",
              "anchor": "limits-and-their-messages"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [],
          "sha256": "4bbc108d083a2016caf452ac3a89992a439d82593c2d661596e26f37ebdca25a",
          "body": "## Use SubKit Cloud\n\n> Cloud (hosted beta, by invitation)\n\nWith SubKit Cloud, SubKit runs for you. You install nothing and operate no engine of your own.\nYou sign in from the browser and work in the Cockpit of your workspace.\n\n### What you need\n\n- An invitation from a workspace administrator. There is no public sign-up.\n- The address `https://subkit-cloud.mikebild.info`. It takes you straight to the Cockpit.\n\n### Get access\n\nAn administrator invites you from **People & access** > **Invite person**.\nSign-in, invitations and password emails go through Upraft Auth, the sign-in service of the platform SubKit Cloud runs on.\n\n1. Open the email from \"Upraft Auth\".\n2. Select the link and set a password.\n3. Sign in as described in \"Sign in\".\n\nUse the email address the invitation was sent to. A different address does not work.\n\n### Sign in\n\n1. Open `https://subkit-cloud.mikebild.info`.\n2. Select **Sign in with work account**.\n3. Sign in at Upraft Auth with your email address and password.\n\nThe Cockpit opens in your workspace.\nYour session ends after 8 hours of inactivity, or after 24 hours at the latest.\n\nTo build your first workflow, follow \"Your first workflow\".\n\n### Switch accounts\n\nSigning out in the Cockpit also signs you out at Upraft Auth.\n\n1. In the Cockpit, select **Sign out**.\n2. Sign in again with the other account.\n\n### Switch workspaces\n\nA workspace holds your workflows, connectors, knowledge, skills and runs.\nPeople in one workspace cannot see another workspace.\n\n1. In the Cockpit, select **Switch workspace**.\n2. Select the workspace you want.\n\nWorkspaces you own are marked **Own** and show your role as **Owner**.\nFor the others, the list shows your role, such as Administrator or Member.\n\n### Delete a workspace\n\n> After 7 days, all workspace data is gone and cannot be restored.\n\nOnly the owner can delete a workspace.\n\n1. In the Cockpit, open **Settings**.\n2. Select **Delete workspace**.\n3. Type the workspace name to confirm.\n4. Select **Delete**.\n\nWhat happens next:\n\n- Access is suspended right away. Invited members lose their access.\n- Sessions, API keys, invitations and MCP client connections are revoked.\n- Your other workspaces are not affected.\n- For 7 days you can change your mind. Sign in again and select **Reverse deletion**.\n\nAfter you reverse a deletion, old keys and connections stay revoked.\nSign in again with the sk CLI and your MCP clients. Create a new key for the Web Clipper.\n\n### Sign in with the sk CLI\n\nThe `sk` CLI signs in through the browser, like the Cockpit.\n\n1. Install the CLI:\n\n   ```bash\n   curl -fsSL https://subkit-cloud.mikebild.info/install | bash\n   ```\n\n2. Sign in. Use the address without `/cockpit`:\n\n   ```bash\n   sk login --engine-url https://subkit-cloud.mikebild.info\n   ```\n\n3. In the browser that opens, select **Sign in with work account**.\n\nThe CLI then stores a personal key. Run `sk` to start.\nFor everything else, see \"Use the sk CLI on your machine\".\n\n### Connect an MCP client\n\nAI clients such as ChatGPT, Claude or Cursor can connect to SubKit Cloud over MCP.\n\n1. In your client, add a remote MCP server with the address `https://subkit-cloud.mikebild.info/mcp`.\n2. In the browser sign-in that opens, select **Sign in with work account**.\n3. On **Allow access**, select **Allow**.\n\nYou do not need to copy an API key. For more, see \"Connect AI clients via MCP\".\n\n### Collect web pages\n\nThe Web Clipper collects web pages into the **Inbox**.\nSet it up as described in \"Collect web pages with the Web Clipper\".\nFor SubKit Cloud, the engine address is `https://subkit-cloud.mikebild.info`.\n\n### What is different from self-hosting\n\nSubKit Cloud runs the same engine as a self-hosted installation.\nSome settings are managed by the operator instead of by you.\n\n- **Models, budgets and limits.** The operator chooses them.\n  You cannot add your own AI key or change these settings for your workspace.\n- **Text models only.** Images, audio and other non-text input to the model are not supported.\n- **No native web search.** The model's built-in web search is not available.\n- **Public addresses only.** Connectors reach only services on the public internet.\n  Addresses in a private network, such as `localhost` or an internal company server, are blocked.\n- **Slack and Google Chat are locked.** Chat workspaces on these platforms stay locked\n  until ownership of the workspace is verified. Use the chat in the Cockpit instead.\n- **API keys for tools only.** API keys still work for the sk CLI, the Web Clipper, the HTTP API (Bearer)\n  and MCP clients that use a key. Signing in to the browser with an API key exists only for\n  self-hosted installations without an identity provider.\n- **Export as a package.** You can export your own workflows, connectors, skills, schedules, knowledge sources and files as a package and import it into another engine.\n  Credentials, approvals and run history are not included. See \"Use the sk CLI on your machine\".\n\n### Limits and their messages\n\nEvery workspace has limits. The operator sets their values.\nWhen you reach one, SubKit shows a message. Most of these messages appear in English; the table quotes them verbatim.\n\n| What you see | What to do |\n| --- | --- |\n| \"Too many requests. Try again shortly.\" | You sent too many requests in a short time. Wait a moment and try again. |\n| \"The monthly request allowance is exhausted.\" | The month's request allowance is used up. Wait for the next month or contact the operator. |\n| \"The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds.\" | Storage is full. Delete files and saved content you no longer need, or contact the operator. |\n| \"The workspace resource limit is exhausted. Ask the engine operator to review retained resources.\" | Too many resources. Delete workflows or connectors you no longer need, or contact the operator. |\n| \"This installation's monthly AI budget is used up.\" (in the chat) | Wait for the next month or contact the operator. |\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| The invitation link or sign-in does not work | Use the email address the invitation was sent to. |\n| You forgot your password | Upraft Auth sends you an email to reset it. |\n| You want to use a different account | Follow \"Switch accounts\". |\n| You are signed out unexpectedly | Your session ended after 8 hours of inactivity or 24 hours. Sign in again. |\n| `sk login` or the MCP client cannot connect | Use `https://subkit-cloud.mikebild.info` and `https://subkit-cloud.mikebild.info/mcp`, without `/cockpit`. |"
        },
        "de": {
          "title": "SubKit Cloud nutzen",
          "summary": "Nutze SubKit im Browser, ohne einen eigenen Server zu betreiben.",
          "headings": [
            {
              "depth": 2,
              "text": "SubKit Cloud nutzen",
              "anchor": "subkit-cloud-nutzen"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Zugang erhalten",
              "anchor": "zugang-erhalten"
            },
            {
              "depth": 3,
              "text": "Anmelden",
              "anchor": "anmelden"
            },
            {
              "depth": 3,
              "text": "Konto wechseln",
              "anchor": "konto-wechseln"
            },
            {
              "depth": 3,
              "text": "Arbeitsbereich wechseln",
              "anchor": "arbeitsbereich-wechseln"
            },
            {
              "depth": 3,
              "text": "Einen Arbeitsbereich löschen",
              "anchor": "einen-arbeitsbereich-löschen"
            },
            {
              "depth": 3,
              "text": "Mit der sk-CLI anmelden",
              "anchor": "mit-der-sk-cli-anmelden"
            },
            {
              "depth": 3,
              "text": "Einen MCP-Client verbinden",
              "anchor": "einen-mcp-client-verbinden"
            },
            {
              "depth": 3,
              "text": "Webseiten sammeln",
              "anchor": "webseiten-sammeln"
            },
            {
              "depth": 3,
              "text": "Was anders ist als beim Selbstbetrieb",
              "anchor": "was-anders-ist-als-beim-selbstbetrieb"
            },
            {
              "depth": 3,
              "text": "Limits und ihre Meldungen",
              "anchor": "limits-und-ihre-meldungen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [],
          "sha256": "cb8c78c011d2ff655c0d0162a9090b7271be017930d5cfcf8d93fed2c5c545e5",
          "body": "## SubKit Cloud nutzen\n\n> Cloud (Hosted Beta, auf Einladung)\n\nMit SubKit Cloud läuft SubKit für dich. Du installierst nichts und betreibst keine eigene Engine.\nDu meldest dich im Browser an und arbeitest im Cockpit deines Arbeitsbereichs.\n\n### Was du brauchst\n\n- Eine Einladung von einer Administratorin oder einem Administrator des Arbeitsbereichs. Eine öffentliche Registrierung gibt es nicht.\n- Die Adresse `https://subkit-cloud.mikebild.info`. Die Adresse führt dich direkt ins Cockpit.\n\n### Zugang erhalten\n\nEine Administratorin oder ein Administrator lädt dich unter **Personen & Rechte** > **Person einladen** ein.\nAnmeldung, Einladungen und Passwort-E-Mails laufen über Upraft Auth, den Anmeldedienst der Plattform, auf der SubKit Cloud läuft.\n\n1. Öffne die E-Mail von „Upraft Auth“.\n2. Wähle den Link und lege ein Passwort fest.\n3. Melde dich an, wie unter „Anmelden“ beschrieben.\n\nNutze dieselbe E-Mail-Adresse, an die die Einladung ging. Mit einer anderen Adresse klappt es nicht.\n\n### Anmelden\n\n1. Öffne `https://subkit-cloud.mikebild.info`.\n2. Wähle **Mit Firmenkonto anmelden**.\n3. Melde dich bei Upraft Auth mit deiner E-Mail-Adresse und deinem Passwort an.\n\nDas Cockpit öffnet sich in deinem Arbeitsbereich.\nDeine Sitzung endet nach 8 Stunden Inaktivität, spätestens nach 24 Stunden.\n\nDeinen ersten Workflow baust du mit dem Kapitel „Dein erster Workflow“.\n\n### Konto wechseln\n\nBeim Abmelden im Cockpit meldet SubKit dich auch bei Upraft Auth ab.\n\n1. Wähle im Cockpit **Abmelden**.\n2. Melde dich mit dem anderen Konto neu an.\n\n### Arbeitsbereich wechseln\n\nEin Arbeitsbereich enthält deine Workflows, Konnektoren, dein Wissen, deine Skills und Läufe.\nWer in einem Arbeitsbereich arbeitet, sieht keinen anderen Arbeitsbereich.\n\n1. Wähle im Cockpit **Arbeitsbereich wechseln**.\n2. Wähle den gewünschten Arbeitsbereich.\n\nArbeitsbereiche, die dir gehören, sind mit **Eigener** markiert und zeigen deine Rolle als **Inhaber**.\nBei den anderen zeigt die Liste deine Rolle, etwa Administrator oder Mitglied.\n\n### Einen Arbeitsbereich löschen\n\n> Nach 7 Tagen sind alle Daten des Arbeitsbereichs endgültig gelöscht. Danach lassen sich die Daten nicht mehr wiederherstellen.\n\nNur der Inhaber kann einen Arbeitsbereich löschen.\n\n1. Öffne im Cockpit **Einstellungen**.\n2. Wähle **Arbeitsbereich löschen**.\n3. Gib zur Bestätigung den Namen des Arbeitsbereichs ein.\n4. Wähle **Löschen**.\n\nWas dann passiert:\n\n- Der Zugriff wird sofort gesperrt. Eingeladene Mitglieder verlieren ihren Zugriff.\n- Sitzungen, API-Schlüssel, Einladungen und Verbindungen von MCP-Clients werden widerrufen.\n- Deine anderen Arbeitsbereiche sind nicht betroffen.\n- 7 Tage lang kannst du es dir anders überlegen. Melde dich erneut an und wähle **Löschung rückgängig machen**.\n\nHast du eine Löschung rückgängig gemacht, bleiben alte Schlüssel und Verbindungen widerrufen.\nMelde die sk-CLI und deine MCP-Clients neu an. Für den Web Clipper erstellst du einen neuen Schlüssel.\n\n### Mit der sk-CLI anmelden\n\nDie `sk`-CLI meldet dich wie das Cockpit über den Browser an.\n\n1. Installiere die CLI:\n\n   ```bash\n   curl -fsSL https://subkit-cloud.mikebild.info/install | bash\n   ```\n\n2. Melde dich an. Nutze die Adresse ohne `/cockpit`:\n\n   ```bash\n   sk login --engine-url https://subkit-cloud.mikebild.info\n   ```\n\n3. Wähle im geöffneten Browser **Mit Firmenkonto anmelden**.\n\nDie CLI speichert danach einen persönlichen Schlüssel. Starte mit `sk`.\nAlles Weitere steht im Kapitel „Die sk-CLI auf deinem Rechner verwenden“.\n\n### Einen MCP-Client verbinden\n\nKI-Clients wie ChatGPT, Claude oder Cursor können sich über MCP mit SubKit Cloud verbinden.\n\n1. Füge in deinem Client einen entfernten MCP-Server mit der Adresse `https://subkit-cloud.mikebild.info/mcp` hinzu.\n2. Wähle in der Browser-Anmeldung, die sich öffnet, **Mit Firmenkonto anmelden**.\n3. Wähle auf **Zugriff erlauben** den Button **Erlauben**.\n\nEinen API-Schlüssel musst du nicht kopieren. Mehr dazu im Kapitel „KI-Clients per MCP anbinden“.\n\n### Webseiten sammeln\n\nDer Web Clipper sammelt Webseiten im **Eingang**.\nRichte ihn ein, wie im Kapitel „Webseiten mit dem Web Clipper sammeln“ beschrieben.\nIn SubKit Cloud ist die Engine-Adresse `https://subkit-cloud.mikebild.info`.\n\n### Was anders ist als beim Selbstbetrieb\n\nSubKit Cloud nutzt dieselbe Engine wie eine selbst betriebene Installation.\nEinige Einstellungen verwaltet aber der Betreiber, nicht du.\n\n- **Modelle, Budgets und Limits.** Der Betreiber legt sie fest.\n  Du kannst keinen eigenen KI-Schlüssel hinterlegen und diese Einstellungen für deinen Arbeitsbereich nicht ändern.\n- **Nur Textmodelle.** Bilder, Audio und andere Eingaben, die kein Text sind, werden nicht unterstützt.\n- **Keine eingebaute Websuche.** Die Websuche des Modells steht nicht zur Verfügung.\n- **Nur öffentliche Adressen.** Konnektoren erreichen nur Dienste im öffentlichen Internet.\n  Adressen in einem privaten Netz, etwa `localhost` oder ein interner Firmenserver, sind gesperrt.\n- **Slack und Google Chat sind gesperrt.** Chat-Arbeitsbereiche auf diesen Plattformen bleiben gesperrt,\n  bis bestätigt ist, wem der Arbeitsbereich gehört. Nutze stattdessen den Chat im Cockpit.\n- **API-Schlüssel nur für Werkzeuge.** API-Schlüssel funktionieren weiter für die sk-CLI, den Web Clipper,\n  die HTTP-API (Bearer) und MCP-Clients mit Schlüssel. Die Browser-Anmeldung mit einem API-Schlüssel\n  gibt es nur bei selbst betriebenen Installationen ohne Anmeldeanbieter.\n- **Export als Paket.** Du kannst deine eigenen Workflows, Konnektoren, Skills, Zeitpläne, Quellen und Dateien als Paket exportieren und in eine andere Engine importieren.\n  Zugangsdaten, Freigaben und der Laufverlauf sind nicht enthalten. Siehe „Die sk-CLI auf deinem Rechner verwenden“.\n\n### Limits und ihre Meldungen\n\nJeder Arbeitsbereich hat Limits. Die Werte legt der Betreiber fest.\nErreichst du eines, zeigt SubKit eine Meldung. Die meisten dieser Meldungen erscheinen auf Englisch; die Tabelle zitiert sie wörtlich.\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| \"Too many requests. Try again shortly.\" | Zu viele Anfragen in kurzer Zeit. Warte kurz und versuche es erneut. |\n| \"The monthly request allowance is exhausted.\" | Das Anfragekontingent des Monats ist aufgebraucht. Warte auf den nächsten Monat oder wende dich an den Betreiber. |\n| \"The workspace storage allowance for files and saved content is exhausted. Retained content remains charged until physical cleanup succeeds.\" | Der Speicher ist voll. Lösche Dateien und gespeicherte Inhalte, die du nicht mehr brauchst, oder wende dich an den Betreiber. |\n| \"The workspace resource limit is exhausted. Ask the engine operator to review retained resources.\" | Zu viele Ressourcen. Lösche Workflows oder Konnektoren, die du nicht mehr brauchst, oder wende dich an den Betreiber. |\n| \"Das monatliche KI-Budget dieser Installation ist aufgebraucht.\" (im Chat) | Warte auf den nächsten Monat oder wende dich an den Betreiber. |\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| Der Einladungslink oder die Anmeldung funktioniert nicht | Nutze die E-Mail-Adresse, an die die Einladung ging. |\n| Du hast dein Passwort vergessen | Upraft Auth schickt dir eine E-Mail, mit der du es zurücksetzt. |\n| Du willst ein anderes Konto nutzen | Folge „Konto wechseln“. |\n| Du wirst unerwartet abgemeldet | Deine Sitzung ist nach 8 Stunden Inaktivität oder 24 Stunden abgelaufen. Melde dich erneut an. |\n| `sk login` oder der MCP-Client kann sich nicht verbinden | Nutze `https://subkit-cloud.mikebild.info` und `https://subkit-cloud.mikebild.info/mcp`, ohne `/cockpit`. |"
        }
      }
    },
    {
      "slug": "run-the-engine",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "start",
      "order": 3,
      "generated": false,
      "path_choice": "hosting",
      "locales": {
        "en": {
          "title": "Run the engine",
          "summary": "Run SubKit yourself with Docker Compose on your own server.",
          "headings": [
            {
              "depth": 2,
              "text": "Run the engine",
              "anchor": "run-the-engine"
            },
            {
              "depth": 3,
              "text": "Protect keys and passwords",
              "anchor": "protect-keys-and-passwords"
            },
            {
              "depth": 3,
              "text": "Start, stop and expose",
              "anchor": "start-stop-and-expose"
            },
            {
              "depth": 3,
              "text": "Browser crawling for connector discovery",
              "anchor": "browser-crawling-for-connector-discovery"
            },
            {
              "depth": 3,
              "text": "Backup and recovery",
              "anchor": "backup-and-recovery"
            }
          ],
          "images": [],
          "sha256": "e758400a9d922555e1ef91672372bf59148dfc30b37023bc491eff0a6ad97cff",
          "body": "## Run the engine\n\nAfterwards SubKit runs on your own server: the engine with the Cockpit, a PostgreSQL database and an object store, started with Docker Compose.\nDatabase, files and keys stay on your server.\n\nYou need Docker with Compose, OpenSSL and a POSIX shell.\nPut `docker-compose.yml` in a dedicated directory. Take it from the same published release as the engine image.\nUse only published release images. If pulling the image fails, the installation is not finished, even if other services start.\nDo not combine an older image with a newer Compose file.\n\nCreate the installation secrets once, before the first start. The command does not overwrite an existing `.env` and makes it readable only by its owner:\n\n```bash\n(\n  set -eu\n  umask 077\n  set -C\n  install_master_key=$(openssl rand -hex 32)\n  install_database_password=$(openssl rand -hex 32)\n  printf 'MASTER_KEY=%s\\nSUBKIT_DB_PASSWORD=%s\\n' \\\n    \"$install_master_key\" \"$install_database_password\" > .env\n)\n```\n\nAfter the command succeeds, start the installation:\n\n```bash\ndocker compose pull && docker compose up -d --wait\ncurl -fsS http://localhost:3000/health\n```\n\nThen set up the admin account and AI provider as described in \"First-run setup\".\n\n### Protect keys and passwords\n\n`MASTER_KEY` encrypts all stored secrets. If it is lost, those secrets can no longer be read.\nKeep an encrypted backup of `.env` outside the installation directory.\nNever regenerate `MASTER_KEY` for an existing database.\n\nAlso keep the database password unchanged when you reuse the database volume.\nChanging `.env` does not change the password inside an already initialized PostgreSQL database.\nNever commit `.env`. Do not share the output of `docker compose config` either, because it contains the secrets.\n\nIf you need to change `MASTER_KEY`, the offline command `--rewrap-master-key` re-encrypts the stored settings secrets with the new key.\nIt covers only these settings secrets. If other encrypted data exists, such as retained credentials, encrypted workflow or chat content, or approval proofs, it refuses.\nIn that case, keep the original `MASTER_KEY`.\n\nThe command runs only when all writing services have stopped.\nYou confirm this explicitly with `--all-producers-stopped` and back it with a separate file through `--stop-evidence-file`. Missing signs of life are not enough as proof.\nIf you run the database with a dedicated maintenance login, select it through the existing database configuration and pass `--maintenance`. That login receives only the designated maintenance functions.\nThe engine creates no database users.\n\n### Start, stop and expose\n\nFor later starts, run `docker compose up -d --wait` from the same directory.\n`docker compose stop` stops the services without deleting data.\nThe database and object store live in named volumes; `docker compose down -v` deletes them.\nKeep the same Compose project name when you continue an installation.\n\nAt first, the API and database are reachable only over loopback, that is, only from the server itself.\nComplete the first-run setup locally before you expose the API.\nAccess from outside needs HTTPS and access control. Never expose the database or object store publicly.\n\nA recovery needs the database, object-store data, `.env`, the matching Compose file and the image identity together.\nTest recovery in a separate installation before you rely on a backup or upgrade. The steps are under \"Backup and recovery\".\n\n### Browser crawling for connector discovery\n\nThe supplied image contains no browser and no Node.js.\nConnector discovery therefore looks for a service's documentation over HTTP: OpenAPI, GraphQL, Swagger UI, `llms.txt` and HTML pages.\nWhen none of them finds the documentation, the result names the missing piece: \"browser discovery is not available\".\nIf the documentation needs JavaScript to display, provide a reachable OpenAPI specification or enter the connector endpoints yourself.\n\nBrowser crawling runs only when both conditions hold:\n\n- `SK_PLAYWRIGHT_ENTRY` names an installed Playwright module with its Chromium build,\n  readable by the container user (uid 1001), for example in your own image derived\n  from the SubKit image.\n- The outbound network guard is not strict. The container starts with `NODE_ENV=production`\n  and therefore strict; it refuses browser discovery. The setting `egress.mode: permissive`\n  also allows private and loopback addresses for every connector. Choose it only behind\n  a network boundary you have reviewed.\n\nA derived image is yours to maintain: keep Playwright and the browser updated, scan it\nand ship the browser licenses. This path is not part of the release checks.\n\n### Backup and recovery\n\nA backup copies the whole installation and restores it with the same image.\nTo move only a workspace's own workflows, connectors, skills and knowledge to another engine, export a package instead, as described in \"Use the sk CLI on your machine\".\n\nPlan a maintenance window for a consistent backup.\nThese steps apply to the bundled PostgreSQL and object store; external services need their own procedure.\nRun the commands from the installation directory with its original Compose project name.\nCreate a new backup directory outside the installation directory, readable only by its owner, set `umask 077` and keep it encrypted.\nThe dump, object archive and `.env` contain sensitive data.\n\n1. Record the running engine image identity with `docker inspect --format '{{.Image}}' \"$(docker compose ps -q engine)\"`.\n   Preserve that image in a reachable registry or with `docker image save`, together\n   with `docker-compose.yml` and `.env`. Do not rely on a mutable tag for recovery.\n2. Stop writing services with `docker compose stop engine`. Back up PostgreSQL with\n   `docker compose exec -T postgres pg_dump -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.\n   Check the exit status before you continue. Keep the engine stopped until both data stores are backed up.\n3. Stop the object store with `docker compose stop object-store`. Find its exact volume\n   using `docker inspect --format '{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Name}}{{end}}{{end}}' \"$(docker compose ps -aq object-store)\"`.\n   Archive it read-only with `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:1.4.0-debian -C /data -cf - . > /path/to/backup/objects.tar`.\n   Replace `<object-volume>` with that inspected name, not a guessed one.\n4. Check that each command succeeded. Set all backup files to mode `0600` and record\n   their SHA-256 checksums. Restart the original installation with `docker compose up -d --wait`.\n   If a backup command fails, keep the original volumes and find the cause. An incomplete backup is not a recovery point.\n\nTest recovery in a separate directory. Use `docker compose -p subkit-recovery` there for **every** Compose command below.\nFirst check that this project name has no containers or volumes yet; otherwise choose another unused name.\n\nCopy the saved Compose file and `.env` into it and keep `MASTER_KEY` and the database password.\nSelect the saved engine image with `SUBKIT_IMAGE` and set free loopback ports through `SUBKIT_HOST_PORT` and `SUBKIT_DB_PORT`.\nDo not connect the test installation to external services that write data.\n\nStarting the engine also starts its scheduler. Before the start, add a `docker-compose.override.yml` with this network isolation to the recovery directory.\nKeep it in effect until you have reviewed restored schedules, triggers and connector permissions. Do not trigger real external effects through this project.\n\n```yaml\nnetworks:\n  default:\n    internal: true\n```\n\n1. Create fresh storage with `docker compose -p subkit-recovery create postgres object-store`.\n   Inspect the new object-store container's `/data` volume as above, using the recovery\n   project. Restore only into that new volume:\n   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:1.4.0-debian -C /data -xf - < /path/to/backup/objects.tar`.\n2. Start the new database with `docker compose -p subkit-recovery up -d --wait postgres`.\n   Restore it with `docker compose -p subkit-recovery exec -T postgres pg_restore --exit-on-error --clean --if-exists --no-owner -U subkit -d subkit < /path/to/backup/postgres.dump`.\n   This command replaces database contents. Use it only against the new recovery project.\n3. Start the recovered services with `docker compose -p subkit-recovery up -d --wait`.\n   Check `/health` and `/ready` on the selected port and sign in with an existing account.\n   Compare workflow records and downloaded file checksums, and verify an encrypted credential through a controlled test.\n   A successful health check alone does not prove that the database, object files and key match.\n\nThis restores the same image and a consistent backup. It does not test an upgrade or a schema downgrade.\nData written after the backup is missing.\nKeep the original installation until the recovery has been accepted."
        },
        "de": {
          "title": "Die Engine betreiben",
          "summary": "Betreibe SubKit selbst mit Docker Compose auf deinem eigenen Server.",
          "headings": [
            {
              "depth": 2,
              "text": "Die Engine betreiben",
              "anchor": "die-engine-betreiben"
            },
            {
              "depth": 3,
              "text": "Schlüssel und Passwörter schützen",
              "anchor": "schlüssel-und-passwörter-schützen"
            },
            {
              "depth": 3,
              "text": "Starten, stoppen, erreichbar machen",
              "anchor": "starten-stoppen-erreichbar-machen"
            },
            {
              "depth": 3,
              "text": "Browser-Crawling für die Konnektor-Discovery",
              "anchor": "browser-crawling-für-die-konnektor-discovery"
            },
            {
              "depth": 3,
              "text": "Backup und Wiederherstellung",
              "anchor": "backup-und-wiederherstellung"
            }
          ],
          "images": [],
          "sha256": "a21616a69920292baacdb8d5287ad70ca912f2a7548dd6182ba2fe46491f00b6",
          "body": "## Die Engine betreiben\n\nDanach läuft SubKit auf deinem eigenen Server: die Engine mit Cockpit, eine PostgreSQL-Datenbank und ein Objektspeicher, gestartet mit Docker Compose.\nDatenbank, Dateien und Schlüssel bleiben auf deinem Server.\n\nDu brauchst Docker mit Compose, OpenSSL und eine POSIX-Shell.\nLege die `docker-compose.yml` in ein eigenes Verzeichnis. Nimm sie aus demselben veröffentlichten Release wie das Engine-Image.\nNutze nur veröffentlichte Release-Images. Schlägt das Laden des Images fehl, ist die Installation nicht fertig, auch wenn andere Dienste starten.\nKombiniere kein älteres Image mit einer neueren Compose-Datei.\n\nErzeuge die Installationsgeheimnisse einmalig vor dem ersten Start. Der Befehl überschreibt keine bestehende `.env` und macht sie nur für ihren Eigentümer lesbar:\n\n```bash\n(\n  set -eu\n  umask 077\n  set -C\n  install_master_key=$(openssl rand -hex 32)\n  install_database_password=$(openssl rand -hex 32)\n  printf 'MASTER_KEY=%s\\nSUBKIT_DB_PASSWORD=%s\\n' \\\n    \"$install_master_key\" \"$install_database_password\" > .env\n)\n```\n\nStarte die Installation, nachdem der Befehl erfolgreich war:\n\n```bash\ndocker compose pull && docker compose up -d --wait\ncurl -fsS http://localhost:3000/health\n```\n\nDanach richtest du Admin-Konto und KI-Anbieter ein, wie in „Erstes Setup“ beschrieben.\n\n### Schlüssel und Passwörter schützen\n\n`MASTER_KEY` verschlüsselt alle gespeicherten Geheimnisse. Geht er verloren, sind diese Geheimnisse nicht mehr lesbar.\nBewahre deshalb ein verschlüsseltes Backup der `.env` außerhalb des Installationsverzeichnisses auf.\nErzeuge den `MASTER_KEY` für eine bestehende Datenbank nie neu.\n\nLass auch das Datenbankpasswort unverändert, wenn du das Datenbank-Volume weiterverwendest.\nEine geänderte `.env` ändert das Passwort in einer bereits eingerichteten PostgreSQL-Datenbank nicht.\nCommitte die `.env` nie. Gib auch die Ausgabe von `docker compose config` nicht weiter, denn sie enthält die Geheimnisse.\n\nMusst du den `MASTER_KEY` wechseln, verschlüsselt der Offline-Befehl `--rewrap-master-key` die gespeicherten Einstellungsgeheimnisse mit dem neuen Schlüssel neu.\nEr deckt nur diese Einstellungsgeheimnisse ab. Gibt es weitere verschlüsselte Daten, etwa gespeicherte Zugangsdaten, verschlüsselte Workflow- oder Chat-Inhalte oder Freigabenachweise, lehnt er ab.\nBehalte in diesem Fall den bisherigen `MASTER_KEY`.\n\nDer Befehl läuft nur, wenn alle schreibenden Dienste gestoppt sind.\nDas bestätigst du ausdrücklich mit `--all-producers-stopped` und belegst es mit einer separaten Datei über `--stop-evidence-file`. Dass keine Lebenszeichen mehr kommen, reicht als Beleg nicht.\nBetreibst du die Datenbank mit einem eigens eingerichteten Wartungs-Login, wählst du ihn über die bestehende Datenbankkonfiguration und gibst `--maintenance` an. Dieser Login bekommt nur die vorgesehenen Wartungsfunktionen.\nDie Engine legt keine Datenbankbenutzer an.\n\n### Starten, stoppen, erreichbar machen\n\nFür spätere Starts führst du `docker compose up -d --wait` im selben Verzeichnis aus.\n`docker compose stop` stoppt die Dienste, ohne Daten zu löschen.\nDatenbank und Objektspeicher liegen in benannten Volumes; `docker compose down -v` löscht sie.\nBehalte beim Weiterführen einer Installation denselben Compose-Projektnamen.\n\nAPI und Datenbank sind anfangs nur über Loopback erreichbar, also nur vom Server selbst.\nSchließe das erste Setup lokal ab, bevor du die API freigibst.\nFür Zugriff von außen brauchst du HTTPS und eine Zugriffskontrolle. Gib Datenbank und Objektspeicher nie öffentlich frei.\n\nFür eine Wiederherstellung brauchst du Datenbank, Objektspeicherdaten, `.env`, die passende Compose-Datei und die Image-Identität zusammen.\nTeste die Wiederherstellung in einer separaten Installation, bevor du dich auf ein Backup verlässt oder ein Upgrade machst. Die Schritte stehen unter „Backup und Wiederherstellung“.\n\n### Browser-Crawling für die Konnektor-Discovery\n\nDas mitgelieferte Image enthält keinen Browser und kein Node.js.\nDie Konnektor-Discovery sucht die Dokumentation eines Dienstes deshalb über HTTP: OpenAPI, GraphQL, Swagger UI, `llms.txt` und HTML-Seiten.\nFindet keiner dieser Wege die Dokumentation, nennt das Ergebnis den fehlenden Baustein: „browser discovery is not available“.\nBraucht die Dokumentation JavaScript zum Anzeigen, stelle eine erreichbare OpenAPI-Spezifikation bereit oder trage die Endpunkte des Konnektors selbst ein.\n\nBrowser-Crawling läuft nur, wenn beide Bedingungen gelten:\n\n- `SK_PLAYWRIGHT_ENTRY` nennt ein installiertes Playwright-Modul mit seinem Chromium-Build,\n  lesbar für den Container-Nutzer (uid 1001), zum Beispiel in einem eigenen, vom\n  SubKit-Image abgeleiteten Image.\n- Der Schutz für ausgehende Verbindungen ist nicht strikt. Der Container startet mit\n  `NODE_ENV=production` und damit strikt; er lehnt Browser-Discovery ab. Die Einstellung\n  `egress.mode: permissive` erlaubt zusätzlich private und Loopback-Adressen für alle\n  Konnektoren. Wähle sie nur hinter einer Netzgrenze, die du geprüft hast.\n\nEin abgeleitetes Image pflegst du selbst: Halte Playwright und den Browser aktuell, scanne\nes und liefere die Browser-Lizenzen mit. Dieser Weg ist nicht Teil der Release-Prüfungen.\n\n### Backup und Wiederherstellung\n\nEin Backup kopiert die ganze Installation und stellt sie mit demselben Image wieder her.\nUm nur die eigenen Workflows, Konnektoren, Skills und das Wissen eines Arbeitsbereichs auf eine andere Engine zu bringen, exportiere stattdessen ein Paket wie in „Die sk-CLI auf deinem Rechner verwenden“ beschrieben.\n\nPlane für ein konsistentes Backup ein Wartungsfenster ein.\nDie Schritte gelten für die mitgelieferte PostgreSQL und den mitgelieferten Objektspeicher; externe Dienste brauchen ein eigenes Verfahren.\nFühre die Befehle im Installationsverzeichnis mit dem ursprünglichen Compose-Projektnamen aus.\nLege ein neues Backup-Verzeichnis außerhalb des Installationsverzeichnisses an, nur für den Eigentümer lesbar, setze `umask 077` und halte es verschlüsselt.\nDump, Objektarchiv und `.env` enthalten sensible Daten.\n\n1. Erfasse die Identität des laufenden Engine-Images mit `docker inspect --format '{{.Image}}' \"$(docker compose ps -q engine)\"`.\n   Bewahre dieses Image in einer erreichbaren Registry oder mit `docker image save` auf, zusammen\n   mit `docker-compose.yml` und `.env`. Verlass dich für die Wiederherstellung nicht auf einen veränderlichen Tag.\n2. Stoppe schreibende Dienste mit `docker compose stop engine`. Sichere PostgreSQL mit\n   `docker compose exec -T postgres pg_dump -U subkit -d subkit -Fc > /path/to/backup/postgres.dump`.\n   Prüfe den Exit-Status, bevor du weitermachst. Lass die Engine gestoppt, bis beide Datenspeicher gesichert sind.\n3. Stoppe den Objektspeicher mit `docker compose stop object-store`. Ermittle sein genaues Volume\n   mit `docker inspect --format '{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Name}}{{end}}{{end}}' \"$(docker compose ps -aq object-store)\"`.\n   Archiviere es schreibgeschützt mit `docker run --rm --network none -v <object-volume>:/data:ro --entrypoint tar oven/bun:1.4.0-debian -C /data -cf - . > /path/to/backup/objects.tar`.\n   Ersetze `<object-volume>` durch den ermittelten Namen, nicht durch einen geratenen.\n4. Prüfe, dass jeder Befehl erfolgreich war. Setze alle Backup-Dateien auf den Modus `0600` und halte\n   ihre SHA-256-Prüfsummen fest. Starte die ursprüngliche Installation mit `docker compose up -d --wait` neu.\n   Schlägt ein Backup-Befehl fehl, behalte die ursprünglichen Volumes und such die Ursache. Ein unvollständiges Backup ist kein Wiederherstellungspunkt.\n\nTeste die Wiederherstellung in einem separaten Verzeichnis. Nutze dort für **jeden** Compose-Befehl unten `docker compose -p subkit-recovery`.\nPrüfe vorher, dass es unter diesem Projektnamen noch keine Container oder Volumes gibt; sonst wähle einen anderen, unbenutzten Namen.\n\nKopiere die gesicherte Compose-Datei und die `.env` hinein und behalte `MASTER_KEY` und Datenbankpasswort bei.\nWähle das gesicherte Engine-Image mit `SUBKIT_IMAGE` und setze freie Loopback-Ports über `SUBKIT_HOST_PORT` und `SUBKIT_DB_PORT`.\nVerbinde die Testinstallation nicht mit externen Diensten, die Daten schreiben.\n\nMit dem Start der Engine startet auch ihr Zeitplaner. Lege deshalb vor dem Start eine `docker-compose.override.yml` mit dieser Netzwerktrennung ins Wiederherstellungsverzeichnis.\nLass sie aktiv, bis du wiederhergestellte Zeitpläne, Trigger und Konnektor-Rechte geprüft hast. Löse über dieses Projekt keine echten externen Wirkungen aus.\n\n```yaml\nnetworks:\n  default:\n    internal: true\n```\n\n1. Lege neuen Speicher mit `docker compose -p subkit-recovery create postgres object-store` an.\n   Ermittle das `/data`-Volume des neuen Objektspeicher-Containers wie oben, mit dem Wiederherstellungsprojekt.\n   Stelle nur in dieses neue Volume wieder her:\n   `docker run --rm -i --network none -v <new-object-volume>:/data --entrypoint tar oven/bun:1.4.0-debian -C /data -xf - < /path/to/backup/objects.tar`.\n2. Starte die neue Datenbank mit `docker compose -p subkit-recovery up -d --wait postgres`.\n   Stelle sie mit `docker compose -p subkit-recovery exec -T postgres pg_restore --exit-on-error --clean --if-exists --no-owner -U subkit -d subkit < /path/to/backup/postgres.dump` wieder her.\n   Dieser Befehl ersetzt Datenbankinhalte. Verwende ihn nur gegen das neue Wiederherstellungsprojekt.\n3. Starte die wiederhergestellten Dienste mit `docker compose -p subkit-recovery up -d --wait`.\n   Prüfe `/health` und `/ready` auf dem gewählten Port und melde dich mit einem bestehenden Konto an.\n   Vergleiche Workflow-Datensätze und Prüfsummen heruntergeladener Dateien, und prüfe ein verschlüsseltes Zugangsdatum mit einem kontrollierten Test.\n   Ein erfolgreicher Health-Check allein belegt nicht, dass Datenbank, Objektdateien und Schlüssel zusammenpassen.\n\nSo stellst du dasselbe Image und ein konsistentes Backup wieder her. Ein Upgrade oder ein Schema-Downgrade ist damit nicht getestet.\nDaten, die nach dem Backup geschrieben wurden, fehlen.\nBehalte die ursprüngliche Installation, bis die Wiederherstellung abgenommen ist."
        }
      }
    },
    {
      "slug": "first-run-setup",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "start",
      "order": 4,
      "generated": false,
      "locales": {
        "en": {
          "title": "First-run setup",
          "summary": "Create the admin account, workspace and AI provider after the first start.",
          "headings": [
            {
              "depth": 2,
              "text": "First-run setup",
              "anchor": "first-run-setup"
            }
          ],
          "images": [],
          "sha256": "0d1231f5188c61e12d7caac61f2733b0c4f6d4bd9759492c9ba483fb10daa622",
          "body": "## First-run setup\n\nAfter this step your engine has an admin account, a first workspace and a verified AI provider, and you can sign in to the Cockpit.\nThe engine writes the one-time setup token to its log on first start; the command reads it from there.\n\n```bash\ndocker compose exec engine sk init \\\n  --token \"$(docker compose logs engine 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)\" \\\n  --admin-email you@example.com \\\n  --tenant-name \"My Org\" \\\n  --llm-provider anthropic \\\n  --llm-api-key <your-provider-key>\n```\n\nReplace the email address, the name and the key with your own values.\n`sk init` checks the key with one small test call before it saves anything.\nIf the provider refuses it, the setup stops and nothing is stored. The same token works for the next try.\n\nOpen the Cockpit at `http://localhost:3000/cockpit`.\nIf no sign-in provider is configured, sign in with an API key.\nThen build your first workflow with \"Your first workflow\"."
        },
        "de": {
          "title": "Erstes Setup",
          "summary": "Lege nach dem ersten Start Admin-Konto, Arbeitsbereich und KI-Anbieter an.",
          "headings": [
            {
              "depth": 2,
              "text": "Erstes Setup",
              "anchor": "erstes-setup"
            }
          ],
          "images": [],
          "sha256": "f6c978e5c6404e0c65edc3fc490486e0395c053b98ac6a9b4896b73d97dd4e5f",
          "body": "## Erstes Setup\n\nNach diesem Schritt hat deine Engine ein Admin-Konto, einen ersten Arbeitsbereich und einen geprüften KI-Anbieter, und du kannst dich im Cockpit anmelden.\nDen einmaligen Einrichtungs-Token schreibt die Engine beim ersten Start in ihr Log; der Befehl liest ihn dort aus.\n\n```bash\ndocker compose exec engine sk init \\\n  --token \"$(docker compose logs engine 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1 | cut -d' ' -f4)\" \\\n  --admin-email you@example.com \\\n  --tenant-name \"My Org\" \\\n  --llm-provider anthropic \\\n  --llm-api-key <your-provider-key>\n```\n\nErsetze die E-Mail-Adresse, den Namen und den Schlüssel durch deine Werte.\n`sk init` prüft den Schlüssel mit einem kleinen Testaufruf, bevor es etwas speichert.\nLehnt der Anbieter ihn ab, stoppt das Setup ohne gespeicherte Daten. Derselbe Token funktioniert beim nächsten Versuch.\n\nÖffne das Cockpit unter `http://localhost:3000/cockpit`.\nIst kein Anmeldeanbieter eingerichtet, meldest du dich mit einem API-Schlüssel an.\nDanach baust du mit „Dein erster Workflow“ deinen ersten Workflow."
        }
      }
    },
    {
      "slug": "first-workflow",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "start",
      "order": 5,
      "generated": false,
      "locales": {
        "en": {
          "title": "Your first workflow",
          "summary": "Take your first workflow from a sentence in the chat to a checked run.",
          "headings": [
            {
              "depth": 2,
              "text": "Your first workflow",
              "anchor": "your-first-workflow"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Sign in",
              "anchor": "sign-in"
            },
            {
              "depth": 3,
              "text": "Describe the task",
              "anchor": "describe-the-task"
            },
            {
              "depth": 3,
              "text": "Save the workflow",
              "anchor": "save-the-workflow"
            },
            {
              "depth": 3,
              "text": "Approve what it may touch",
              "anchor": "approve-what-it-may-touch"
            },
            {
              "depth": 3,
              "text": "Start the workflow",
              "anchor": "start-the-workflow"
            },
            {
              "depth": 3,
              "text": "Check the result",
              "anchor": "check-the-result"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            },
            {
              "depth": 3,
              "text": "The same in the terminal",
              "anchor": "the-same-in-the-terminal"
            }
          ],
          "images": [
            {
              "src": "/docs-images/first-workflow-approval.en.webp?v=a0dd838590e7",
              "alt": "Approval dialog for \"Invoice export v1\" with the environment \"Test\", the validity \"Until revoked\", one read on the Sales reporting API, no writes, and the \"Apply only\" and \"Approve\" buttons",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            },
            {
              "src": "/docs-images/first-workflow-run-result.en.webp?v=d6f1c5541b42",
              "alt": "Successful run of \"CRM contact sync\" with one \"Query a service\" step, the requester \"API\" and the collapsed \"Why it was allowed\" and \"Technical details\" sections",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            }
          ],
          "sha256": "9cea89bee2d416c7ba261f49ac216b372f69cd0ffe859a9a72e39df16d11cda5",
          "body": "## Your first workflow\n\nBy the end of this chapter you have an approved workflow and a first run whose steps you can read.\nYou describe a task in the chat, save the workflow, approve it, start it and read the result.\nIt works the same in SubKit Cloud and on a self-hosted engine.\n\n### What you need\n\n- A SubKit account in a workspace.\n  - Cloud: `https://subkit-cloud.mikebild.info`\n  - Self-hosted: `https://<your-engine>/cockpit`\n- Permission to create and run workflows. Ask your administrator if a button is missing.\n- An AI provider. Cloud provides one. A self-hosted engine uses the provider you chose in `sk init`.\n\n### Sign in\n\n1. Open the Cockpit.\n2. Select **Sign in with work account**.\n\nYou land on **Overview** in your workspace.\nSelf-hosted without an identity provider? Select **Sign in with API key** instead and enter your key.\n\n### Describe the task\n\n1. In the navigation, open **Chat**.\n2. Select **New conversation**.\n3. Describe the task in your own words: what goes in, what should happen, what comes out.\n   Example: \"Fetch the open issues of my GitHub repository and give me a short list with title and link.\"\n4. Answer the questions SubKit asks. If the task needs a service, SubKit asks you to connect it\n   or to sign in to it.\n\nGood to know: a small task is easier to check. You can extend the workflow later in the same chat.\n\n### Save the workflow\n\nWhen the workflow is ready, SubKit shows a card **Save workflow draft**.\n\n1. Open **What will change** and read which steps and targets are included.\n2. Select **Save inactive version**.\n\nSaving starts nothing. The workflow now appears under **Workflows**.\n\nWithout the chat, you create a workflow under **Workflows** with **Create workflow**. The wizard guides you through **How**, **What**, **When** and **Check**.\n\n### Approve what it may touch\n\nA new version does not touch anything outside SubKit until a person approves it.\nWithout an approval, a run starts only as a trial run without effects.\n\n1. Open **Workflows** and click your workflow. Its page opens on the **Overview** tab.\n   The status line shows **Waiting for approval** or **Not approved**.\n2. In the status line, select **Approve**.\n3. Check **Environment**, **Validity** and **Operations and external targets**.\n4. Confirm with **Approve**.\n   **Apply only** applies the version without approving runs.\n\n![Approval dialog for \"Invoice export v1\" with the environment \"Test\", the validity \"Until revoked\", one read on the Sales reporting API, no writes, and the \"Apply only\" and \"Approve\" buttons](/docs-images/first-workflow-approval.en.webp?v=a0dd838590e7)\n\nApproving starts no run. It covers one environment and a duration.\nA new version needs no new approval as long as it touches no more systems, addresses or write permissions than the approved one. If it reaches further, SubKit asks again and names the difference.\nYou can revoke it at any time in the **Approvals** tab.\nIf the chat offers an approval, it opens the same dialog.\n\n| Field | What it controls |\n| --- | --- |\n| **Environment** | Where the runs are allowed, for example **Production**. |\n| **Operations and external targets** | Which services and addresses the workflow reaches. Each service shows its provider's logo. |\n| **Validity** | How long the approval applies: **7 days**, **30 days** or **Until revoked**. |\n\n**When Approve is missing.** Some steps cannot be covered by any approval, for example a mail whose recipient comes from data, or a request with a free address. The status then reads **Change needed before approval** and names the step. Select **Fix it in the chat**: SubKit changes exactly those steps, checks them without live effects and saves a draft. Approve the new version afterwards.\n\n### Start the workflow\n\n1. On the workflow page, select **Start**.\n2. Fill in the form if the workflow asks for inputs. You only type JSON under **Enter as JSON**.\n3. Select **Start** to confirm. The dialog says **Starts a run of the approved version.**\n   Without an approval, the button reads **Start a trial run**.\n\nYou see **Run started**. If the button is unavailable, the hint says why, for example\n**Switch the workflow on before starting it.**\n\n### Check the result\n\n1. On the workflow page, open the **History** tab.\n   The newest run is at the top, with its status. **Succeeded** means the run finished.\n2. Click the run.\n   You see every step with its output. A failed step shows **Error in step \"…\"** with the cause.\n\n   ![Successful run of \"CRM contact sync\" with one \"Query a service\" step, the requester \"API\" and the collapsed \"Why it was allowed\" and \"Technical details\" sections](/docs-images/first-workflow-run-result.en.webp?v=d6f1c5541b42)\n\n3. Optional: Select **In the audit trail** to see who started and approved the run.\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| The run result is headed **Trial run result — not written** | The version has no approval yet. Follow \"Approve what it may touch\". |\n| \"Not started (…): no valid approval covers this run.\" | The approval is missing, expired or used up. Approve again or extend it. |\n| \"… must be reconnected\" | Open the connector under **Connectors** and select **Sign in again**. |\n| **You may not start this workflow.** | Ask your administrator for a role that may run workflows. |\n| A step failed | Open the run, read the error and describe it in the same chat. SubKit suggests a fix that you review again. |\n\n### The same in the terminal\n\nWith the `sk` command line you create workflows with `sk workflows create`, change them with `sk workflows update` and schedule them with `sk schedules create`.\nIf a step needs a change before approval, these commands report `automation: repair required`.\nCheck runs like this:\n\n```bash\nsk executions list --limit 5\nsk executions steps <run-id>\nsk executions result <run-id>\n```\n\n`sk workflows run <workflow-slug> --follow` starts another run and streams its steps.\nFor more, see \"Use the sk CLI on your machine\"."
        },
        "de": {
          "title": "Dein erster Workflow",
          "summary": "Bring deinen ersten Workflow vom Satz im Chat bis zum geprüften Lauf.",
          "headings": [
            {
              "depth": 2,
              "text": "Dein erster Workflow",
              "anchor": "dein-erster-workflow"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Anmelden",
              "anchor": "anmelden"
            },
            {
              "depth": 3,
              "text": "Die Aufgabe beschreiben",
              "anchor": "die-aufgabe-beschreiben"
            },
            {
              "depth": 3,
              "text": "Den Workflow speichern",
              "anchor": "den-workflow-speichern"
            },
            {
              "depth": 3,
              "text": "Freigeben, was er berühren darf",
              "anchor": "freigeben-was-er-berühren-darf"
            },
            {
              "depth": 3,
              "text": "Den Workflow starten",
              "anchor": "den-workflow-starten"
            },
            {
              "depth": 3,
              "text": "Das Ergebnis prüfen",
              "anchor": "das-ergebnis-prüfen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            },
            {
              "depth": 3,
              "text": "Dasselbe im Terminal",
              "anchor": "dasselbe-im-terminal"
            }
          ],
          "images": [
            {
              "src": "/docs-images/first-workflow-approval.de.webp?v=1693159c0530",
              "alt": "Freigabedialog für „Invoice export v1“ mit der Umgebung „Test“, der Gültigkeit „Bis auf Widerruf“, einem Lesezugriff auf die Sales reporting API, keinem Schreibzugriff und den Schaltflächen „Nur übernehmen“ und „Freigeben“",
              "build": "10.6.0",
              "width": 1440,
              "height": 787
            },
            {
              "src": "/docs-images/first-workflow-run-result.de.webp?v=b32a1a272008",
              "alt": "Erfolgreicher Lauf von „CRM contact sync“ mit einem Schritt „Dienst abfragen“, dem Auftraggeber „API“ und den eingeklappten Abschnitten „Warum erlaubt“ und „Technische Angaben“",
              "build": "10.6.0",
              "width": 1440,
              "height": 787
            }
          ],
          "sha256": "ab86a422ecd399ff0276b802b08684fae4111e946e153f7af1d140c647c2aa67",
          "body": "## Dein erster Workflow\n\nAm Ende dieses Kapitels hast du einen freigegebenen Workflow und einen ersten Lauf, dessen Schritte du nachlesen kannst.\nDu beschreibst eine Aufgabe im Chat, speicherst den Workflow, gibst ihn frei, startest ihn und liest das Ergebnis.\nDas funktioniert in SubKit Cloud und auf einer selbst betriebenen Engine gleich.\n\n### Was du brauchst\n\n- Ein SubKit-Konto in einem Arbeitsbereich.\n  - Cloud: `https://subkit-cloud.mikebild.info`\n  - Selbst betrieben: `https://<deine-engine>/cockpit`\n- Das Recht, Workflows anzulegen und zu starten. Fehlt ein Button, bitte eine Administratorin oder einen Administrator darum.\n- Einen KI-Anbieter. Die Cloud stellt ihn bereit. Eine selbst betriebene Engine nutzt den Anbieter, den du bei `sk init` gewählt hast.\n\n### Anmelden\n\n1. Öffne das Cockpit.\n2. Wähle **Mit Firmenkonto anmelden**.\n\nDu landest in deinem Arbeitsbereich auf **Übersicht**.\nSelbst betrieben ohne Anmeldeanbieter? Wähle stattdessen **Mit API-Schlüssel anmelden** und gib deinen Schlüssel ein.\n\n### Die Aufgabe beschreiben\n\n1. Öffne in der Navigation **Chat**.\n2. Wähle **Neue Unterhaltung**.\n3. Beschreibe die Aufgabe in eigenen Worten: was hineingeht, was passieren soll, was herauskommt.\n   Beispiel: „Hol die offenen Issues meines GitHub-Repositorys und gib mir eine kurze Liste mit Titel und Link.“\n4. Beantworte die Rückfragen von SubKit. Braucht die Aufgabe einen Dienst, bittet dich SubKit,\n   ihn zu verbinden oder dich dort anzumelden.\n\nGut zu wissen: Eine kleine Aufgabe lässt sich leichter prüfen. Erweitern kannst du den Workflow später im selben Chat.\n\n### Den Workflow speichern\n\nIst der Workflow fertig, zeigt SubKit eine Karte **Workflow-Entwurf speichern**.\n\n1. Öffne **Was sich ändert** und lies, welche Schritte und Ziele enthalten sind.\n2. Wähle **Inaktive Version speichern**.\n\nSpeichern startet nichts. Der Workflow erscheint jetzt unter **Workflows**.\n\nOhne Chat legst du einen Workflow unter **Workflows** mit **Workflow erstellen** an. Der Assistent führt dich durch **Wie**, **Was**, **Wann** und **Prüfen**.\n\n### Freigeben, was er berühren darf\n\nEine neue Version berührt nichts außerhalb von SubKit, bis ein Mensch sie freigibt.\nOhne Freigabe startet ein Lauf nur als Probelauf ohne Wirkung.\n\n1. Öffne **Workflows** und klicke auf deinen Workflow. Seine Seite öffnet sich mit dem Tab **Übersicht**.\n   Die Statuszeile zeigt **Wartet auf Freigabe** oder **Nicht freigegeben**.\n2. Wähle in der Statuszeile **Freigeben**.\n3. Prüfe **Umgebung**, **Gültigkeit** sowie **Operationen und externe Ziele**.\n4. Bestätige mit **Freigeben**.\n   **Nur übernehmen** übernimmt die Version, ohne Läufe freizugeben.\n\n![Freigabedialog für „Invoice export v1“ mit der Umgebung „Test“, der Gültigkeit „Bis auf Widerruf“, einem Lesezugriff auf die Sales reporting API, keinem Schreibzugriff und den Schaltflächen „Nur übernehmen“ und „Freigeben“](/docs-images/first-workflow-approval.de.webp?v=1693159c0530)\n\nDie Freigabe startet keinen Lauf. Eine Freigabe gilt für eine Umgebung und eine Dauer.\nEine neue Version braucht keine neue Freigabe, solange sie nicht mehr Systeme, Adressen oder Schreibrechte anfasst als die freigegebene. Greift sie weiter, fragt SubKit erneut und nennt den Unterschied.\nIm Tab **Freigaben** kannst du sie jederzeit widerrufen.\nBietet dir der Chat eine Freigabe an, öffnet sie denselben Dialog.\n\n| Feld | Was es festlegt |\n| --- | --- |\n| **Umgebung** | Wo die Läufe erlaubt sind, zum Beispiel **Produktion**. |\n| **Operationen und externe Ziele** | Welche Dienste und Adressen der Workflow erreicht. Jeder Dienst trägt das Logo seines Anbieters. |\n| **Gültigkeit** | Wie lange die Freigabe gilt: **7 Tage**, **30 Tage** oder **Bis auf Widerruf**. |\n\n**Wenn Freigeben fehlt.** Manche Schritte kann keine Freigabe abdecken, etwa eine Mail, deren Empfänger aus Daten stammt, oder ein Aufruf mit freier Adresse. Der Status lautet dann **Umbau nötig vor der Freigabe** und nennt den Schritt. Wähle **Im Chat beheben**: SubKit baut genau diese Schritte um, prüft sie ohne Live-Wirkungen und speichert einen Entwurf. Danach gibst du die neue Version frei.\n\n### Den Workflow starten\n\n1. Wähle auf der Workflow-Seite **Starten**.\n2. Fülle das Formular aus, wenn der Workflow Eingaben verlangt. JSON gibst du nur unter **Als JSON eingeben** ein.\n3. Wähle **Starten**, um zu bestätigen. Der Dialog sagt **Startet einen Lauf mit der freigegebenen Version.**\n   Ohne Freigabe heißt der Button **Probelauf starten**.\n\nDu siehst **Lauf gestartet**. Ist der Button nicht verfügbar, nennt der Hinweis den Grund, zum Beispiel\n**Schalte den Workflow vor dem Starten ein.**\n\n### Das Ergebnis prüfen\n\n1. Öffne auf der Workflow-Seite den Tab **Verlauf**.\n   Der neueste Lauf steht oben, mit seinem Status. **Erfolgreich** heißt, der Lauf ist durchgelaufen.\n2. Klicke auf den Lauf.\n   Du siehst jeden Schritt mit seiner Ausgabe. Ein fehlgeschlagener Schritt zeigt **Fehler in Schritt „…“** mit der Ursache.\n\n   ![Erfolgreicher Lauf von „CRM contact sync“ mit einem Schritt „Dienst abfragen“, dem Auftraggeber „API“ und den eingeklappten Abschnitten „Warum erlaubt“ und „Technische Angaben“](/docs-images/first-workflow-run-result.de.webp?v=b32a1a272008)\n\n3. Optional: Wähle **Im Audit-Trail**, um zu sehen, wer den Lauf gestartet und freigegeben hat.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| Das Ergebnis des Laufs ist mit **Ergebnis des Probelaufs – nicht geschrieben** überschrieben | Die Version ist noch nicht freigegeben. Folge „Freigeben, was er berühren darf“. |\n| „Nicht gestartet (…): Für diesen Lauf gibt es keine gültige Freigabe.“ | Die Freigabe fehlt, ist abgelaufen oder aufgebraucht. Gib erneut frei oder verlängere sie. |\n| „… muss neu verbunden werden“ | Öffne den Konnektor unter **Konnektoren** und wähle **Neu anmelden**. |\n| **Du darfst diesen Workflow nicht starten.** | Bitte eine Administratorin oder einen Administrator um eine Rolle, die Workflows starten darf. |\n| Ein Schritt ist fehlgeschlagen | Öffne den Lauf, lies den Fehler und beschreibe ihn im selben Chat. SubKit schlägt eine Korrektur vor, die du erneut prüfst. |\n\n### Dasselbe im Terminal\n\nMit der Kommandozeile `sk` legst du Workflows mit `sk workflows create` an, änderst sie mit `sk workflows update` und planst sie mit `sk schedules create` ein.\nBraucht ein Schritt einen Umbau vor der Freigabe, melden diese Befehle `automation: repair required`.\nLäufe prüfst du so:\n\n```bash\nsk executions list --limit 5\nsk executions steps <run-id>\nsk executions result <run-id>\n```\n\n`sk workflows run <workflow-slug> --follow` startet einen weiteren Lauf und zeigt seine Schritte live.\nMehr steht in „Die sk-CLI auf deinem Rechner verwenden“."
        }
      }
    },
    {
      "slug": "use-the-sk-cli-on-your-machine",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 1,
      "generated": false,
      "locales": {
        "en": {
          "title": "Use the sk CLI on your machine",
          "summary": "Get the sk CLI from your engine and work in the terminal.",
          "headings": [
            {
              "depth": 2,
              "text": "Use the sk CLI on your machine",
              "anchor": "use-the-sk-cli-on-your-machine"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Install and sign in",
              "anchor": "install-and-sign-in"
            },
            {
              "depth": 3,
              "text": "Sign in with an API key",
              "anchor": "sign-in-with-an-api-key"
            },
            {
              "depth": 3,
              "text": "Work with several engines",
              "anchor": "work-with-several-engines"
            },
            {
              "depth": 3,
              "text": "Update the CLI",
              "anchor": "update-the-cli"
            },
            {
              "depth": 3,
              "text": "What the installers check",
              "anchor": "what-the-installers-check"
            },
            {
              "depth": 3,
              "text": "Install from a public release",
              "anchor": "install-from-a-public-release"
            },
            {
              "depth": 3,
              "text": "Move your workspace to another engine",
              "anchor": "move-your-workspace-to-another-engine"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [],
          "sha256": "deea55a5c37cfcf577add5fd99a6efb76f2a838a007b5788b7ae34946a8a0d5f",
          "body": "## Use the sk CLI on your machine\n\nThis chapter is for anyone who prefers the terminal or scripts to the Cockpit.\nYou install the `sk` command line, sign in and keep it up to date.\nAfterwards you write workflows, connectors and knowledge as files and start runs from the terminal.\n\nYou get the `sk` command line straight from your engine. With it you draft, change and run workflows as files; `sk agent init` adds SubKit to Claude Code and Codex.\nThere is no npm package.\n\n### What you need\n\n- The address of your engine, without a path. The examples use `http://localhost:3000`.\n  For SubKit Cloud, see \"Use SubKit Cloud\".\n- Bash and curl.\n- To sign in with an API key on a self-hosted engine: access to the engine host.\n\n### Install and sign in\n\n1. Install the CLI from your engine:\n\n   ```bash\n   curl -fsSL http://localhost:3000/install | bash\n   ```\n\n2. Sign in:\n\n   ```bash\n   sk login --engine-url http://localhost:3000\n   ```\n\n   Your browser opens. After you sign in, `sk` prints `sk: signed in as …` and saves the connection as a profile.\n3. Run `sk`. Without a command it opens an interactive session; `sk --help` lists every command.\n\nThe engine also describes itself: the HTTP API at `/openapi.json`, the documentation for AI clients at `/llms.txt`.\n\n### Sign in with an API key\n\nUse this for scripts, or for a self-hosted engine without an identity provider.\n\n1. On the engine host, issue an admin key. The command prints a ready `sk login` line:\n\n   ```bash\n   docker compose exec engine engine --issue-admin-key --tenant my-org\n   ```\n\n2. Run the printed line. It has this form:\n\n   ```bash\n   sk login --engine-url http://localhost:3000 --api-key <key>\n   ```\n\n   `sk` replies with `sk: profile 'default' saved` and the engine health.\n\n### Work with several engines\n\nA profile is a saved sign-in to one engine. It lets you work with a test and a production engine, or with several workspaces, without signing in again.\nProfiles live in `~/.sk/config.json`.\n\n| Command | What it does |\n| --- | --- |\n| `sk login --engine-url <address> --profile <name>` | Adds another profile. |\n| `sk profile list` | Shows all profiles. |\n| `sk profile use <name>` | Switches the active profile. |\n| `sk status` | Shows the active profile and whether the engine is reachable. |\n| `sk profile delete <name>` | Deletes a profile. |\n\nFor a single command, add `--profile <name>` without switching the active profile.\n\n### Update the CLI\n\n`sk update` installs the newest version, `sk update --check` only reports it.\n`sk` fetches the version from the engine of your active profile first and only then from the public releases. You need no GitHub access for this.\nBefore replacing anything, `sk` verifies the signed checksums. If a file does not match, your current installation stays as it is.\n\nThe previous version is kept. `sk update --rollback` restores it.\n\n### What the installers check\n\nEach installer checks the files before it replaces an existing installation.\nMissing license files, missing signatures or unsupported cryptography stop the installation.\n\n| Installer | What it checks | What it trusts |\n| --- | --- | --- |\n| `/install` from the engine | The binary, `LICENSE` and `THIRD_PARTY_NOTICES.txt` against the checksum manifest of the engine or of an explicitly chosen mirror | The engine or mirror you chose, not a release signature |\n| `sk update` | The signed checksum manifest of the release, then the binary and both license files | The pinned public release key, whether the files come from your engine or from GitHub |\n| `scripts/install.sh` | The signed checksum manifest, then the binary and both license files | The pinned public release key |\n\n### Install from a public release\n\nInstead of your engine, you can also install `sk` from a signed public release.\nThe public beta is in preparation. Packages and the guide follow once released.\n\nOnce a release is published, check it out, review it and run `bash scripts/install.sh` in the checkout.\nFor this you also need OpenSSL with Ed25519 support on your PATH, for example OpenSSL 3.\nThe script installs the matching CLI for Linux or macOS and puts `subkit.LICENSE` and `subkit.THIRD_PARTY_NOTICES.txt` next to it.\nA local build or a private repository is not enough.\n\n### Move your workspace to another engine\n\nA package carries your own workflows, connectors, connector templates, skills, schedules, sources and their files to another engine.\nCredentials, approvals, roles, categories, settings and the history stay behind.\nTo copy a whole self-hosted installation, make a backup instead, as described in \"Run the engine\".\n\nYou need `package:export` on the source engine and `package:import` on the target engine. Both are administrator permissions.\n\n1. Sign in to both engines, each with its own profile:\n\n   ```bash\n   sk login --engine-url https://<engine-a> --profile a\n   sk login --engine-url https://<engine-b> --profile b\n   ```\n\n2. Export from engine A:\n\n   ```bash\n   sk packages export --out workspace.zip --profile a\n   ```\n\n   `--category <categories>` exports one area only, for example `--category devops,cloud`. Whatever the area needs comes along: connectors, connector templates, sub-workflows and schedules.\n   `--only <kinds>` exports only some kinds. `--json` prints the result as JSON.\n3. Import into engine B:\n\n   ```bash\n   sk packages import workspace.zip --profile b\n   ```\n\n   `sk` first shows the plan: each item is `create`, `update`, `unchanged` or `conflict`. Confirm it, or pass `--yes`.\n   If engine B changed after the plan, the import stops and changes nothing. Then run it again.\n4. Finish on engine B. Nothing runs or writes until you do:\n   - Enter the credentials of each connector. The package contains none.\n   - Activate the skills. They arrive as drafts.\n   - Confirm the knowledge in the Cockpit review. It arrives as a proposal and is never admitted automatically.\n   - Review the workflows and grant their approvals. They arrive as inactive drafts.\n   - Resume the schedules. They arrive paused.\n   - Start a test run.\n\nImporting the same package again shows every item as `unchanged`.\nAn item you changed on engine B shows as `conflict` and is never overwritten.\n`sk packages installs` lists past imports.\n\nYou can move area by area: one package per category, each with its preview, setup and test run.\nA connector that an earlier package already brought stays `unchanged`, even after you stored its credentials on engine B.\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| `sk: browser login failed` | The browser sign-in did not complete. Try again, or follow \"Sign in with an API key\". |\n| `sk login` cannot reach the engine | Check the `--engine-url`. Give the address without a path. |\n| A command lands on the wrong engine | Check the active profile with `sk status` and switch with `sk profile use <name>`. |\n| `sk update` only asks GitHub or wants a GitHub token | Your CLI predates updating through the engine. Reinstall it once as in \"Install and sign in\". Updates then run through your engine. |\n| `scripts/install.sh` stops with a missing license file or signature | Use a published public release. A local build or a private repository does not work. |\n| `scripts/install.sh` stops because of unsupported cryptography | Put OpenSSL with Ed25519 support, for example OpenSSL 3, on your PATH. |"
        },
        "de": {
          "title": "Die sk-CLI auf deinem Rechner verwenden",
          "summary": "Hol dir die sk-CLI von deiner Engine und arbeite im Terminal.",
          "headings": [
            {
              "depth": 2,
              "text": "Die sk-CLI auf deinem Rechner verwenden",
              "anchor": "die-sk-cli-auf-deinem-rechner-verwenden"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Installieren und anmelden",
              "anchor": "installieren-und-anmelden"
            },
            {
              "depth": 3,
              "text": "Mit einem API-Schlüssel anmelden",
              "anchor": "mit-einem-api-schlüssel-anmelden"
            },
            {
              "depth": 3,
              "text": "Mit mehreren Engines arbeiten",
              "anchor": "mit-mehreren-engines-arbeiten"
            },
            {
              "depth": 3,
              "text": "Die CLI aktualisieren",
              "anchor": "die-cli-aktualisieren"
            },
            {
              "depth": 3,
              "text": "Was die Installer prüfen",
              "anchor": "was-die-installer-prüfen"
            },
            {
              "depth": 3,
              "text": "Aus einem öffentlichen Release installieren",
              "anchor": "aus-einem-öffentlichen-release-installieren"
            },
            {
              "depth": 3,
              "text": "Den Arbeitsbereich auf eine andere Engine umziehen",
              "anchor": "den-arbeitsbereich-auf-eine-andere-engine-umziehen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [],
          "sha256": "1f3a36322edbc6214312d3cb81308ab252ae6b4bcc5af8965a74d707761d7b41",
          "body": "## Die sk-CLI auf deinem Rechner verwenden\n\nDieses Kapitel ist für alle, die lieber im Terminal oder in Skripten arbeiten als im Cockpit.\nDu installierst die Kommandozeile `sk`, meldest dich an und hältst sie aktuell.\nDanach legst du Workflows, Konnektoren und Wissen als Dateien an und startest Läufe aus dem Terminal.\n\nDie Kommandozeile `sk` bekommst du direkt von deiner Engine. Mit ihr entwirfst, änderst und startest du Workflows als Dateien; `sk agent init` trägt SubKit in Claude Code und Codex ein.\nEin npm-Paket gibt es nicht.\n\n### Was du brauchst\n\n- Die Adresse deiner Engine, ohne Pfad. Die Beispiele nutzen `http://localhost:3000`.\n  Für SubKit Cloud siehe „SubKit Cloud nutzen“.\n- Bash und curl.\n- Für die Anmeldung mit API-Schlüssel auf einer selbst betriebenen Engine: Zugriff auf den Engine-Host.\n\n### Installieren und anmelden\n\n1. Installiere die CLI von deiner Engine:\n\n   ```bash\n   curl -fsSL http://localhost:3000/install | bash\n   ```\n\n2. Melde dich an:\n\n   ```bash\n   sk login --engine-url http://localhost:3000\n   ```\n\n   Dein Browser öffnet sich. Nach der Anmeldung gibt `sk` die Zeile `sk: signed in as …` aus und speichert die Verbindung als Profil.\n3. Starte `sk`. Ohne Befehl öffnet sich eine interaktive Sitzung; `sk --help` listet alle Befehle.\n\nDie Engine beschreibt sich auch selbst: die HTTP-API unter `/openapi.json`, die Dokumentation für KI-Clients unter `/llms.txt`.\n\n### Mit einem API-Schlüssel anmelden\n\nDiesen Weg nimmst du für Skripte oder für eine selbst betriebene Engine ohne Anmeldeanbieter.\n\n1. Erstelle auf dem Engine-Host einen Admin-Schlüssel. Der Befehl gibt eine fertige `sk login`-Zeile aus:\n\n   ```bash\n   docker compose exec engine engine --issue-admin-key --tenant my-org\n   ```\n\n2. Führe die ausgegebene Zeile aus. Sie hat diese Form:\n\n   ```bash\n   sk login --engine-url http://localhost:3000 --api-key <key>\n   ```\n\n   `sk` antwortet mit `sk: profile 'default' saved` und dem Zustand der Engine.\n\n### Mit mehreren Engines arbeiten\n\nEin Profil ist eine gespeicherte Anmeldung an einer Engine. So arbeitest du mit Test- und Produktions-Engine oder mit mehreren Arbeitsbereichen, ohne dich neu anzumelden.\nDie Profile liegen in `~/.sk/config.json`.\n\n| Befehl | Was er tut |\n| --- | --- |\n| `sk login --engine-url <adresse> --profile <name>` | Legt ein weiteres Profil an. |\n| `sk profile list` | Zeigt alle Profile. |\n| `sk profile use <name>` | Wechselt das aktive Profil. |\n| `sk status` | Zeigt das aktive Profil und ob die Engine erreichbar ist. |\n| `sk profile delete <name>` | Löscht ein Profil. |\n\nFür einen einzelnen Befehl hängst du `--profile <name>` an, ohne das aktive Profil zu wechseln.\n\n### Die CLI aktualisieren\n\n`sk update` installiert die neueste Fassung, `sk update --check` meldet sie nur.\n`sk` holt die Fassung zuerst von der Engine deines aktiven Profils und erst danach aus den öffentlichen Releases. Ein GitHub-Zugang ist dafür nicht nötig.\nVor dem Austausch prüft `sk` die signierten Prüfsummen. Passt eine Datei nicht, bleibt deine bisherige Installation unverändert.\n\nDie vorherige Fassung bleibt erhalten. `sk update --rollback` stellt sie wieder her.\n\n### Was die Installer prüfen\n\nJeder Installer prüft die Dateien, bevor er eine bestehende Installation ersetzt.\nFehlende Lizenzdateien, fehlende Signaturen oder nicht unterstützte Kryptografie brechen die Installation ab.\n\n| Installer | Was er prüft | Wem er vertraut |\n| --- | --- | --- |\n| `/install` von der Engine | Binärdatei, `LICENSE` und `THIRD_PARTY_NOTICES.txt` gegen das Prüfsummen-Manifest der Engine oder eines ausdrücklich gewählten Mirrors | Der gewählten Engine oder dem Mirror, nicht einer Release-Signatur |\n| `sk update` | Das signierte Prüfsummen-Manifest des Releases, danach Binärdatei und beide Lizenzdateien | Dem festen öffentlichen Release-Schlüssel, egal ob die Dateien von deiner Engine oder von GitHub kommen |\n| `scripts/install.sh` | Das signierte Prüfsummen-Manifest, danach Binärdatei und beide Lizenzdateien | Dem festen öffentlichen Release-Schlüssel |\n\n### Aus einem öffentlichen Release installieren\n\nStatt von deiner Engine kannst du `sk` auch aus einem signierten öffentlichen Release installieren.\nDie öffentliche Beta wird vorbereitet. Pakete und Anleitung folgen nach der Freigabe.\n\nSobald ein Release veröffentlicht ist, checkst du es aus, prüfst es und führst im Checkout `bash scripts/install.sh` aus.\nDafür brauchst du zusätzlich OpenSSL mit Ed25519-Unterstützung im PATH, zum Beispiel OpenSSL 3.\nDas Skript installiert die passende CLI für Linux oder macOS und legt `subkit.LICENSE` und `subkit.THIRD_PARTY_NOTICES.txt` daneben.\nEin lokaler Build oder ein privates Repository genügt nicht.\n\n### Den Arbeitsbereich auf eine andere Engine umziehen\n\nEin Paket bringt deine eigenen Workflows, Konnektoren, Konnektor-Vorlagen, Skills, Zeitpläne, Quellen und ihre Dateien auf eine andere Engine.\nZugangsdaten, Freigaben, Rollen, Kategorien, Einstellungen und der Verlauf bleiben zurück.\nUm eine ganze selbst betriebene Installation zu kopieren, machst du stattdessen ein Backup wie in „Die Engine betreiben“ beschrieben.\n\nDu brauchst `package:export` auf der Quell-Engine und `package:import` auf der Ziel-Engine. Beides sind Administrationsrechte.\n\n1. Melde dich bei beiden Engines an, jeweils mit einem eigenen Profil:\n\n   ```bash\n   sk login --engine-url https://<engine-a> --profile a\n   sk login --engine-url https://<engine-b> --profile b\n   ```\n\n2. Exportiere aus Engine A:\n\n   ```bash\n   sk packages export --out workspace.zip --profile a\n   ```\n\n   `--category <kategorien>` exportiert nur einen Bereich, zum Beispiel `--category devops,cloud`. Was der Bereich braucht, kommt mit: Konnektoren, Konnektor-Vorlagen, Sub-Workflows und Zeitpläne.\n   `--only <arten>` exportiert nur einige Arten. `--json` gibt das Ergebnis als JSON aus.\n3. Importiere in Engine B:\n\n   ```bash\n   sk packages import workspace.zip --profile b\n   ```\n\n   `sk` zeigt zuerst den Plan: Jeder Eintrag ist `create`, `update`, `unchanged` oder `conflict`. Bestätige ihn oder gib `--yes` mit.\n   Hat sich Engine B nach dem Plan geändert, bricht der Import ab und ändert nichts. Starte ihn dann erneut.\n4. Schließe auf Engine B ab. Bis dahin läuft und schreibt nichts:\n   - Hinterlege die Zugangsdaten jedes Konnektors. Das Paket enthält keine.\n   - Aktiviere die Skills. Sie kommen als Entwürfe an.\n   - Bestätige das Wissen in der Prüfung im Cockpit. Es kommt als Vorschlag an und wird nie automatisch übernommen.\n   - Prüfe die Workflows und erteile ihre Freigaben. Sie kommen als inaktive Entwürfe an.\n   - Setze die Zeitpläne fort. Sie kommen pausiert an.\n   - Starte einen Testlauf.\n\nImportierst du dasselbe Paket erneut, ist jeder Eintrag `unchanged`.\nEinen Eintrag, den du auf Engine B geändert hast, zeigt der Import als `conflict` und überschreibt ihn nie.\n`sk packages installs` listet frühere Importe.\n\nDu kannst Bereich für Bereich umziehen: ein Paket je Kategorie, jeweils mit Vorschau, Einrichtung und Testlauf.\nEin Konnektor, den ein früheres Paket schon mitgebracht hat, bleibt `unchanged`, auch wenn du auf Engine B schon seine Zugangsdaten hinterlegt hast.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| `sk: browser login failed` | Die Anmeldung im Browser ist nicht abgeschlossen. Versuche es erneut oder folge „Mit einem API-Schlüssel anmelden“. |\n| `sk login` erreicht die Engine nicht | Prüfe die `--engine-url`. Gib die Adresse ohne Pfad an. |\n| Ein Befehl landet auf der falschen Engine | Prüfe mit `sk status` das aktive Profil und wechsle mit `sk profile use <name>`. |\n| `sk update` fragt nur GitHub oder verlangt ein GitHub-Token | Deine CLI ist älter als der Update-Weg über die Engine. Installiere sie einmal neu wie unter „Installieren und anmelden“. Danach laufen Updates über deine Engine. |\n| `scripts/install.sh` bricht wegen einer fehlenden Lizenzdatei oder Signatur ab | Nutze ein veröffentlichtes öffentliches Release. Ein lokaler Build oder ein privates Repository funktioniert nicht. |\n| `scripts/install.sh` bricht wegen nicht unterstützter Kryptografie ab | Stelle OpenSSL mit Ed25519-Unterstützung, zum Beispiel OpenSSL 3, in den PATH. |"
        }
      }
    },
    {
      "slug": "mcp-clients",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 2,
      "generated": false,
      "locales": {
        "en": {
          "title": "Connect AI clients via MCP",
          "summary": "Let an AI client such as Claude Code find and run your workflows.",
          "headings": [
            {
              "depth": 2,
              "text": "Connect AI clients via MCP",
              "anchor": "connect-ai-clients-via-mcp"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Choose how to sign in",
              "anchor": "choose-how-to-sign-in"
            },
            {
              "depth": 3,
              "text": "Connect with browser sign-in",
              "anchor": "connect-with-browser-sign-in"
            },
            {
              "depth": 3,
              "text": "Connect with an API key",
              "anchor": "connect-with-an-api-key"
            },
            {
              "depth": 3,
              "text": "Check the connection",
              "anchor": "check-the-connection"
            },
            {
              "depth": 3,
              "text": "What the client may do",
              "anchor": "what-the-client-may-do"
            },
            {
              "depth": 3,
              "text": "Read, run, write",
              "anchor": "read-run-write"
            },
            {
              "depth": 3,
              "text": "Use an MCP server as a connector",
              "anchor": "use-an-mcp-server-as-a-connector"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [],
          "sha256": "a8d58e5c2934d4f37f525f8b2e4623569d640b091800312907fc9242530a9f48",
          "body": "## Connect AI clients via MCP\n\nThis chapter is for anyone who wants to use SubKit from an AI client such as Claude, ChatGPT, Cursor or Codex.\nYou register your engine there once as a server and sign in.\nAfterwards the client finds and runs your workflows, with your permissions and with an entry in the history.\n\nFor Claude Code, Codex, Cursor and other AI clients, SubKit is an MCP server: every approved workflow is a tool there, plus connectors, knowledge and skills – with the permissions of the access, nothing beyond. Anything that writes waits for a person to choose \"Allow once\". The other way round, an MCP server you already use becomes a connector in SubKit; the operator decides per tool which of its tools run without asking.\n\n### What you need\n\n- The MCP address of your engine. Every engine has exactly one:\n\n  ```text\n  https://<your-engine>/mcp\n  ```\n\n  On SubKit Cloud it is `https://subkit-cloud.mikebild.info/mcp`, always without `/cockpit`.\n  Your own engine needs HTTPS. Plain HTTP works only on `localhost`.\n- An account whose role allows MCP access. Without it, the sign-in ends with `access_denied`.\n- An AI client that supports remote MCP servers over HTTP. If it can only start local servers, see \"Connect with an API key\".\n\n### Choose how to sign in\n\n| Way | When | What you do |\n| --- | --- | --- |\n| **Browser sign-in (OAuth)** | SubKit Cloud and engines with an identity provider | Enter the address. The client opens your browser, where you sign in and consent. In the cloud, select **Sign in with work account**. |\n| **API key** | Clients that use a key, and engines without an identity provider | Enter a key in the client as a bearer token. |\n\nUse the browser sign-in when you can. You copy no key, a consent page shows what the client may do, and the access renews itself.\nAn API key, by contrast, is long-lived access that sits on your machine.\n\n### Connect with browser sign-in\n\n1. In your client, add a remote MCP server with the address `https://<your-engine>/mcp` and name it `sk`.\n2. In the browser window the client opens, sign in the same way as in the Cockpit.\n3. On the page **Allow access**, check which client wants access to which workspace.\n4. Check the boxes for what the client may do. **Read** is always on.\n5. Select **Allow**. The browser returns to your client.\n\nWhere you add the server depends on the client:\n\n- **claude.ai:** the settings for connectors. Add a custom connector with the address.\n- **Claude Code:**\n\n  ```bash\n  claude mcp add --transport http --scope user sk https://<your-engine>/mcp\n  ```\n\n  Then run `/mcp` in Claude Code and select `sk` to sign in.\n- **ChatGPT and Cursor:** the client's MCP or connector settings.\n\nMenu names change between client versions. If a step looks different, follow your client's guide for remote MCP servers.\n\n### Connect with an API key\n\n1. In the Cockpit, open **API access** and create a key. The **Run** preset fits most clients.\n2. Store the key in an environment variable, not in a file you share:\n\n   ```bash\n   export SK_API_KEY=<your-key>\n   ```\n\n3. Register the server in your client with the matching command.\n\nClaude Code:\n\n```bash\nclaude mcp add --transport http --scope user sk https://<your-engine>/mcp --header \"Authorization: Bearer ${SK_API_KEY}\"\n```\n\nCodex:\n\n```bash\ncodex mcp add sk --url https://<your-engine>/mcp --bearer-token-env-var SK_API_KEY\n```\n\nOther clients send the header `Authorization: Bearer <your-key>` with every request.\n\nIf your client can only start local MCP servers, there is the command `sk mcp`. It uses your signed-in `sk` profile but offers only five tools: a connection check and four tools for conversations with SubKit. Your client reaches workflows, connectors and knowledge only through your engine's `/mcp` address.\n\nA key without an MCP scope connects in **Read** mode.\nIf the client should also build, add `mcp:authoring` to `--scopes` when you create the key with `sk apikeys create`.\n\n### Check the connection\n\n1. Check that the engine answers:\n\n   ```bash\n   curl https://<your-engine>/.well-known/oauth-protected-resource\n   ```\n\n   The answer names the MCP address and the scopes it offers:\n\n   ```json\n   {\n     \"resource\": \"https://<your-engine>/mcp\",\n     \"authorization_servers\": [\"https://<your-engine>\"],\n     \"scopes_supported\": [\"mcp:read\", \"mcp:authoring\", \"mcp:admin\", \"metrics:read\"]\n   }\n   ```\n\n2. In your client, ask: \"Call the SubKit tool whoami.\" The answer names your account, your workspace and your scopes.\n3. Ask: \"Find a workflow in SubKit.\" The client calls `find_workflow` and lists what it finds.\n\nIf all three work, the client is connected.\n\n### What the client may do\n\nA scope is the level you give the client when it connects. It decides which tools the client sees at all.\nYour role still limits every single call. A scope never gives the client more than you may do yourself.\n\n| On the access page | Scope | The client can |\n| --- | --- | --- |\n| **Read** | `mcp:read` | Read workflows, runs, connectors and knowledge, and run saved workflows. |\n| **Authoring** | `mcp:authoring` | Additionally build workflows and connectors in a guided conversation. |\n| **Administration** | `mcp:admin` | Additionally create, change and delete things in the workspace. |\n| **Operational counters** | `metrics:read` | Read the operational counters, nothing else. |\n\n- The access page only offers what your role allows.\n- A key with `*` does not include authoring. That takes a deliberate `mcp:authoring`.\n- An engine with `mcp.read_only` hides every write tool, even with `mcp:admin`.\n\n### Read, run, write\n\n- **Reads** run right away. Examples: `find_workflow`, `get_execution`, `search_knowledge`.\n- **Runs** start a saved workflow, for example with `run_workflow` or a `wf_<slug>` tool.\n  A short run answers right away. A long run answers with an `execution_id` that the client follows with `get_execution`.\n- **Writes** change something: send an email, change data, change the workspace.\n- **Packages** move your workspace's own resources to another engine with `export_tenant_package`, `preview_package_import` and `apply_package_import`.\n  They ask for confirmation first. An import only creates drafts and proposals.\n\nWriting always needs a person, in two places:\n\n- **Writes inside a workflow:** A workflow writes for real only after a person approves it in the Cockpit. Without approval the run is a dry run: writes are held back and nothing is sent.\n  A new version needs no new approval as long as it touches no more systems, addresses or write permissions than the approved one. If it reaches further, SubKit asks again and names the difference.\n- **Write tools in the client:** A write tool pauses and returns a link.\n  Open it, sign in, check what will happen, and select **Allow once** or **Decline**.\n  Only then can the client finish the call with `confirm_tool_call`.\n\nThe AI cannot approve or allow anything itself. The link alone allows nothing either.\n\n### Use an MCP server as a connector\n\nThe other direction: an MCP server your team already uses becomes a connector in SubKit. Workflows and the chat then call its tools.\nEach tool asks before it runs, unless the operator has enabled it individually. Only someone allowed to change the connector can do that; a normal edit of the connector does not change this list.\n`sk connectors mcp-inspect <id>` shows which tools the server actually offers. If the server needs OAuth client credentials, follow \"External MCP OAuth credentials\".\n\n### If something does not work\n\nThe engine returns these messages in English; they are quoted verbatim here.\n\n| What you see | What to do |\n| --- | --- |\n| `401` with `missing_or_invalid_credentials` | Sign in again, or check the key and the `Authorization` header. |\n| Sign-in ends with `access_denied` | Your role has no MCP permission. Ask an administrator for a role with MCP access. |\n| `403` \"Forbidden: invalid Origin header\" | The request came from a foreign web page. Connect from the client, not from a web page, and use the engine's own address. |\n| `403` `product_caller_forbidden` | The token belongs to an app user and has no MCP access. Use a person's sign-in or key. |\n| `400` \"Unsupported protocol version\" | The client speaks an MCP version the engine does not know. Update the client. |\n| `404` \"Session not found\" | The session expired, for example after an engine restart. Reconnect the server in the client. |\n| Authoring tools are missing | The access has no `mcp:authoring`. Sign in again and check **Authoring**, or author with the sk CLI. |\n| New tools are missing after an update | claude.ai keeps its old tool list. Remove the connector and add it again. |"
        },
        "de": {
          "title": "KI-Clients per MCP anbinden",
          "summary": "Lass einen KI-Client wie Claude Code deine Workflows finden und starten.",
          "headings": [
            {
              "depth": 2,
              "text": "KI-Clients per MCP anbinden",
              "anchor": "ki-clients-per-mcp-anbinden"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Anmeldung wählen",
              "anchor": "anmeldung-wählen"
            },
            {
              "depth": 3,
              "text": "Mit Browser-Anmeldung verbinden",
              "anchor": "mit-browser-anmeldung-verbinden"
            },
            {
              "depth": 3,
              "text": "Mit API-Schlüssel verbinden",
              "anchor": "mit-api-schlüssel-verbinden"
            },
            {
              "depth": 3,
              "text": "Die Verbindung prüfen",
              "anchor": "die-verbindung-prüfen"
            },
            {
              "depth": 3,
              "text": "Was der Client darf",
              "anchor": "was-der-client-darf"
            },
            {
              "depth": 3,
              "text": "Lesen, ausführen, schreiben",
              "anchor": "lesen-ausführen-schreiben"
            },
            {
              "depth": 3,
              "text": "MCP-Server als Konnektor nutzen",
              "anchor": "mcp-server-als-konnektor-nutzen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [],
          "sha256": "1cd4f6223cfd8c5e656c9de051e8319b92e8f8f38f28051380a1a040d2467820",
          "body": "## KI-Clients per MCP anbinden\n\nDieses Kapitel ist für alle, die SubKit aus einem KI-Client wie Claude, ChatGPT, Cursor oder Codex heraus nutzen wollen.\nDu trägst deine Engine dort einmal als Server ein und meldest dich an.\nDanach findet und startet der Client deine Workflows, mit deinen Rechten und mit einem Eintrag im Verlauf.\n\nSubKit ist für Claude Code, Codex, Cursor und andere KI-Clients ein MCP-Server: Jeder freigegebene Workflow ist dort ein Tool, dazu Konnektoren, Wissen und Skills – mit den Rechten des Zugangs, keinem darüber hinaus. Was schreibt, wartet auf ein „Einmal erlauben“ einer Person. Umgekehrt wird ein MCP-Server, den ihr schon nutzt, in SubKit ein Konnektor; welche seiner Tools ohne Rückfrage laufen, legt der Betreiber je Tool fest.\n\n### Was du brauchst\n\n- Die MCP-Adresse deiner Engine. Jede Engine hat genau eine:\n\n  ```text\n  https://<deine-engine>/mcp\n  ```\n\n  In SubKit Cloud ist das `https://subkit-cloud.mikebild.info/mcp`, immer ohne `/cockpit`.\n  Deine eigene Engine braucht HTTPS. Reines HTTP geht nur auf `localhost`.\n- Ein Konto, dessen Rolle MCP-Zugriff erlaubt. Ohne dieses Recht endet die Anmeldung mit `access_denied`.\n- Einen KI-Client, der entfernte MCP-Server über HTTP unterstützt. Kann er nur lokale Server starten, siehe „Mit API-Schlüssel verbinden“.\n\n### Anmeldung wählen\n\n| Weg | Wann | Was du tust |\n| --- | --- | --- |\n| **Browser-Anmeldung (OAuth)** | SubKit Cloud und Engines mit Anmeldeanbieter | Adresse eintragen. Der Client öffnet deinen Browser, dort meldest du dich an und stimmst zu. In der Cloud wählst du **Mit Firmenkonto anmelden**. |\n| **API-Schlüssel** | Clients, die einen Schlüssel nutzen, und Engines ohne Anmeldeanbieter | Einen Schlüssel als Bearer-Token in den Client eintragen. |\n\nNimm die Browser-Anmeldung, wenn du kannst. Du kopierst keinen Schlüssel, siehst auf einer Zustimmungsseite, was der Client darf, und der Zugang erneuert sich selbst.\nEin API-Schlüssel dagegen ist ein langlebiger Zugang, der auf deinem Rechner liegt.\n\n### Mit Browser-Anmeldung verbinden\n\n1. Füge in deinem Client einen entfernten MCP-Server mit der Adresse `https://<deine-engine>/mcp` hinzu und nenne ihn `sk`.\n2. Melde dich in dem Browserfenster, das der Client öffnet, so an wie im Cockpit.\n3. Prüfe auf der Seite **Zugriff erlauben**, welcher Client auf welchen Arbeitsbereich zugreifen will.\n4. Hake an, was der Client darf. **Lesen** ist immer an.\n5. Wähle **Erlauben**. Der Browser kehrt zu deinem Client zurück.\n\nWo du den Server einträgst, hängt vom Client ab:\n\n- **claude.ai:** in den Einstellungen für Konnektoren. Füge einen eigenen Konnektor mit der Adresse hinzu.\n- **Claude Code:**\n\n  ```bash\n  claude mcp add --transport http --scope user sk https://<deine-engine>/mcp\n  ```\n\n  Führe danach in Claude Code `/mcp` aus und wähle `sk`, um dich anzumelden.\n- **ChatGPT und Cursor:** in den MCP- oder Konnektor-Einstellungen des Clients.\n\nMenünamen ändern sich zwischen Client-Versionen. Sieht ein Schritt anders aus, folge der Anleitung deines Clients für entfernte MCP-Server.\n\n### Mit API-Schlüssel verbinden\n\n1. Öffne im Cockpit **API-Zugang** und erstelle einen Schlüssel. Die Vorlage **Ausführen** passt für die meisten Clients.\n2. Lege den Schlüssel in einer Umgebungsvariable ab, nicht in einer Datei, die du teilst:\n\n   ```bash\n   export SK_API_KEY=<dein-schluessel>\n   ```\n\n3. Trage den Server mit dem passenden Befehl in deinem Client ein.\n\nClaude Code:\n\n```bash\nclaude mcp add --transport http --scope user sk https://<deine-engine>/mcp --header \"Authorization: Bearer ${SK_API_KEY}\"\n```\n\nCodex:\n\n```bash\ncodex mcp add sk --url https://<deine-engine>/mcp --bearer-token-env-var SK_API_KEY\n```\n\nAndere Clients schicken bei jeder Anfrage den Header `Authorization: Bearer <dein-schluessel>` mit.\n\nKann dein Client nur lokale MCP-Server starten, gibt es den Befehl `sk mcp`. Er nutzt dein angemeldetes `sk`-Profil, bietet aber nur fünf Tools: einen Verbindungstest und vier Tools für Unterhaltungen mit SubKit. Workflows, Konnektoren und Wissen erreicht dein Client nur über die Adresse `/mcp` deiner Engine.\n\nEin Schlüssel ohne MCP-Scope verbindet im Modus **Lesen**.\nSoll der Client auch bauen dürfen, ergänzt du `mcp:authoring` in `--scopes`, wenn du den Schlüssel mit `sk apikeys create` anlegst.\n\n### Die Verbindung prüfen\n\n1. Prüfe, ob die Engine antwortet:\n\n   ```bash\n   curl https://<deine-engine>/.well-known/oauth-protected-resource\n   ```\n\n   Die Antwort nennt die MCP-Adresse und die angebotenen Scopes:\n\n   ```json\n   {\n     \"resource\": \"https://<deine-engine>/mcp\",\n     \"authorization_servers\": [\"https://<deine-engine>\"],\n     \"scopes_supported\": [\"mcp:read\", \"mcp:authoring\", \"mcp:admin\", \"metrics:read\"]\n   }\n   ```\n\n2. Bitte deinen Client: „Ruf das SubKit-Tool whoami auf.“ Die Antwort nennt dein Konto, deinen Arbeitsbereich und deine Scopes.\n3. Bitte: „Such einen Workflow in SubKit.“ Der Client ruft `find_workflow` auf und listet die Treffer.\n\nKlappen alle drei, ist der Client verbunden.\n\n### Was der Client darf\n\nEin Scope ist die Stufe, die du dem Client beim Verbinden gibst. Er bestimmt, welche Tools der Client überhaupt sieht.\nDeine Rolle begrenzt trotzdem jeden einzelnen Aufruf. Ein Scope gibt dem Client nie mehr, als du selbst darfst.\n\n| Auf der Zugriffsseite | Scope | Der Client kann |\n| --- | --- | --- |\n| **Lesen** | `mcp:read` | Workflows, Läufe, Konnektoren und Wissen lesen und gespeicherte Workflows starten. |\n| **Bearbeiten** | `mcp:authoring` | Zusätzlich Workflows und Konnektoren in einer geführten Unterhaltung bauen. |\n| **Verwalten** | `mcp:admin` | Zusätzlich im Arbeitsbereich anlegen, ändern und löschen. |\n| **Betriebszähler** | `metrics:read` | Die Betriebszähler lesen, sonst nichts. |\n\n- Die Zugriffsseite bietet nur an, was deine Rolle erlaubt.\n- Ein Schlüssel mit `*` enthält kein Bearbeiten. Dafür braucht es bewusst `mcp:authoring`.\n- Eine Engine mit `mcp.read_only` blendet alle schreibenden Tools aus, auch mit `mcp:admin`.\n\n### Lesen, ausführen, schreiben\n\n- **Lesen** läuft sofort. Beispiele: `find_workflow`, `get_execution`, `search_knowledge`.\n- **Ausführen** startet einen gespeicherten Workflow, etwa mit `run_workflow` oder einem `wf_<slug>`-Tool.\n  Ein kurzer Lauf antwortet sofort. Ein langer Lauf antwortet mit einer `execution_id`, die der Client mit `get_execution` verfolgt.\n- **Schreiben** verändert etwas: eine E-Mail senden, Daten ändern, den Arbeitsbereich ändern.\n- **Pakete** bringen die eigenen Ressourcen deines Arbeitsbereichs mit `export_tenant_package`, `preview_package_import` und `apply_package_import` auf eine andere Engine.\n  Sie fragen vorher nach einer Bestätigung. Ein Import legt nur Entwürfe und Vorschläge an.\n\nSchreiben braucht immer einen Menschen, und zwar an zwei Stellen:\n\n- **Schreiben in einem Workflow:** Ein Workflow schreibt erst wirklich, wenn eine Person ihn im Cockpit freigegeben hat. Ohne Freigabe ist der Lauf ein Probelauf: Schreibzugriffe werden zurückgehalten, nichts wird gesendet.\n  Eine neue Version braucht keine neue Freigabe, solange sie nicht mehr Systeme, Adressen oder Schreibrechte anfasst als die freigegebene. Greift sie weiter, fragt SubKit erneut und nennt den Unterschied.\n- **Schreibende Tools im Client:** Ein schreibendes Tool hält an und liefert einen Link.\n  Öffne ihn, melde dich an, prüfe, was passieren wird, und wähle **Einmal erlauben** oder **Ablehnen**.\n  Erst danach kann der Client den Aufruf mit `confirm_tool_call` abschließen.\n\nDie KI kann nichts selbst freigeben oder erlauben. Auch der Link allein erlaubt nichts.\n\n### MCP-Server als Konnektor nutzen\n\nDer umgekehrte Weg: Ein MCP-Server, den dein Team schon nutzt, wird in SubKit ein Konnektor. Workflows und der Chat rufen dann seine Tools auf.\nJedes Tool fragt vor dem Lauf nach, es sei denn, der Betreiber hat es einzeln freigeschaltet. Das darf nur, wer den Konnektor ändern darf; eine normale Bearbeitung des Konnektors ändert diese Liste nicht.\n`sk connectors mcp-inspect <id>` zeigt, welche Tools der Server wirklich anbietet. Verlangt der Server OAuth-Zugangsdaten, folge „OAuth-Zugangsdaten für externe MCP-Server“.\n\n### Wenn etwas nicht klappt\n\nDie Engine liefert diese Meldungen auf Englisch; sie stehen hier deshalb wörtlich.\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| `401` mit `missing_or_invalid_credentials` | Melde dich neu an, oder prüfe Schlüssel und `Authorization`-Header. |\n| Anmeldung endet mit `access_denied` | Deine Rolle hat kein MCP-Recht. Bitte eine Administratorin oder einen Administrator um eine Rolle mit MCP-Zugriff. |\n| `403` „Forbidden: invalid Origin header“ | Die Anfrage kam von einer fremden Webseite. Verbinde aus dem Client, nicht aus einer Webseite, und nutze die eigene Adresse der Engine. |\n| `403` `product_caller_forbidden` | Das Token gehört zu einem App-Benutzer und hat keinen MCP-Zugang. Nutze die Anmeldung oder den Schlüssel einer Person. |\n| `400` „Unsupported protocol version“ | Der Client spricht eine MCP-Version, die die Engine nicht kennt. Aktualisiere den Client. |\n| `404` „Session not found“ | Die Sitzung ist abgelaufen, etwa nach einem Engine-Neustart. Verbinde den Server im Client neu. |\n| Tools zum Bearbeiten fehlen | Der Zugang hat kein `mcp:authoring`. Melde dich neu an und hake **Bearbeiten** an, oder arbeite mit der sk-CLI. |\n| Neue Tools fehlen nach einem Update | claude.ai behält seine alte Tool-Liste. Entferne den Konnektor und füge ihn neu hinzu. |"
        }
      }
    },
    {
      "slug": "use-sk-from-a-coding-agent",
      "llms_path": "coding-agents.md",
      "audience": "public",
      "section": "work",
      "order": 3,
      "generated": false,
      "locales": {
        "en": {
          "title": "Use SubKit from a coding agent",
          "summary": "Give Claude Code or Codex SubKit as a tool and your team's knowledge.",
          "headings": [
            {
              "depth": 2,
              "text": "Use SubKit from a coding agent",
              "anchor": "use-subkit-from-a-coding-agent"
            },
            {
              "depth": 3,
              "text": "Why a coding agent plus SubKit",
              "anchor": "why-a-coding-agent-plus-subkit"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Set up the SubKit tools once per machine",
              "anchor": "set-up-the-subkit-tools-once-per-machine"
            },
            {
              "depth": 3,
              "text": "Set up briefings in a repository",
              "anchor": "set-up-briefings-in-a-repository"
            },
            {
              "depth": 3,
              "text": "Set up Hermes by hand",
              "anchor": "set-up-hermes-by-hand"
            },
            {
              "depth": 3,
              "text": "Check the briefing",
              "anchor": "check-the-briefing"
            },
            {
              "depth": 3,
              "text": "Review collected material with your coding agent",
              "anchor": "review-collected-material-with-your-coding-agent"
            },
            {
              "depth": 3,
              "text": "Review collected material in the terminal",
              "anchor": "review-collected-material-in-the-terminal"
            },
            {
              "depth": 3,
              "text": "How briefings work",
              "anchor": "how-briefings-work"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [],
          "sha256": "e2512336466fa7a463b1c5d8c68e468ab9260a1a64b7e4d9889d8d106c94cb29",
          "body": "## Use SubKit from a coding agent\n\nThis chapter is for developers who work with Claude Code, Codex or Hermes.\nYou give your agent the SubKit tools and, for each repository, a briefing from your team's shared knowledge.\nAfterwards the agent runs approved workflows, knows the project's house rules and puts what it learned into your inbox for review.\n\n### Why a coding agent plus SubKit\n\nYour coding agent stays the tool for software: reading, changing and testing code.\nRecurring business work needs more than a script: permissions, approvals, history, schedules and safely stored credentials. SubKit carries that.\nTo the agent, SubKit is a tool: it calls an approved workflow instead of holding credentials itself.\nEvery call goes through the same permission check as in the Cockpit and appears in the history.\n\nCollected material always follows one path: **collect → review with your agent → confirm in the Cockpit → knowledge**.\n\n### What you need\n\n- The sk CLI, signed in to your engine. In the cloud, use `sk login --engine-url https://subkit-cloud.mikebild.info` and **Sign in with work account**. The briefing uses this signed-in profile.\n- The MCP address of your engine, `https://<your-engine>/mcp`. On SubKit Cloud it is `https://subkit-cloud.mikebild.info/mcp`.\n- Claude Code, Codex or Hermes.\n- A repository where the briefings should appear.\n\n### Set up the SubKit tools once per machine\n\n1. In the Cockpit, open **API access** and create a key.\n2. Store the key in `SK_API_KEY`.\n3. Register SubKit in your client with the matching command.\n\nClaude Code:\n\n```bash\nclaude mcp add --transport http --scope user sk https://<your-engine>/mcp --header \"Authorization: Bearer ${SK_API_KEY}\"\n```\n\nCodex:\n\n```bash\ncodex mcp add sk --url https://<your-engine>/mcp --bearer-token-env-var SK_API_KEY\n```\n\nA key without `mcp:authoring` lets the agent read and run workflows but build nothing. If it should draft workflows and connectors, create the key with `sk apikeys create --scopes …,mcp:authoring`.\nTo sign in without a key, see \"Connect AI clients via MCP\".\n\n### Set up briefings in a repository\n\n1. In the repository, declare the domains:\n\n   ```bash\n   sk agent init --domains <category>\n   ```\n\n   For several domains, separate them with commas: `--domains <category>[,<category>]`.\n   The command writes `.sk/agent.json` and adds the SubKit hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`. Other tools' hooks stay in place.\n2. Commit `.sk/agent.json` so every checkout uses the same domains.\n3. In Claude Code or Codex, run `/hooks` and check that the SubKit hooks are active.\n4. Trust new or changed SubKit hooks.\n\n### Set up Hermes by hand\n\nFor Hermes, `sk agent init` sets up no hooks. The command's output shows what you need under \"Hermes (manual)\".\n\n1. In Hermes, register an MCP server over streamable HTTP with the address `https://<your-engine>/mcp`.\n2. Pass the header `Authorization: Bearer ${SK_API_KEY}`.\n3. At the start of a session, run `sk agent briefing` in the repository and hand the output to Hermes as context.\n\n### Check the briefing\n\n1. In the repository, run `sk status`.\n2. Run `sk agent briefing --json`.\n3. Check the fields `domains`, `knowledge_sources`, `skills_full` and `used_tokens`.\n\n### Review collected material with your coding agent\n\nYour agent can start a review of collected entries. You confirm the result in the Cockpit.\n\n1. Ask your agent: \"Review the new entries in Research. Which are useful? Propose what we should keep as knowledge.\"\n2. Open the Cockpit link the agent returns. It leads to the item's **Review** tab.\n3. Check the proposal's sources, exact text and knowledge destination.\n4. Select **Confirm as source**.\n5. Run `sk agent briefing --json` and check `knowledge_sources`.\n\nA new session loads the updated briefing.\n\nGood to know:\n\n- Only a signed-in person with `intake:confirm` and `knowledge:write` confirms a proposal. An API key, an MCP client or the Web Clipper never does.\n- The item's original stays linked to the knowledge it became.\n- Moving, editing or discarding an entry never admits it as knowledge.\n\n### Review collected material in the terminal\n\n| Command | What it does |\n| --- | --- |\n| `sk intake list` | Shows collected items in your default category. |\n| `sk intake list --category research` | Shows collected items of one category. |\n| `sk intake review --category research` | Starts the review and prints the Cockpit link. |\n| `sk intake review --items <comma-separated-ids>` | Reviews only particular entries. |\n| `sk intake default --category research` | Changes your personal default category. |\n| `sk intake move --item <id> --category research` | Moves an entry to a category. |\n| `sk intake discard --item <id>` | Discards an entry. |\n| `sk intake restore --item <id>` | Restores a discarded entry. |\n\n- Without a selection, `review` uses your default category.\n- `--json` returns machine-readable results.\n- These actions preserve the item's original and never admit knowledge.\n\n### How briefings work\n\n**Domains.** A domain is a catalog category or a `domain:<slug>` tag.\n\n- `sk agent init` adds the requested domains and removes nothing that exists.\n- Without `.sk/agent.json`, the hooks match the folder name against your project categories. On a unique match they create `.sk/agent.json` for you. Otherwise they ask instead of guessing.\n- To fix the domains yourself, edit `domains` in `.sk/agent.json` and remove `inferred` and `inferred_folder_domain`.\n- A prompt can add other matching domains as the task changes.\n\n**Hooks.** `init` sets up the SessionStart, UserPromptSubmit and SessionEnd hooks for Claude Code and Codex. `--skip-claude` and `--skip-codex` leave that client's settings untouched.\n\n**Size.** A briefing has at most 1,800 tokens and 9,500 characters, shared by both clients and the interactive sk session.\nWhatever does not fit is shortened, and you see a warning.\n\nA briefing contains:\n\n- Domain context and a short status, with blocked work and deadlines first.\n- Up to three specific next steps in your language.\n- Matching sources and workflows of the folder's domain, named when they help with a task.\n- The number of collected pages and session learnings, never their content. With `intake:read`, also the workspace-wide number of collected entries and pending proposals.\n\n**Session learnings.** At session end, Claude Code and Codex send the transcript to the engine.\n\n- The engine keeps only practices and facts a person taught or confirmed.\n- It drops events, status updates and anything credential-related.\n- The rest lands in the Inbox with origin `session`, in the project's shared category or your default category. A repeated learning adds evidence to the existing entry.\n- Learnings are not knowledge and not skills until a person confirms them in the Cockpit. `sk intake list` shows what is waiting.\n\n**Reviews with an agent.** The review runs in a saved SubKit conversation.\n\n- MCP clients start it with `conversation_start`. `intake_item_ids` selects particular items and keeps that selection fixed.\n- Tools that read entries or prepare proposals work only inside this conversation.\n- For a new destination, include the topic category or `domain:<slug>` tag in the proposal. A changed proposal must be reviewed again.\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| `sk agent briefing: no domains …` | There is no declaration. Pass `--domains` or run `sk agent init --domains <category>`. |\n| `knowledge_sources` or `skills_full` are empty | The briefing works but nothing is assigned to the domain. Put knowledge and skills in the domain's category or use the `domain:<slug>` tag. |\n| The client shows a briefing warning | The engine cannot be reached. The session continues. Check sign-in and connection with `sk status`. |\n| No briefings in Claude Code or Codex | Open `/hooks`, check that the SubKit hooks are active, and trust new or changed hooks. |\n| `/hooks` in Codex shows the SubKit hooks as disabled | Codex hooks are on by default, so no `config.toml` edit is normally needed. Check the effective feature setting and your administrator policy first, then follow the [Codex hooks guide](https://learn.chatgpt.com/docs/hooks). |\n| The agent cannot draft anything | Its key has no `mcp:authoring`. Create a new key with that scope. |\n| The reminder about collected entries is missing | You lack the `intake:read` permission. Ask an administrator for it. |\n| A proposal cannot be confirmed | Only a signed-in person with `intake:confirm` and `knowledge:write` can confirm, not an API key. Open the Cockpit link. |"
        },
        "de": {
          "title": "SubKit aus einem Coding-Agenten verwenden",
          "summary": "Gib Claude Code oder Codex SubKit als Tool und das Wissen deines Teams.",
          "headings": [
            {
              "depth": 2,
              "text": "SubKit aus einem Coding-Agenten verwenden",
              "anchor": "subkit-aus-einem-coding-agenten-verwenden"
            },
            {
              "depth": 3,
              "text": "Warum Coding-Agent und SubKit",
              "anchor": "warum-coding-agent-und-subkit"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Die SubKit-Tools einmal pro Rechner einrichten",
              "anchor": "die-subkit-tools-einmal-pro-rechner-einrichten"
            },
            {
              "depth": 3,
              "text": "Briefings in einem Repository einrichten",
              "anchor": "briefings-in-einem-repository-einrichten"
            },
            {
              "depth": 3,
              "text": "Hermes von Hand einrichten",
              "anchor": "hermes-von-hand-einrichten"
            },
            {
              "depth": 3,
              "text": "Das Briefing prüfen",
              "anchor": "das-briefing-prüfen"
            },
            {
              "depth": 3,
              "text": "Gesammeltes Material mit deinem Coding-Agenten prüfen",
              "anchor": "gesammeltes-material-mit-deinem-coding-agenten-prüfen"
            },
            {
              "depth": 3,
              "text": "Gesammeltes Material im Terminal prüfen",
              "anchor": "gesammeltes-material-im-terminal-prüfen"
            },
            {
              "depth": 3,
              "text": "So funktionieren Briefings",
              "anchor": "so-funktionieren-briefings"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [],
          "sha256": "fcfee0770f895829bc1f30c4dda53180fe1922ea5946680fd027f6ae73cdbfef",
          "body": "## SubKit aus einem Coding-Agenten verwenden\n\nDieses Kapitel ist für Entwicklerinnen und Entwickler, die mit Claude Code, Codex oder Hermes arbeiten.\nDu gibst deinem Agenten die SubKit-Tools und für jedes Repository ein Briefing aus dem gemeinsamen Wissen deines Teams.\nDanach startet der Agent freigegebene Workflows, kennt die Hausregeln des Projekts und legt Gelerntes zur Prüfung in deine Inbox.\n\n### Warum Coding-Agent und SubKit\n\nDein Coding-Agent bleibt das Werkzeug für Software: Code lesen, ändern, testen.\nWiederkehrende Geschäftsarbeit braucht mehr als ein Skript, nämlich Rechte, Freigaben, Verlauf, Zeitpläne und sicher verwahrte Zugangsdaten. Das trägt SubKit.\nFür den Agenten ist SubKit ein Tool: Er ruft einen freigegebenen Workflow auf, statt selbst Zugangsdaten zu halten.\nJeder Aufruf läuft durch dieselbe Rechteprüfung wie im Cockpit und steht im Verlauf.\n\nGesammeltes Material folgt immer einem Weg: **sammeln → mit dem Agenten prüfen → im Cockpit bestätigen → Wissen**.\n\n### Was du brauchst\n\n- Die sk-CLI, angemeldet an deiner Engine. In der Cloud nutzt du dafür `sk login --engine-url https://subkit-cloud.mikebild.info` und **Mit Firmenkonto anmelden**. Das Briefing nutzt dieses angemeldete Profil.\n- Die MCP-Adresse deiner Engine, `https://<deine-engine>/mcp`. In SubKit Cloud ist das `https://subkit-cloud.mikebild.info/mcp`.\n- Claude Code, Codex oder Hermes.\n- Ein Repository, in dem die Briefings erscheinen sollen.\n\n### Die SubKit-Tools einmal pro Rechner einrichten\n\n1. Öffne im Cockpit **API-Zugang** und erstelle einen Schlüssel.\n2. Lege den Schlüssel in `SK_API_KEY` ab.\n3. Trage SubKit mit dem passenden Befehl in deinem Client ein.\n\nClaude Code:\n\n```bash\nclaude mcp add --transport http --scope user sk https://<deine-engine>/mcp --header \"Authorization: Bearer ${SK_API_KEY}\"\n```\n\nCodex:\n\n```bash\ncodex mcp add sk --url https://<deine-engine>/mcp --bearer-token-env-var SK_API_KEY\n```\n\nEin Schlüssel ohne `mcp:authoring` lässt den Agenten lesen und Workflows starten, aber nichts bauen. Soll er Workflows und Konnektoren entwerfen, legst du den Schlüssel mit `sk apikeys create --scopes …,mcp:authoring` an.\nOhne Schlüssel anmelden: siehe „KI-Clients per MCP anbinden“.\n\n### Briefings in einem Repository einrichten\n\n1. Lege im Repository die Domänen fest:\n\n   ```bash\n   sk agent init --domains <category>\n   ```\n\n   Mehrere Domänen trennst du mit Kommas: `--domains <category>[,<category>]`.\n   Der Befehl schreibt `.sk/agent.json` und trägt die SubKit-Hooks in `~/.claude/settings.json` und `~/.codex/hooks.json` ein. Hooks anderer Werkzeuge bleiben erhalten.\n2. Committe `.sk/agent.json`, damit jeder Checkout dieselben Domänen nutzt.\n3. Führe in Claude Code oder Codex `/hooks` aus und prüfe, ob die SubKit-Hooks aktiv sind.\n4. Vertraue neuen oder geänderten SubKit-Hooks.\n\n### Hermes von Hand einrichten\n\nFür Hermes richtet `sk agent init` keine Hooks ein. Die Ausgabe des Befehls zeigt die nötigen Angaben unter „Hermes (manual)“.\n\n1. Trage in Hermes einen MCP-Server über streamable HTTP mit der Adresse `https://<deine-engine>/mcp` ein.\n2. Gib als Header `Authorization: Bearer ${SK_API_KEY}` mit.\n3. Führe zu Beginn einer Sitzung im Repository `sk agent briefing` aus und gib die Ausgabe Hermes als Kontext mit.\n\n### Das Briefing prüfen\n\n1. Führe im Repository `sk status` aus.\n2. Führe `sk agent briefing --json` aus.\n3. Prüfe die Felder `domains`, `knowledge_sources`, `skills_full` und `used_tokens`.\n\n### Gesammeltes Material mit deinem Coding-Agenten prüfen\n\nDein Agent kann eine Prüfung gesammelter Einträge starten. Das Ergebnis bestätigst du im Cockpit.\n\n1. Frag deinen Agenten: „Sieh die neuen Einträge in Research durch. Welche sind nützlich? Schlage vor, was wir als Wissen behalten sollten.“\n2. Öffne den Cockpit-Link, den der Agent zurückgibt. Er führt zum Tab **Prüfen** des Eintrags.\n3. Prüfe Quellen, genauen Text und Wissensziel des Vorschlags.\n4. Wähle **Als Quelle bestätigen**.\n5. Führe `sk agent briefing --json` aus und prüfe `knowledge_sources`.\n\nEine neue Sitzung lädt das aktualisierte Briefing.\n\nGut zu wissen:\n\n- Nur eine angemeldete Person mit `intake:confirm` und `knowledge:write` bestätigt einen Vorschlag. Ein API-Schlüssel, ein MCP-Client oder der Web Clipper tut das nie.\n- Das Original des Eintrags bleibt mit dem Wissen verknüpft, das aus ihm entsteht.\n- Verschieben, Bearbeiten oder Verwerfen nimmt einen Eintrag nie als Wissen auf.\n\n### Gesammeltes Material im Terminal prüfen\n\n| Befehl | Was er tut |\n| --- | --- |\n| `sk intake list` | Zeigt gesammelte Einträge in deiner Standardkategorie. |\n| `sk intake list --category research` | Zeigt gesammelte Einträge einer Kategorie. |\n| `sk intake review --category research` | Startet die Prüfung und gibt den Cockpit-Link aus. |\n| `sk intake review --items <comma-separated-ids>` | Prüft nur bestimmte Einträge. |\n| `sk intake default --category research` | Ändert deine persönliche Standardkategorie. |\n| `sk intake move --item <id> --category research` | Ordnet einen Eintrag einer Kategorie zu. |\n| `sk intake discard --item <id>` | Verwirft einen Eintrag. |\n| `sk intake restore --item <id>` | Stellt einen verworfenen Eintrag wieder her. |\n\n- Ohne Auswahl nutzt `review` deine Standardkategorie.\n- `--json` liefert maschinenlesbare Ergebnisse.\n- Diese Aktionen erhalten das Original des Eintrags und nehmen nie Wissen auf.\n\n### So funktionieren Briefings\n\n**Domänen.** Eine Domäne ist eine Katalogkategorie oder ein Tag `domain:<slug>`.\n\n- `sk agent init` ergänzt die angeforderten Domänen und entfernt nichts Bestehendes.\n- Ohne `.sk/agent.json` gleichen die Hooks den Ordnernamen mit deinen Projektkategorien ab. Bei einem eindeutigen Treffer legen sie `.sk/agent.json` für dich an. Sonst fragen sie nach, statt zu raten.\n- Um die Domänen selbst festzulegen, bearbeite `domains` in `.sk/agent.json` und entferne `inferred` und `inferred_folder_domain`.\n- Ein Prompt kann weitere passende Domänen hinzufügen, wenn sich die Aufgabe ändert.\n\n**Hooks.** `init` richtet die Hooks SessionStart, UserPromptSubmit und SessionEnd für Claude Code und Codex ein. `--skip-claude` und `--skip-codex` lassen die Einstellungen des jeweiligen Clients unberührt.\n\n**Umfang.** Ein Briefing hat höchstens 1.800 Token und 9.500 Zeichen, gemeinsam für beide Clients und die interaktive sk-Sitzung.\nWas nicht hineinpasst, wird gekürzt, und du siehst eine Warnung.\n\nEin Briefing enthält:\n\n- Domänenkontext und einen kurzen Status, blockierte Arbeit und Fristen zuerst.\n- Bis zu drei konkrete nächste Schritte in deiner Sprache.\n- Passende Quellen und Workflows der Ordner-Domäne, namentlich genannt, wenn sie bei einer Aufgabe helfen.\n- Die Zahl gesammelter Seiten und Sitzungserkenntnisse, nie deren Inhalt. Mit `intake:read` zusätzlich die Zahl gesammelter Einträge und offener Vorschläge im ganzen Arbeitsbereich.\n\n**Sitzungserkenntnisse.** Am Sitzungsende senden Claude Code und Codex das Transkript an die Engine.\n\n- Die Engine behält nur Praktiken und Fakten, die eine Person gelehrt oder bestätigt hat.\n- Sie verwirft Ereignisse, Statusmeldungen und alles, was mit Zugangsdaten zu tun hat.\n- Der Rest landet in der Inbox (im Cockpit **Eingang**) mit Herkunft `session`, in der gemeinsamen Kategorie des Projekts oder in deiner Standardkategorie. Eine wiederholte Erkenntnis ergänzt den bestehenden Eintrag um Belege.\n- Erkenntnisse sind weder Wissen noch Skills, bis eine Person sie im Cockpit bestätigt. `sk intake list` zeigt, was wartet.\n\n**Prüfungen mit einem Agenten.** Die Prüfung läuft in einer gespeicherten SubKit-Unterhaltung.\n\n- MCP-Clients starten sie mit `conversation_start`. `intake_item_ids` wählt bestimmte Einträge aus und hält die Auswahl fest.\n- Tools, die Einträge lesen oder Vorschläge vorbereiten, arbeiten nur in dieser Unterhaltung.\n- Nimm bei einem neuen Ziel die Themenkategorie oder das Tag `domain:<slug>` in den Vorschlag auf. Ein geänderter Vorschlag muss erneut geprüft werden.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| `sk agent briefing: no domains …` | Es gibt keine Deklaration. Übergib `--domains` oder führe `sk agent init --domains <category>` aus. |\n| `knowledge_sources` oder `skills_full` sind leer | Das Briefing funktioniert, aber nichts ist der Domäne zugeordnet. Lege Wissen und Skills in der Kategorie der Domäne ab oder nutze das Tag `domain:<slug>`. |\n| Der Client zeigt eine Warnung zum Briefing | Die Engine ist nicht erreichbar. Die Sitzung läuft weiter. Prüfe mit `sk status` Anmeldung und Verbindung. |\n| Keine Briefings in Claude Code oder Codex | Öffne `/hooks`, prüfe, ob die SubKit-Hooks aktiv sind, und vertraue neuen oder geänderten Hooks. |\n| `/hooks` in Codex zeigt die SubKit-Hooks als deaktiviert | Codex-Hooks sind standardmäßig aktiv, eine Änderung an `config.toml` ist normalerweise nicht nötig. Prüfe zuerst die wirksame Feature-Einstellung und die Administratorrichtlinie, dann folge dem [Codex-Hook-Leitfaden](https://learn.chatgpt.com/docs/hooks). |\n| Der Agent kann nichts entwerfen | Sein Schlüssel hat kein `mcp:authoring`. Lege einen neuen Schlüssel mit diesem Scope an. |\n| Der Hinweis auf gesammelte Einträge fehlt | Dir fehlt das Recht `intake:read`. Bitte eine Administratorin oder einen Administrator darum. |\n| Ein Vorschlag lässt sich nicht bestätigen | Bestätigen kann nur eine angemeldete Person mit `intake:confirm` und `knowledge:write`, nicht ein API-Schlüssel. Öffne den Cockpit-Link. |"
        }
      }
    },
    {
      "slug": "web-clipper",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 4,
      "generated": false,
      "locales": {
        "en": {
          "title": "Collect web pages with the Web Clipper",
          "summary": "Save pages, selections and YouTube transcripts from Chrome to your inbox.",
          "headings": [
            {
              "depth": 2,
              "text": "Collect web pages with the Web Clipper",
              "anchor": "collect-web-pages-with-the-web-clipper"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Install the extension",
              "anchor": "install-the-extension"
            },
            {
              "depth": 3,
              "text": "Install without the CLI",
              "anchor": "install-without-the-cli"
            },
            {
              "depth": 3,
              "text": "Update the extension",
              "anchor": "update-the-extension"
            },
            {
              "depth": 3,
              "text": "Connect it to your engine",
              "anchor": "connect-it-to-your-engine"
            },
            {
              "depth": 3,
              "text": "Collect a page",
              "anchor": "collect-a-page"
            },
            {
              "depth": 3,
              "text": "What happens next",
              "anchor": "what-happens-next"
            },
            {
              "depth": 3,
              "text": "What the Web Clipper captures",
              "anchor": "what-the-web-clipper-captures"
            },
            {
              "depth": 3,
              "text": "Privacy",
              "anchor": "privacy"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            },
            {
              "depth": 4,
              "text": "Connection and key",
              "anchor": "connection-and-key"
            },
            {
              "depth": 4,
              "text": "Capturing",
              "anchor": "capturing"
            },
            {
              "depth": 4,
              "text": "Collecting",
              "anchor": "collecting"
            }
          ],
          "images": [
            {
              "src": "/docs-images/web-clipper-api-key.en.webp?v=d37e5c477602",
              "alt": "\"Create key\" dialog with the Web Clipper preset, which grants only View and Edit on collected items",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            }
          ],
          "sha256": "b9d0f5bac161b9bf57355e3db5636d898c6f019b1815b701a08fcb0cdd77283f",
          "body": "## Collect web pages with the Web Clipper\n\nThis chapter is for anyone who collects material for their team while reading in the browser.\nYou install the Web Clipper, connect it to your engine and collect your first page.\nAfterwards, whatever you find worth keeping lands in your Cockpit **Inbox** with its source and waits there for a review.\n\nThe Web Clipper is a Chrome extension. It drops a page, a selection or a YouTube transcript into your inbox as Markdown; it only becomes knowledge once a person confirms it. It is not in the Chrome Web Store yet; you set it up with `sk clipper install`.\n\nThe path is always the same: **collect → review in chat → confirm → knowledge or skill**.\n\n### What you need\n\n- **Google Chrome.** Microsoft Edge and other Chromium browsers are untested. Firefox is not supported, because the extension uses a Chrome background service worker.\n- **An engine address** that uses HTTPS. Plain HTTP works only with `localhost`, `127.0.0.1` or `[::1]`. In SubKit Cloud it is `https://subkit-cloud.mikebild.info`, without `/cockpit`.\n- **An account with `intake:read` and `intake:write`.** If it lacks them, ask an administrator.\n- **To install with the CLI:** the `sk` CLI, signed in to your engine. See \"Use the sk CLI on your machine\". Without the CLI, use the ZIP file.\n\n### Install the extension\n\nThe installer copies your active profile's engine address into the extension. You only add an API key later.\n\n1. Run `sk clipper install`. The command unpacks the extension to `~/.sk/clipper` and tries to open Chrome's extension page. The output names the folder and the next steps:\n\n   ```text\n   sk: clipping extension installed to /Users/you/.sk/clipper\n   sk: in Chrome, enable Developer mode, select Load unpacked, and choose the directory above. Reload the extension there after a future install.\n   ```\n\n2. In Chrome, open `chrome://extensions`. If Chrome did not open by itself, the command prints `sk: could not open Chrome automatically`.\n3. Turn on **Developer mode** (top right).\n4. Select **Load unpacked** and choose the folder from the output.\n5. Pin the \"SubKit Clipper\" extension to the toolbar.\n\nThe command has three options:\n\n| Option | What it does |\n| --- | --- |\n| `--dir <directory>` | Installs to another folder. |\n| `--engine-url <url>` | Uses this engine address instead of the active profile's. |\n| `--no-open` | Does not open Chrome. |\n\n### Install without the CLI\n\nYour engine also offers the extension as a ZIP file. It contains no engine address; you enter it yourself when you connect.\n\n1. Download `<engine address>/install/clipper.zip`, for example `https://subkit-cloud.mikebild.info/install/clipper.zip`.\n2. Unpack the file into a folder you keep. Chrome loads the extension from that folder.\n3. In Chrome, open `chrome://extensions`, turn on **Developer mode** and select **Load unpacked** with the unpacked folder.\n\n### Update the extension\n\nAfter you update the `sk` CLI, install the Web Clipper again:\n\n1. Run `sk clipper install`. If you used the ZIP file, unpack the new file into the same folder.\n2. On `chrome://extensions`, reload the \"SubKit Clipper\" extension.\n\nThe engine address and language stay. Paste the API key again after the reload.\n\n### Connect it to your engine\n\nThe Web Clipper signs in with its own API key.\n\n1. In the Cockpit, open **API access**.\n2. Select **Create key** and pick the **Web Clipper** preset. It grants exactly `intake:read` and `intake:write`.\n\n   ![\"Create key\" dialog with the Web Clipper preset, which grants only View and Edit on collected items](/docs-images/web-clipper-api-key.en.webp?v=d37e5c477602)\n\n3. Copy the key and keep it in a password manager.\n4. In the Web Clipper, select the gear icon (⚙). The settings open in a new tab.\n5. Check the **Engine address** and paste the key into **API key**.\n6. Select **Save connection**.\n7. Allow access when Chrome asks for it.\n\nThe Web Clipper checks the connection, loads your categories and confirms that the key may save items.\nAfter a browser restart, paste the key again; \"Privacy\" explains why.\n\nIf the engine address changes, you need the key for the new engine. **Clear API key** removes the key from the extension.\n\n### Collect a page\n\n1. In the toolbar, select the \"SubKit Clipper\" icon.\n2. Check the **Title**.\n3. Optional: fill in **Why is this interesting?**.\n4. Pick a **Category**, or select **New category**. Names use lowercase letters, digits and hyphens, up to 40 characters.\n5. Check the preview.\n6. Optional: open **Details and edit content** to see author and date and to edit the Markdown.\n7. Select **Collect**.\n\nIt is quicker to right-click and select **Save page to SubKit** or **Save selection to SubKit**, or to press **Alt+Shift+K**. Change the shortcut at `chrome://extensions/shortcuts`.\n\nOn success, the popup says for example \"Collected: research. Not yet admitted as knowledge or a skill.\" **Review in chat** starts the review right away.\nIf saving fails, your draft stays in the Web Clipper. The same page is never collected twice.\n\n### What happens next\n\n1. **Inbox:** in the Cockpit, open **Inbox** and click the item. On its page you read, edit or discard it.\n2. **Review:** select **Review in chat** in the Web Clipper or in the item's menu. The chat prepares a proposal: the exact content, its sources and the destination (knowledge or skill).\n3. **Confirm:** a person signed in to the Cockpit in the browser confirms the proposal on the item's **Review** tab as a source or skill.\n\nTo confirm, that person needs `intake:confirm` and the right of the destination:\n\n| Destination | Needed rights |\n| --- | --- |\n| Knowledge | `knowledge:write` |\n| Skill | `skill:write` and `skill:activate` |\n| Skill that replaces others | also `skill:archive` for each replaced skill |\n\nAPI keys, MCP clients and the Web Clipper itself cannot confirm.\nUntil it is confirmed, an item is not knowledge, and ordinary knowledge search does not find it. Moving or editing it changes nothing about that; if the proposal changes, you review it again.\nMore in the chapter \"Collect ideas and turn them into knowledge or skills\".\n\n### What the Web Clipper captures\n\n- **A page:** the main article text as Markdown, links as absolute addresses, without navigation and recommendations.\n- **A selection:** only the selected text. From the toolbar or the shortcut, the Web Clipper uses your selection if there is one, otherwise the whole article.\n- **A YouTube video:** title, author, publish date, description and the transcript in the original audio language. Include or exclude description and transcript under **Details and edit content**.\n\nIt also keeps the source address, author and publish date when the page provides them. Image links stay in the text; the Web Clipper uploads no image files and no screenshots.\n\n### Privacy\n\n- **Destination:** items go only to the engine you configured. For a transcript, the Web Clipper may also load the page and captions directly from YouTube.\n- **Credentials are redacted:** before saving, SubKit replaces recognizable credentials (API keys, tokens, private keys, signed-link signatures) with a marker. The values are never stored. Personal data is kept, so don't clip pages that show passwords or keys.\n- **Your API key** sits only in the browser's session storage and is never written to your device. That is why you paste it again after a browser restart or a reload of the extension. A key from the **Web Clipper** preset only views and edits collected items (`intake:read`, `intake:write`), including other people's clips in this workspace. Revoke it in the Cockpit when you no longer need it.\n- **What the key can reach:** the **Web Clipper** preset grants only viewing and editing collected items (`intake:read`, `intake:write`), including other people's clips in your workspace. Revoke the key in the Cockpit when you no longer need it.\n- **Originals stay:** the engine keeps the original captured snapshot. Later edits do not overwrite it, and the item stays linked to the knowledge or skill made from it.\n- **Visibility:** items follow the permissions of your workspace. Categories are shared, not private.\n\n### If something does not work\n\nThe Web Clipper shows messages in the selected language. **Help** in the popup and in the settings opens this chapter on your engine.\nIf a capture from the context menu or the shortcut fails, the Web Clipper opens its popup in a tab and shows the error there.\n\n#### Connection and key\n\n| What you see | What to do |\n| --- | --- |\n| \"Set an engine address and API key first. …\" or \"Set an engine address before capturing.\" | Enter both in the settings (⚙) and save. After a browser restart, paste the key again. |\n| \"The API key is invalid or expired. …\" | Create a new key with the **Web Clipper** preset under **API access** and save it in the settings. |\n| \"The API key lacks intake:read. …\" or \"… lacks intake:write. …\" | Create a key with the **Web Clipper** preset under **API access**. Your draft stays. |\n| \"The SubKit API could not be reached. …\" | Check the engine address, your internet connection and whether Chrome may access the address. |\n| \"Use an HTTPS address or HTTP on localhost.\" | Use `https://`, or `http://` only with `localhost`, `127.0.0.1` or `[::1]`. The address must not contain a user name, a password, a `?query` or a `#fragment`. |\n| \"Allow access to this engine to save the connection.\" | Save again and allow access when Chrome asks. |\n| \"Enter an API key for the new engine.\" | You changed the engine address. Paste the key for the new engine. |\n| \"Categories currently unavailable\" | Select **Check connection**. |\n\n#### Capturing\n\n| What you see | What to do |\n| --- | --- |\n| \"The main content could not be captured reliably. …\" | Select the relevant text, then select **Capture again**. |\n| \"The content was captured as simplified text. …\" | Check in the preview that everything is there. |\n| \"No text was captured. …\" | Select **Capture again**. For an excerpt, select the text first. |\n| \"No transcript is available.\" | The Web Clipper could not read a transcript for this video. |\n| \"Open the clipper from the toolbar on this page again.\" | Chrome needs access to this site. Select the toolbar icon on that page. |\n| \"The page changed while it was being captured. Capture it again.\" | Capture again. |\n| \"The page could not be captured.\" | Reload the page and try again. |\n\n#### Collecting\n\n| What you see | What to do |\n| --- | --- |\n| \"Saving is not confirmed yet. Retry; your draft remains available.\" | The network or the engine failed. Select **Try again**. |\n| \"SubKit rejected the clip. …\" | Check the category and the content, then try again. |\n| \"This clip already exists.\" | It was already collected. |\n| \"Choose a valid category before collecting.\" or \"Enter a valid category.\" | Use lowercase letters, digits and hyphens, at most 40 characters. |\n| \"The saved category is unavailable. Choose another category.\" | Pick another category. |\n| \"This draft belongs to a different engine.\" | Switch back to the engine it was made for to send it. |"
        },
        "de": {
          "title": "Webseiten mit dem Web Clipper sammeln",
          "summary": "Speichere Seiten, markierte Stellen und YouTube-Transkripte aus Chrome in deiner Inbox.",
          "headings": [
            {
              "depth": 2,
              "text": "Webseiten mit dem Web Clipper sammeln",
              "anchor": "webseiten-mit-dem-web-clipper-sammeln"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Die Erweiterung installieren",
              "anchor": "die-erweiterung-installieren"
            },
            {
              "depth": 3,
              "text": "Ohne CLI installieren",
              "anchor": "ohne-cli-installieren"
            },
            {
              "depth": 3,
              "text": "Die Erweiterung aktualisieren",
              "anchor": "die-erweiterung-aktualisieren"
            },
            {
              "depth": 3,
              "text": "Mit deiner Engine verbinden",
              "anchor": "mit-deiner-engine-verbinden"
            },
            {
              "depth": 3,
              "text": "Eine Seite sammeln",
              "anchor": "eine-seite-sammeln"
            },
            {
              "depth": 3,
              "text": "Wie es weitergeht",
              "anchor": "wie-es-weitergeht"
            },
            {
              "depth": 3,
              "text": "Was der Web Clipper erfasst",
              "anchor": "was-der-web-clipper-erfasst"
            },
            {
              "depth": 3,
              "text": "Datenschutz",
              "anchor": "datenschutz"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            },
            {
              "depth": 4,
              "text": "Verbindung und Schlüssel",
              "anchor": "verbindung-und-schlüssel"
            },
            {
              "depth": 4,
              "text": "Erfassen",
              "anchor": "erfassen"
            },
            {
              "depth": 4,
              "text": "Sammeln",
              "anchor": "sammeln"
            }
          ],
          "images": [
            {
              "src": "/docs-images/web-clipper-api-key.de.webp?v=7da68070ff46",
              "alt": "Dialog „Schlüssel erstellen“ mit der Vorlage Web Clipper, die nur Anzeigen und Bearbeiten für gesammelte Einträge erlaubt",
              "build": "10.6.0",
              "width": 1440,
              "height": 723
            }
          ],
          "sha256": "f7d99324d2cab21d587317f949fe5c2b9ee3f1ac9f7e8e80ecbb2ac6cadfaddb",
          "body": "## Webseiten mit dem Web Clipper sammeln\n\nDieses Kapitel ist für alle, die beim Lesen im Browser Material für ihr Team sammeln.\nDu installierst den Web Clipper, verbindest ihn mit deiner Engine und sammelst die erste Seite.\nDanach landet, was du für wichtig hältst, mit Quelle in deiner Inbox (im Cockpit **Eingang**) und wartet dort auf eine Prüfung.\n\nDer Web Clipper ist eine Chrome-Erweiterung. Er legt eine Seite, eine markierte Stelle oder ein YouTube-Transkript als Markdown in deine Inbox; Wissen wird daraus erst, wenn eine Person es bestätigt. Er ist noch nicht im Chrome Web Store, du richtest ihn mit `sk clipper install` ein.\n\nDer Weg ist immer gleich: **sammeln → im Chat prüfen → bestätigen → Wissen oder Skill**.\n\n### Was du brauchst\n\n- **Google Chrome.** Microsoft Edge und andere Chromium-Browser sind nicht getestet. Firefox wird nicht unterstützt, weil die Erweiterung einen Hintergrund-Service-Worker von Chrome nutzt.\n- **Eine Engine-Adresse** mit HTTPS. Reines HTTP geht nur mit `localhost`, `127.0.0.1` oder `[::1]`. In SubKit Cloud ist es `https://subkit-cloud.mikebild.info`, ohne `/cockpit`.\n- **Ein Konto mit `intake:read` und `intake:write`.** Fehlen sie, bitte eine Administratorin oder einen Administrator darum.\n- **Für die Installation per CLI:** die `sk`-CLI, angemeldet an deiner Engine. Siehe „Die sk-CLI auf deinem Rechner verwenden“. Ohne CLI nimmst du die ZIP-Datei.\n\n### Die Erweiterung installieren\n\nDer Installer übernimmt die Engine-Adresse deines aktiven Profils. Später trägst du nur noch einen API-Schlüssel ein.\n\n1. Führe `sk clipper install` aus. Der Befehl entpackt die Erweiterung nach `~/.sk/clipper` und versucht, die Erweiterungsseite von Chrome zu öffnen. Die Ausgabe nennt den Ordner und die nächsten Schritte:\n\n   ```text\n   sk: clipping extension installed to /Users/you/.sk/clipper\n   sk: in Chrome, enable Developer mode, select Load unpacked, and choose the directory above. Reload the extension there after a future install.\n   ```\n\n2. Öffne in Chrome `chrome://extensions`. Hat sich Chrome nicht selbst geöffnet, meldet der Befehl `sk: could not open Chrome automatically`.\n3. Schalte oben rechts den **Entwicklermodus** ein.\n4. Wähle **Entpackte Erweiterung laden** (in englischem Chrome: **Load unpacked**) und den Ordner aus der Ausgabe.\n5. Hefte die Erweiterung „SubKit Clipper“ an die Symbolleiste.\n\nDer Befehl kennt drei Optionen:\n\n| Option | Wirkung |\n| --- | --- |\n| `--dir <directory>` | Installiert in einen anderen Ordner. |\n| `--engine-url <url>` | Nutzt diese Engine-Adresse statt der des aktiven Profils. |\n| `--no-open` | Öffnet Chrome nicht. |\n\n### Ohne CLI installieren\n\nDeine Engine bietet die Erweiterung auch als ZIP-Datei an. Darin steht keine Engine-Adresse; die trägst du beim Verbinden selbst ein.\n\n1. Lade `<Engine-Adresse>/install/clipper.zip` herunter, zum Beispiel `https://subkit-cloud.mikebild.info/install/clipper.zip`.\n2. Entpacke die Datei in einen Ordner, den du behältst. Chrome lädt die Erweiterung aus diesem Ordner.\n3. Öffne in Chrome `chrome://extensions`, schalte den **Entwicklermodus** ein und wähle **Entpackte Erweiterung laden** mit dem entpackten Ordner.\n\n### Die Erweiterung aktualisieren\n\nNach einem Update der `sk`-CLI installierst du den Web Clipper neu:\n\n1. Führe `sk clipper install` aus. Hast du die ZIP-Datei genutzt, entpackst du die neue Datei in denselben Ordner.\n2. Lade die Erweiterung „SubKit Clipper“ auf `chrome://extensions` neu.\n\nEngine-Adresse und Sprache bleiben erhalten. Den API-Schlüssel fügst du nach dem Neuladen erneut ein.\n\n### Mit deiner Engine verbinden\n\nDer Web Clipper meldet sich mit einem eigenen API-Schlüssel an.\n\n1. Öffne im Cockpit **API-Zugang**.\n2. Wähle **Schlüssel erstellen** und die Vorlage **Web Clipper**. Sie gewährt genau `intake:read` und `intake:write`.\n\n   ![Dialog „Schlüssel erstellen“ mit der Vorlage Web Clipper, die nur Anzeigen und Bearbeiten für gesammelte Einträge erlaubt](/docs-images/web-clipper-api-key.de.webp?v=7da68070ff46)\n\n3. Kopiere den Schlüssel und bewahre ihn in einem Passwortmanager auf.\n4. Wähle im Web Clipper das Zahnrad (⚙). Die Einstellungen öffnen sich in einem neuen Tab.\n5. Prüfe die **Engine-Adresse** und füge den Schlüssel unter **API-Schlüssel** ein.\n6. Wähle **Verbindung speichern**.\n7. Erlaube den Zugriff, wenn Chrome danach fragt.\n\nDer Web Clipper prüft die Verbindung, lädt deine Kategorien und bestätigt, dass der Schlüssel Einträge speichern darf.\nNach einem Neustart des Browsers fügst du den Schlüssel erneut ein; warum, steht unter „Datenschutz“.\n\nÄndert sich die Engine-Adresse, brauchst du den Schlüssel der neuen Engine. **API-Schlüssel löschen** entfernt den Schlüssel aus der Erweiterung.\n\n### Eine Seite sammeln\n\n1. Wähle in der Symbolleiste das Symbol „SubKit Clipper“.\n2. Prüfe den **Titel**.\n3. Optional: Fülle **Warum ist das interessant?** aus.\n4. Wähle eine **Kategorie** oder **Neue Kategorie**. Namen bestehen aus Kleinbuchstaben, Ziffern und Bindestrichen, höchstens 40 Zeichen.\n5. Prüfe die Vorschau.\n6. Optional: Öffne **Details und Inhalt bearbeiten**, um Autor und Datum zu sehen und das Markdown zu ändern.\n7. Wähle **Sammeln**.\n\nSchneller geht es per Rechtsklick mit **Seite in SubKit sichern** oder **Auswahl in SubKit sichern**, oder mit **Alt+Shift+K**. Das Tastenkürzel änderst du unter `chrome://extensions/shortcuts`.\n\nBei Erfolg meldet das Popup zum Beispiel „Gesammelt: research. Noch nicht als Wissen oder Skill übernommen.“ Mit **Im Chat prüfen** startest du die Prüfung sofort.\nSchlägt das Speichern fehl, bleibt dein Entwurf im Web Clipper. Dieselbe Seite wird nie doppelt gesammelt.\n\n### Wie es weitergeht\n\n1. **Eingang:** Öffne im Cockpit **Eingang** und klicke auf den Eintrag. Auf seiner Seite liest, bearbeitest oder verwirfst du ihn.\n2. **Prüfen:** Wähle **Im Chat prüfen** im Web Clipper oder im Menü des Eintrags. Der Chat bereitet einen Vorschlag vor: genauer Inhalt, Quellen und Ziel (Wissen oder Skill).\n3. **Bestätigen:** Eine Person, die im Browser am Cockpit angemeldet ist, bestätigt den Vorschlag im Tab **Prüfen** des Eintrags als Quelle oder Skill.\n\nZum Bestätigen braucht diese Person `intake:confirm` und das Recht des Ziels:\n\n| Ziel | Nötige Rechte |\n| --- | --- |\n| Wissen | `knowledge:write` |\n| Skill | `skill:write` und `skill:activate` |\n| Skill, der andere ersetzt | zusätzlich `skill:archive` für jeden ersetzten Skill |\n\nAPI-Schlüssel, MCP-Clients und der Web Clipper selbst können nicht bestätigen.\nBis zur Bestätigung ist ein Eintrag kein Wissen, und die normale Wissenssuche findet ihn nicht. Verschieben oder Bearbeiten ändert daran nichts; ändert sich der Vorschlag, prüfst du ihn erneut.\nMehr dazu im Kapitel „Ideen sammeln und in Wissen oder Skills verwandeln“.\n\n### Was der Web Clipper erfasst\n\n- **Eine Seite:** den Haupttext des Artikels als Markdown, Links als vollständige Adressen, ohne Navigation und Empfehlungen.\n- **Eine markierte Stelle:** nur die Markierung. Über Symbolleiste oder Tastenkürzel nimmt der Web Clipper die Markierung, sonst den ganzen Artikel.\n- **Ein YouTube-Video:** Titel, Autor, Veröffentlichungsdatum, Beschreibung und Transkript in der Originalsprache. Beschreibung und Transkript schaltest du unter **Details und Inhalt bearbeiten** einzeln ein oder aus.\n\nDazu kommen Quelladresse, Autor und Veröffentlichungsdatum, sofern die Seite sie angibt. Bildlinks bleiben im Text; Bilddateien und Screenshots lädt der Web Clipper nicht hoch.\n\n### Datenschutz\n\n- **Ziel:** Einträge gehen nur an die Engine, die du eingestellt hast. Für ein Transkript lädt der Web Clipper eventuell Seite und Untertitel direkt von YouTube.\n- **Zugangsdaten werden geschwärzt:** Vor dem Speichern ersetzt SubKit erkennbare Zugangsdaten (API-Schlüssel, Tokens, private Schlüssel, Signaturen signierter Links) durch eine Markierung. Die Werte werden nie gespeichert. Personenbezogene Daten bleiben erhalten; sammle deshalb keine Seiten, die Passwörter oder Schlüssel zeigen.\n- **Dein API-Schlüssel** liegt nur im Sitzungsspeicher des Browsers und wird nie auf dein Gerät geschrieben. Deshalb fügst du ihn nach einem Neustart des Browsers oder einem Neuladen der Erweiterung erneut ein. Ein Schlüssel aus der Vorlage **Web Clipper** darf nur gesammelte Einträge ansehen und bearbeiten (`intake:read`, `intake:write`), auch die Clips anderer in diesem Arbeitsbereich. Widerrufe ihn im Cockpit, wenn du ihn nicht mehr brauchst.\n- **Reichweite des Schlüssels:** Die Vorlage **Web Clipper** erlaubt nur Anzeigen und Bearbeiten gesammelter Einträge (`intake:read`, `intake:write`), auch der Clips anderer Personen in deinem Arbeitsbereich. Widerrufe den Schlüssel im Cockpit, wenn du ihn nicht mehr brauchst.\n- **Originale bleiben:** Die Engine bewahrt den ursprünglich erfassten Stand. Spätere Änderungen überschreiben ihn nicht, und der Eintrag bleibt mit dem daraus entstandenen Wissen oder Skill verknüpft.\n- **Sichtbarkeit:** Einträge folgen den Rechten deines Arbeitsbereichs. Kategorien sind gemeinsam, nicht privat.\n\n### Wenn etwas nicht klappt\n\nDer Web Clipper zeigt Meldungen in der eingestellten Sprache. **Hilfe** im Popup und in den Einstellungen öffnet dieses Kapitel auf deiner Engine.\nSchlägt eine Erfassung per Kontextmenü oder Tastenkürzel fehl, öffnet der Web Clipper sein Popup in einem Tab und zeigt den Fehler dort.\n\n#### Verbindung und Schlüssel\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| „Lege zuerst eine Engine-Adresse und einen API-Schlüssel fest. …“ oder „Lege vor dem Erfassen eine Engine-Adresse fest.“ | Trage beides in den Einstellungen (⚙) ein und speichere. Nach einem Neustart des Browsers fügst du den Schlüssel erneut ein. |\n| „Der API-Schlüssel ist ungültig oder abgelaufen. …“ | Erstelle unter **API-Zugang** einen neuen Schlüssel mit der Vorlage **Web Clipper** und speichere ihn in den Einstellungen. |\n| „Dem API-Schlüssel fehlt intake:read. …“ oder „… fehlt intake:write. …“ | Erstelle unter **API-Zugang** einen Schlüssel mit der Vorlage **Web Clipper**. Dein Entwurf bleibt erhalten. |\n| „Die SubKit-API ist nicht erreichbar. …“ | Prüfe Engine-Adresse und Internetverbindung und ob Chrome auf die Adresse zugreifen darf. |\n| „Nutze HTTPS oder HTTP auf localhost.“ | Nutze `https://`, oder `http://` nur mit `localhost`, `127.0.0.1` oder `[::1]`. Die Adresse darf keinen Benutzernamen, kein Passwort, keine `?query` und kein `#fragment` enthalten. |\n| „Erlaube den Zugriff auf diese Engine, um die Verbindung zu speichern.“ | Speichere erneut und erlaube den Zugriff, wenn Chrome fragt. |\n| „Gib einen API-Schlüssel für die neue Engine ein.“ | Du hast die Engine-Adresse geändert. Füge den Schlüssel der neuen Engine ein. |\n| „Kategorien gerade nicht verfügbar“ | Wähle **Verbindung prüfen**. |\n\n#### Erfassen\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| „Der Hauptinhalt konnte nicht zuverlässig erfasst werden. …“ | Markiere den relevanten Text und wähle **Neu erfassen**. |\n| „Der Inhalt wurde vereinfacht als Text erfasst. …“ | Prüfe in der Vorschau, ob alles da ist. |\n| „Es wurde kein Text erfasst. …“ | Wähle **Neu erfassen**. Für einen Ausschnitt markierst du vorher den Text. |\n| „Kein Transkript verfügbar.“ | Für dieses Video konnte der Web Clipper kein Transkript lesen. |\n| „Öffne den Clipper über die Symbolleiste auf dieser Seite erneut.“ | Chrome braucht Zugriff auf diese Seite. Wähle dort das Symbol in der Symbolleiste. |\n| „Die Seite hat sich während der Erfassung geändert. Erfasse sie erneut.“ | Erfasse erneut. |\n| „Die Seite konnte nicht erfasst werden.“ | Lade die Seite neu und versuche es erneut. |\n\n#### Sammeln\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| „Die Speicherung ist noch nicht bestätigt. Versuche es erneut; dein Entwurf bleibt erhalten.“ | Netzwerk oder Engine hatten einen Fehler. Wähle **Erneut versuchen**. |\n| „SubKit hat den Clip abgelehnt. …“ | Prüfe Kategorie und Inhalt und versuche es erneut. |\n| „Dieser Clip existiert bereits.“ | Er wurde schon gesammelt. |\n| „Wähle eine gültige Kategorie, bevor du sammelst.“ oder „Gib eine gültige Kategorie ein.“ | Nutze Kleinbuchstaben, Ziffern und Bindestriche, höchstens 40 Zeichen. |\n| „Die gespeicherte Kategorie ist nicht verfügbar. Wähle eine andere Kategorie.“ | Wähle eine andere Kategorie. |\n| „Dieser Entwurf gehört zu einer anderen Engine.“ | Wechsle zu der Engine zurück, für die er entstand, um ihn zu senden. |"
        }
      }
    },
    {
      "slug": "collect-ideas-and-turn-them-into-knowledge-or-skills",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 5,
      "generated": false,
      "locales": {
        "en": {
          "title": "Collect ideas and turn them into knowledge or skills",
          "summary": "Capture pages and ideas, then decide what your team should keep.",
          "headings": [
            {
              "depth": 2,
              "text": "Collect ideas and turn them into knowledge or skills",
              "anchor": "collect-ideas-and-turn-them-into-knowledge-or-skills"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Collect something",
              "anchor": "collect-something"
            },
            {
              "depth": 3,
              "text": "Add a note",
              "anchor": "add-a-note"
            },
            {
              "depth": 3,
              "text": "Review and organize items",
              "anchor": "review-and-organize-items"
            },
            {
              "depth": 3,
              "text": "Review in chat",
              "anchor": "review-in-chat"
            },
            {
              "depth": 3,
              "text": "Confirm a proposal",
              "anchor": "confirm-a-proposal"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [
            {
              "src": "/docs-images/collect-ideas-and-turn-them-into-knowledge-or-skills-inbox.en.webp?v=147e1f8a806b",
              "alt": "Inbox with seven collected items of origin \"Note\", \"Browser\", \"Claude Code\", \"Chat\" and \"Codex\" in category Inbox, status \"Collected\", and the hint that three entries from your AI assistants are waiting for your review",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            }
          ],
          "sha256": "956068d9570bfbd09a703cd651cec05261f5036356b6acdd230265aca2922baf",
          "body": "## Collect ideas and turn them into knowledge or skills\n\nThis chapter is for anyone who wants to keep web pages, notes or learnings from AI sessions without deciding right away. Everything lands in the Cockpit under **Inbox**. It only becomes knowledge or a skill once a signed-in person with write rights confirms it in the Cockpit.\n\nThe path is always the same: **collect → review in chat → confirm → knowledge or skill**.\n\n### What you need\n\n- For web pages: the Web Clipper in Chrome, installed and connected. How to set it up is in the chapter \"Collect web pages with the Web Clipper\".\n- To collect: an account with `intake:read` and `intake:write`.\n- To confirm: a Cockpit sign-in with `intake:confirm`. Add `knowledge:write` for knowledge, or `skill:write` and `skill:activate` for a skill. Replacing skills also needs `skill:archive` for each replaced skill.\n\n### Collect something\n\nThe **Inbox** collects from two directions:\n\n- **Web pages** from the Web Clipper. They carry the origin **Browser**.\n- **Learnings from sessions** with AI assistants. Their origin names the assistant, such as **Claude Code**, **Codex** or **Chat**. When it is unknown, it reads **AI assistant**.\n\nTo collect a web page:\n\n1. Open the page in Chrome.\n2. Optional: select the text you want as an excerpt.\n3. In the toolbar, select the Web Clipper icon (\"SubKit Clipper\").\n4. Check the preview. The source address is captured automatically.\n5. Optional: add why the page matters.\n6. Pick a category. Your default category is preselected, at first `inbox`.\n7. Select **Collect**.\n\n### Add a note\n\nA note is an item without a source address, such as a thought or an idea.\n\n1. In the Cockpit, open **Inbox** and select **Add entry**. If the Inbox is still empty, select **Add a note**.\n2. In the **Add to intake** dialog, enter a **Title**.\n3. Write the text under **Content**. Markdown is allowed.\n4. Pick a **Category**, or create one with **New category…**.\n5. Select **Add**.\n\nThe note carries the origin **Note**. It has no **Open original page** link, because there is no source.\n\n### Review and organize items\n\n1. In the Cockpit, open **Inbox**.\n\n   ![Inbox with seven collected items of origin \"Note\", \"Browser\", \"Claude Code\", \"Chat\" and \"Codex\" in category Inbox, status \"Collected\", and the hint that three entries from your AI assistants are waiting for your review](/docs-images/collect-ideas-and-turn-them-into-knowledge-or-skills-inbox.en.webp?v=147e1f8a806b)\n\n2. Optional: above the list, click the hint, for example \"3 entries from your AI assistants are waiting for your review\". You then only see items from your AI assistants. The filter **Origin: AI assistant** appears next to the search; click it to clear it.\n3. Click an item. On the **Content** tab, one sentence names the origin, such as \"Collected by Chat in the session … · for … · …\". **Open conversation** takes you to the chat conversation, **Open original page** to the collected page.\n4. Optional: select **Edit item** to change title, content or category. The captured original is preserved.\n5. Optional: select **Discard** or **Restore**.\n\nWho sees what in the Inbox follows the permissions of your workspace. Categories are not private.\n\n### Review in chat\n\nTo review one item:\n\n1. In the **Inbox**, open the item.\n2. Select **Review in chat**. The chat shows the item as an `@` reference.\n\nFor a whole category, start the category's review suggestion in a new chat. Or ask: \"Look through my new Research entries and suggest what to keep.\"\n\nThe chat prepares a proposal with content, sources and destination, and links to it. The link opens the item's **Review** tab. Completed decisions appear on the **History** tab under **Proposals and decisions**.\n\n### Confirm a proposal\n\nOnly a person who is signed in to the Cockpit and has `intake:confirm` plus the right for the destination can confirm. API keys, MCP clients and the Web Clipper cannot confirm.\n\n1. Open the item and select **Review**.\n2. Read the proposal: content, sources and destination.\n3. Select **Confirm as source** or **Confirm as skill**.\n\nOnly now does knowledge search find the result, and only now do agent briefings carry the skill. If a skill replaces other skills, confirming archives them. The proposal shows each of these changes beforehand.\n\nGood to know:\n\n- Moving, editing or discarding an item never makes it knowledge.\n- If a proposal or one of its sources changes, you review it again.\n- SubKit replaces credentials such as API keys and tokens before an item is saved.\n- The item's original stays linked to the knowledge or skill.\n- How to keep maintaining confirmed sources and skills is in the chapter \"Maintain sources, skills and files\".\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| The Web Clipper reports no connection or an invalid key | Follow \"If something does not work\" in the chapter \"Collect web pages with the Web Clipper\". |\n| An item is missing in the **Inbox** | Check the category and the origin. Clear the **Origin** filter. |\n| \"You lack the rights for this. …\" | Ask an administrator for `intake:confirm` and the right for the destination. |\n| \"This suggestion changed. Review the current content before confirming it.\" | Read the current content, then confirm again. |\n| \"A skill this suggestion refers to can no longer be loaded. …\" | Revise the suggestion in the chat before you confirm. |"
        },
        "de": {
          "title": "Ideen sammeln und in Wissen oder Skills verwandeln",
          "summary": "Halte Seiten und Ideen fest und entscheide, was dein Team behalten soll.",
          "headings": [
            {
              "depth": 2,
              "text": "Ideen sammeln und in Wissen oder Skills verwandeln",
              "anchor": "ideen-sammeln-und-in-wissen-oder-skills-verwandeln"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Etwas sammeln",
              "anchor": "etwas-sammeln"
            },
            {
              "depth": 3,
              "text": "Eine Notiz hinzufügen",
              "anchor": "eine-notiz-hinzufügen"
            },
            {
              "depth": 3,
              "text": "Einträge prüfen und ordnen",
              "anchor": "einträge-prüfen-und-ordnen"
            },
            {
              "depth": 3,
              "text": "Im Chat prüfen",
              "anchor": "im-chat-prüfen"
            },
            {
              "depth": 3,
              "text": "Einen Vorschlag bestätigen",
              "anchor": "einen-vorschlag-bestätigen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [
            {
              "src": "/docs-images/collect-ideas-and-turn-them-into-knowledge-or-skills-inbox.de.webp?v=4fb88b30b4f8",
              "alt": "Eingang mit sieben gesammelten Einträgen der Herkunft „Notiz“, „Browser“, „Claude Code“, „Chat“ und „Codex“ in der Kategorie Inbox, Status „Gesammelt“, und dem Hinweis, dass drei Einträge deiner KI-Assistenten auf deine Prüfung warten",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            }
          ],
          "sha256": "91e5045871d4cdae89567095e6efcf02e4ef44ca09ced727d473b005bb671e9e",
          "body": "## Ideen sammeln und in Wissen oder Skills verwandeln\n\nDieses Kapitel ist für alle, die Webseiten, Notizen oder Erkenntnisse aus KI-Sitzungen festhalten wollen, ohne gleich zu entscheiden. Alles landet im Cockpit unter **Eingang**. Daraus wird Wissen oder ein Skill erst, wenn eine angemeldete Person mit Schreibrecht es im Cockpit bestätigt.\n\nDer Weg ist immer gleich: **sammeln → im Chat prüfen → bestätigen → Wissen oder Skill**.\n\n### Was du brauchst\n\n- Für Webseiten: den Web Clipper in Chrome, installiert und verbunden. Wie du ihn einrichtest, steht im Kapitel „Webseiten mit dem Web Clipper sammeln“.\n- Zum Sammeln: ein Konto mit `intake:read` und `intake:write`.\n- Zum Bestätigen: eine Anmeldung im Cockpit mit `intake:confirm`. Dazu `knowledge:write` für Wissen oder `skill:write` und `skill:activate` für einen Skill. Wer Skills ersetzt, braucht für jeden ersetzten Skill zusätzlich `skill:archive`.\n\n### Etwas sammeln\n\nDer **Eingang** sammelt aus zwei Richtungen:\n\n- **Webseiten** aus dem Web Clipper. Sie tragen die Herkunft **Browser**.\n- **Erkenntnisse aus Sitzungen** mit KI-Assistenten. Als Herkunft steht dort der Assistent, etwa **Claude Code**, **Codex** oder **Chat**. Ist er unbekannt, steht dort **KI-Assistent**.\n\nEine Webseite sammelst du so:\n\n1. Öffne die Seite in Chrome.\n2. Optional: Markiere den Text, den du als Ausschnitt willst.\n3. Wähle in der Symbolleiste das Symbol des Web Clippers („SubKit Clipper“).\n4. Prüfe die Vorschau. Die Quelladresse wird automatisch erfasst.\n5. Optional: Ergänze, warum die Seite wichtig ist.\n6. Wähle eine Kategorie. Deine Standardkategorie ist vorausgewählt, anfangs `inbox`.\n7. Wähle **Sammeln**.\n\n### Eine Notiz hinzufügen\n\nEine Notiz ist ein Eintrag ohne Quelladresse, etwa ein Gedanke oder eine Idee.\n\n1. Öffne im Cockpit **Eingang** und wähle **Eintrag hinzufügen**. Ist der Eingang noch leer, wähle **Notiz hinzufügen**.\n2. Gib im Dialog **Zum Eingang hinzufügen** einen **Titel** ein.\n3. Schreib unter **Inhalt** den Text. Markdown ist erlaubt.\n4. Wähle eine **Kategorie** oder lege mit **Neue Kategorie …** eine neue an.\n5. Wähle **Hinzufügen**.\n\nDie Notiz trägt die Herkunft **Notiz**. Auf ihrer Seite fehlt der Link **Ursprüngliche Seite öffnen**, weil es keine Quelle gibt.\n\n### Einträge prüfen und ordnen\n\n1. Öffne im Cockpit **Eingang**.\n\n   ![Eingang mit sieben gesammelten Einträgen der Herkunft „Notiz“, „Browser“, „Claude Code“, „Chat“ und „Codex“ in der Kategorie Inbox, Status „Gesammelt“, und dem Hinweis, dass drei Einträge deiner KI-Assistenten auf deine Prüfung warten](/docs-images/collect-ideas-and-turn-them-into-knowledge-or-skills-inbox.de.webp?v=4fb88b30b4f8)\n\n2. Optional: Klicke über der Liste auf den Hinweis, etwa „3 Einträge deiner KI-Assistenten warten auf deine Prüfung“. Dann siehst du nur Einträge deiner KI-Assistenten. Der Filter **Herkunft: KI-Assistent** steht neben der Suche; ein Klick darauf hebt ihn auf.\n3. Klicke auf einen Eintrag. Im Tab **Inhalt** nennt ein Satz die Herkunft, etwa „Gesammelt von Chat in der Sitzung … · für … · …“. **Unterhaltung öffnen** führt zur Chat-Unterhaltung, **Ursprüngliche Seite öffnen** zur gesammelten Seite.\n4. Optional: Wähle **Eintrag bearbeiten**, um Titel, Inhalt oder Kategorie zu ändern. Das erfasste Original bleibt erhalten.\n5. Optional: Wähle **Verwerfen** oder **Wiederherstellen**.\n\nWer was im Eingang sieht, folgt den Rechten deines Arbeitsbereichs. Kategorien sind nicht privat.\n\n### Im Chat prüfen\n\nEinen Eintrag prüfst du so:\n\n1. Öffne den Eintrag im **Eingang**.\n2. Wähle **Im Chat prüfen**. Der Chat zeigt den Eintrag als `@`-Verweis.\n\nFür eine ganze Kategorie startest du in einem neuen Chat den Prüfvorschlag der Kategorie. Oder du fragst: „Sieh meine neuen Research-Einträge durch und schlag vor, was wir behalten.“\n\nDer Chat bereitet einen Vorschlag mit Inhalt, Quellen und Ziel vor und verlinkt ihn. Der Link öffnet den Tab **Prüfen** des Eintrags. Abgeschlossene Entscheidungen stehen im Tab **Verlauf** unter **Vorschläge und Entscheidungen**.\n\n### Einen Vorschlag bestätigen\n\nBestätigen kann nur eine Person, die im Cockpit angemeldet ist und `intake:confirm` sowie das Recht für das Ziel hat. API-Schlüssel, MCP-Clients und der Web Clipper können nicht bestätigen.\n\n1. Öffne den Eintrag und wähle **Prüfen**.\n2. Lies den Vorschlag: Inhalt, Quellen und Ziel.\n3. Wähle **Als Quelle bestätigen** oder **Als Skill bestätigen**.\n\nErst jetzt findet die Wissenssuche das Ergebnis, und erst jetzt tragen Agenten-Briefings den Skill. Ersetzt ein Skill andere Skills, archiviert das Bestätigen sie. Der Vorschlag zeigt jede dieser Änderungen vorher.\n\nGut zu wissen:\n\n- Verschieben, Bearbeiten oder Verwerfen macht einen Eintrag nie zu Wissen.\n- Ändert sich ein Vorschlag oder eine seiner Quellen, prüfst du ihn erneut.\n- Zugangsdaten wie API-Schlüssel und Tokens ersetzt SubKit, bevor ein Eintrag gespeichert wird.\n- Das Original des Eintrags bleibt mit dem Wissen oder Skill verknüpft.\n- Wie du bestätigte Quellen und Skills weiter pflegst, steht im Kapitel „Quellen, Skills und Dateien pflegen“.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| Der Web Clipper meldet keine Verbindung oder einen ungültigen Schlüssel | Folge „Wenn etwas nicht klappt“ im Kapitel „Webseiten mit dem Web Clipper sammeln“. |\n| Ein Eintrag fehlt im **Eingang** | Prüfe Kategorie und Herkunft. Hebe den Filter **Herkunft** auf. |\n| „Dafür fehlen dir die Rechte. …“ | Bitte eine Administratorin oder einen Administrator um `intake:confirm` und das Recht für das Ziel. |\n| „Dieser Vorschlag hat sich geändert. Prüfe den aktuellen Inhalt, bevor du bestätigst.“ | Lies den aktuellen Inhalt und bestätige dann erneut. |\n| „Ein Skill, auf den sich dieser Vorschlag bezieht, lässt sich nicht mehr laden. …“ | Überarbeite den Vorschlag im Chat, bevor du bestätigst. |"
        }
      }
    },
    {
      "slug": "http-api",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 6,
      "generated": false,
      "locales": {
        "en": {
          "title": "Use the HTTP API",
          "summary": "Start workflows from your own code and read their results.",
          "headings": [
            {
              "depth": 2,
              "text": "Use the HTTP API",
              "anchor": "use-the-http-api"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Reach the engine",
              "anchor": "reach-the-engine"
            },
            {
              "depth": 3,
              "text": "Create and check an API key",
              "anchor": "create-and-check-an-api-key"
            },
            {
              "depth": 3,
              "text": "List your workflows",
              "anchor": "list-your-workflows"
            },
            {
              "depth": 3,
              "text": "Start a run",
              "anchor": "start-a-run"
            },
            {
              "depth": 3,
              "text": "Start a long run in the background",
              "anchor": "start-a-long-run-in-the-background"
            },
            {
              "depth": 3,
              "text": "Read the result",
              "anchor": "read-the-result"
            },
            {
              "depth": 3,
              "text": "Check whether a workflow can run automatically",
              "anchor": "check-whether-a-workflow-can-run-automatically"
            },
            {
              "depth": 3,
              "text": "Export and import a package",
              "anchor": "export-and-import-a-package"
            },
            {
              "depth": 3,
              "text": "Page through lists",
              "anchor": "page-through-lists"
            },
            {
              "depth": 3,
              "text": "How the API is organized",
              "anchor": "how-the-api-is-organized"
            },
            {
              "depth": 3,
              "text": "Errors and status codes",
              "anchor": "errors-and-status-codes"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [],
          "sha256": "4e9d2cb1598f918ea10088ec0e3c684826954159a9e4b38331c7e3236293fafa",
          "body": "## Use the HTTP API\n\nYour program, script or backend should start an approved workflow and keep working with its result.\nThis chapter is for developers and takes you from the first key to a run you have read.\nAfterwards you know how to start runs, wait for them and handle errors cleanly.\n\nEvery example uses `curl`, so you can try it in a terminal first.\nSubKit Cloud and a self-hosted engine behave the same here.\n\n### What you need\n\n- Your engine address.\n  - Cloud: `https://subkit-cloud.mikebild.info` (without `/cockpit`)\n  - Self-hosted: `https://<your-engine>`\n- An API key with the scopes `workflow:read`, `workflow:run` and `execution:read`. A scope is a single permission the key carries. Create the key with the sk CLI, as shown below, or in the Cockpit under **API access**. For the CLI, sign in as described in \"Use the sk CLI on your machine\".\n- A workflow that is active and approved. See \"Your first workflow\".\n- `curl` in your terminal.\n\n### Reach the engine\n\n`/health` needs no key.\n\n1. Set the address as a variable:\n\n   ```bash\n   export SK_URL=https://<your-engine>\n   ```\n\n2. Call `/health`:\n\n   ```bash\n   curl -s \"$SK_URL/health\"\n   ```\n\n   ```json\n   { \"status\": \"ok\", \"service\": \"subkit\", \"version\": \"<version>\" }\n   ```\n\n### Create and check an API key\n\n1. Create a key with exactly the permissions this chapter needs:\n\n   ```bash\n   sk apikeys create --name http-api-test --scopes workflow:read,workflow:run,execution:read\n   ```\n\n2. Copy `plaintext_key` from the JSON response. It is shown only once, so keep it in a password manager.\n3. Put the key in a variable:\n\n   ```bash\n   export SK_KEY=<api-key>\n   ```\n\n4. Ask the engine who you are:\n\n   ```bash\n   curl -s \"$SK_URL/v1/identity/whoami\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n   The answer names your account, your workspace and the key's scopes (shortened). The workspace is your team's separate area in the engine:\n\n   ```json\n   {\n     \"id\": \"<user-id>\",\n     \"kind\": \"user\",\n     \"tenant_slug\": \"<workspace>\",\n     \"role_name\": \"admin\",\n     \"scopes\": [\"workflow:read\", \"workflow:run\", \"execution:read\"]\n   }\n   ```\n\nWithout `--scopes`, the key gets the same scopes as your own access.\n`sk apikeys revoke <key-id>` revokes the key.\n\n### List your workflows\n\n1. Fetch the active workflows:\n\n   ```bash\n   curl -s \"$SK_URL/v1/workflows?status=active&limit=20\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n   Each entry in `items` carries, among others, `id`, `slug`, `name`, `lifecycle` and `operating_status`. In the example the workflow is called \"Daily report\" (shortened):\n\n   ```json\n   {\n     \"items\": [\n       {\n         \"id\": \"<workflow-id>\",\n         \"slug\": \"daily-report\",\n         \"name\": \"Daily report\",\n         \"lifecycle\": \"active\",\n         \"operating_status\": \"active\"\n       }\n     ],\n     \"total\": 1,\n     \"categories\": [{ \"category\": \"reporting\", \"count\": 1 }]\n   }\n   ```\n\n2. Copy the `id`. A run needs the ID; the engine does not accept a slug.\n\n`q=<text>` searches name, slug, description and category.\n\n### Start a run\n\n- Send the workflow ID and its input to `/v1/executions`:\n\n  ```bash\n  curl -s -X POST \"$SK_URL/v1/executions\" \\\n    -H \"Authorization: Bearer $SK_KEY\" \\\n    -H \"Content-Type: application/json\" \\\n    -d '{\"source\":\"saved\",\"workflow_id\":\"<workflow-id>\",\"input\":{}}'\n  ```\n\n  The call waits for the run and answers `200` with `execution_id`, `status`, `output` and `steps`.\n\n`input` must match the workflow's input. `GET /v1/workflows/<workflow-id>/input-schema` shows what it expects.\n\n### Start a long run in the background\n\n1. Send the run with `\"async\":true`. Optionally add an `Idempotency-Key` header. With it, a call sent twice by accident still starts only one run:\n\n   ```bash\n   curl -s -X POST \"$SK_URL/v1/executions\" \\\n     -H \"Authorization: Bearer $SK_KEY\" \\\n     -H \"Content-Type: application/json\" \\\n     -H \"Idempotency-Key: daily-report-<date>\" \\\n     -d '{\"source\":\"saved\",\"workflow_id\":\"<workflow-id>\",\"input\":{},\"async\":true}'\n   ```\n\n   The engine answers `202` right away:\n\n   ```json\n   { \"execution_id\": \"<execution-id>\", \"status\": \"queued\", \"hold_writes\": false }\n   ```\n\n2. Copy `execution_id` and read the result as described in the next section.\n\n- The `Idempotency-Key` header takes 1 to 200 characters.\n- If you send the same key again, no second run starts. The answer carries the first run's ID and `\"idempotent_replay\": true`.\n\n### Read the result\n\n1. Read the run:\n\n   ```bash\n   curl -s \"$SK_URL/v1/executions/<execution-id>\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n2. Check `status`.\n3. On a failure, read `outcome.failed_step` for the step and `error` for the cause.\n4. Read each step's output:\n\n   ```bash\n   curl -s \"$SK_URL/v1/executions/<execution-id>/steps\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n   Each entry has `step_key`, `status` and a preview in `output_preview` or `result_preview`. The last step usually holds the workflow's result.\n\n| `status` | Meaning |\n| --- | --- |\n| `queued`, `running` | The run is still working. |\n| `succeeded` | The run is done. |\n| `failed`, `timed_out`, `aborted` | The run stopped early. |\n\n`outcome.kind` summarizes the run, for example `succeeded`, `failed` or `held`.\n`sk executions result <execution-id>` shows the same result in your terminal.\n\n### Check whether a workflow can run automatically\n\nBefore a workflow runs on a schedule, you want to know whether an approval can cover it at all. The field `automation_readiness` holds that answer.\n\nYou get it when you save a workflow (`POST /v1/workflows`, `PUT /v1/workflows/{id}`). You also get it when you create or change a schedule (`POST /v1/schedules`, `PUT /v1/schedules/{id}`). The field has the shape `{environment, workflow_version_id, state, issues, repair_guidance}`.\n\n| `state` | Meaning |\n| --- | --- |\n| `eligible` | A person can approve recurring runs. |\n| `repair_required` | No approval can cover the named steps until they change. |\n| `verification_unavailable` | The engine could not run the check. Try again later. |\n\nEach `issues` entry names a `step_id` and a `code`. `repair_guidance` says how to change that step. A paused schedule gets no verdict.\n\n### Export and import a package\n\nA package moves your workspace's own resources to another engine. The steps after the import are in \"Use the sk CLI on your machine\".\nExport needs `package:export`, import needs `package:import`.\n\n| Route | Does |\n| --- | --- |\n| `POST /v1/packages/export` | Creates the package and answers with its `file_id`. |\n| `GET /v1/packages/archives/{file_id}` | Downloads the package as a zip file. |\n| `POST /v1/packages/import/preview` | Takes the zip as multipart field `archive`, or `{\"archive_file_id\": \"<file-id>\"}`. Answers with a plan per item and a `plan_digest`. Changes nothing. |\n| `POST /v1/packages/import/apply` | Takes `{\"archive_file_id\": \"<file-id>\", \"expected_plan_digest\": \"<plan-digest>\"}` and applies the plan. |\n| `GET /v1/packages/installs`, `GET /v1/packages/installs/{id}` | Lists past imports. |\n\nIf the target changed after the preview, apply answers `409`. Run the preview again.\n\n### Page through lists\n\nLists return one page at a time. `total` counts all matches.\n\n| List | Page size | Next page |\n| --- | --- | --- |\n| `GET /v1/workflows` | `limit` (up to 200) | `offset`: skip that many entries |\n| `GET /v1/executions` | `limit` (up to 200) | `cursor`: the previous page's `next_cursor` |\n\nRuns come newest first. Pass `next_cursor` back exactly as you received it. When it is `null`, you are on the last page.\n\n```bash\ncurl -s \"$SK_URL/v1/executions?workflow_id=<workflow-id>&status=failed,timed_out&limit=50\" \\\n  -H \"Authorization: Bearer $SK_KEY\"\n```\n\n`status` takes several values, separated by commas.\n\n### How the API is organized\n\n- Every route starts with `/v1`, for example `/v1/workflows`.\n- You send your API key in the `Authorization` header as `Bearer <api-key>`. \"Bearer\" means: whoever presents the key counts as authorized.\n- Requests and responses are JSON.\n- `/openapi.json` describes every route, field and status code in OpenAPI format.\n- `/docs` shows the same description as a searchable reference. Open `https://<your-engine>/docs` in a browser.\n\n### Errors and status codes\n\nErrors are JSON with a machine-readable `code` and a readable `message`:\n\n```json\n{\n  \"code\": \"not_found\",\n  \"message\": \"workflow not found\",\n  \"trace_id\": \"<trace-id>\"\n}\n```\n\nSome errors add `hint` (what to do), `details` (for example the invalid fields) or `retry_after` (seconds).\nBranch on `code` in your program, not on `message`. Keep `trace_id` when you report a problem.\n\n| Status | `code` (examples) | Meaning |\n| --- | --- | --- |\n| `200` | | Done. |\n| `202` | | Accepted. The run continues in the background. |\n| `400` | `bad_request` | The request is invalid. `details` names the fields. |\n| `401` | `unauthorized` | The key is missing, wrong, expired or revoked. Check `Authorization: Bearer <api-key>`, or create a new key. |\n| `403` | `forbidden` | The key lacks a scope or your role lacks the permission. Create a key with `workflow:read`, `workflow:run` and `execution:read`. |\n| `404` | `not_found` | The ID does not exist in your workspace. |\n| `409` | `conflict` | The current state does not allow it. For a run: there is no active version, or the approval is missing or used up. |\n| `429` | `rate_limit_exceeded`, `rate_limited` | A limit is reached. Wait as long as the `Retry-After` header says. Then retry with the same `Idempotency-Key`. |\n| `500` | `internal_error` | An error in the engine. Report the `trace_id`. |\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| `404 Not Found` as plain text | The path does not exist. Check that it starts with `/v1`. |\n| `400` with `request validation failed` | Read `details`. Often `workflow_id` is not a UUID or `input` does not match the input schema. |\n| The run answers with `\"hold_writes\": true` | The version has no approval for this environment. Nothing was written. Approve it as described in \"Your first workflow\". |\n| Any other error status | Look up the status in \"Errors and status codes\" and read `message` and `details`. |"
        },
        "de": {
          "title": "Die HTTP-API nutzen",
          "summary": "Starte Workflows aus deinem eigenen Programm und lies ihre Ergebnisse.",
          "headings": [
            {
              "depth": 2,
              "text": "Die HTTP-API nutzen",
              "anchor": "die-http-api-nutzen"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Die Engine erreichen",
              "anchor": "die-engine-erreichen"
            },
            {
              "depth": 3,
              "text": "Einen API-Schlüssel anlegen und prüfen",
              "anchor": "einen-api-schlüssel-anlegen-und-prüfen"
            },
            {
              "depth": 3,
              "text": "Deine Workflows auflisten",
              "anchor": "deine-workflows-auflisten"
            },
            {
              "depth": 3,
              "text": "Einen Lauf starten",
              "anchor": "einen-lauf-starten"
            },
            {
              "depth": 3,
              "text": "Einen langen Lauf im Hintergrund starten",
              "anchor": "einen-langen-lauf-im-hintergrund-starten"
            },
            {
              "depth": 3,
              "text": "Das Ergebnis lesen",
              "anchor": "das-ergebnis-lesen"
            },
            {
              "depth": 3,
              "text": "Prüfen, ob ein Workflow automatisch laufen kann",
              "anchor": "prüfen-ob-ein-workflow-automatisch-laufen-kann"
            },
            {
              "depth": 3,
              "text": "Ein Paket exportieren und importieren",
              "anchor": "ein-paket-exportieren-und-importieren"
            },
            {
              "depth": 3,
              "text": "Seitenweise lesen",
              "anchor": "seitenweise-lesen"
            },
            {
              "depth": 3,
              "text": "So ist die API aufgebaut",
              "anchor": "so-ist-die-api-aufgebaut"
            },
            {
              "depth": 3,
              "text": "Fehler und Statuscodes",
              "anchor": "fehler-und-statuscodes"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [],
          "sha256": "2319767dfdda5b4f06fb4ad6012b0dba9d642a1ac5335dadb370726be4462097",
          "body": "## Die HTTP-API nutzen\n\nDein Programm, Skript oder Backend soll einen freigegebenen Workflow starten und mit dem Ergebnis weiterarbeiten.\nDieses Kapitel ist für Entwickler und führt dich vom ersten Schlüssel bis zum gelesenen Lauf.\nDanach weißt du, wie du Läufe startest, auf sie wartest und Fehler sauber behandelst.\n\nAlle Beispiele nutzen `curl`, du kannst sie also zuerst im Terminal ausprobieren.\nSubKit Cloud und eine selbst betriebene Engine verhalten sich dabei gleich.\n\n### Was du brauchst\n\n- Die Adresse deiner Engine.\n  - Cloud: `https://subkit-cloud.mikebild.info` (ohne `/cockpit`)\n  - Selbst betrieben: `https://<deine-engine>`\n- Einen API-Schlüssel mit den Scopes `workflow:read`, `workflow:run` und `execution:read`. Ein Scope ist ein einzelnes Recht, das der Schlüssel mitbringt. Leg den Schlüssel mit der sk-CLI an, wie unten gezeigt, oder im Cockpit unter **API-Zugang**. Für die CLI meldest du dich an wie in „Die sk-CLI auf deinem Rechner verwenden“ beschrieben.\n- Einen Workflow, der aktiv und freigegeben ist. Siehe „Dein erster Workflow“.\n- `curl` in deinem Terminal.\n\n### Die Engine erreichen\n\n`/health` braucht keinen Schlüssel.\n\n1. Setze die Adresse als Variable:\n\n   ```bash\n   export SK_URL=https://<deine-engine>\n   ```\n\n2. Rufe `/health` auf:\n\n   ```bash\n   curl -s \"$SK_URL/health\"\n   ```\n\n   ```json\n   { \"status\": \"ok\", \"service\": \"subkit\", \"version\": \"<version>\" }\n   ```\n\n### Einen API-Schlüssel anlegen und prüfen\n\n1. Leg einen Schlüssel mit genau den Rechten an, die dieses Kapitel braucht:\n\n   ```bash\n   sk apikeys create --name http-api-test --scopes workflow:read,workflow:run,execution:read\n   ```\n\n2. Kopiere `plaintext_key` aus der JSON-Antwort. Er wird nur einmal angezeigt, bewahre ihn in einem Passwortmanager auf.\n3. Leg den Schlüssel in eine Variable:\n\n   ```bash\n   export SK_KEY=<api-key>\n   ```\n\n4. Frag die Engine, wer du bist:\n\n   ```bash\n   curl -s \"$SK_URL/v1/identity/whoami\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n   Die Antwort nennt dein Konto, deinen Arbeitsbereich und die Scopes des Schlüssels (gekürzt). Der Arbeitsbereich ist der abgetrennte Bereich deines Teams in der Engine:\n\n   ```json\n   {\n     \"id\": \"<user-id>\",\n     \"kind\": \"user\",\n     \"tenant_slug\": \"<workspace>\",\n     \"role_name\": \"admin\",\n     \"scopes\": [\"workflow:read\", \"workflow:run\", \"execution:read\"]\n   }\n   ```\n\nOhne `--scopes` bekommt der Schlüssel dieselben Scopes wie dein eigener Zugang.\n`sk apikeys revoke <key-id>` widerruft den Schlüssel.\n\n### Deine Workflows auflisten\n\n1. Rufe die aktiven Workflows ab:\n\n   ```bash\n   curl -s \"$SK_URL/v1/workflows?status=active&limit=20\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n   Jeder Eintrag in `items` trägt unter anderem `id`, `slug`, `name`, `lifecycle` und `operating_status`. Im Beispiel heißt der Workflow „Tagesbericht“ (gekürzt):\n\n   ```json\n   {\n     \"items\": [\n       {\n         \"id\": \"<workflow-id>\",\n         \"slug\": \"tagesbericht\",\n         \"name\": \"Tagesbericht\",\n         \"lifecycle\": \"active\",\n         \"operating_status\": \"active\"\n       }\n     ],\n     \"total\": 1,\n     \"categories\": [{ \"category\": \"reporting\", \"count\": 1 }]\n   }\n   ```\n\n2. Kopiere die `id`. Ein Lauf braucht die ID, einen Slug nimmt die Engine nicht an.\n\n`q=<text>` durchsucht Name, Slug, Beschreibung und Kategorie.\n\n### Einen Lauf starten\n\n- Schick die Workflow-ID und die Eingabe an `/v1/executions`:\n\n  ```bash\n  curl -s -X POST \"$SK_URL/v1/executions\" \\\n    -H \"Authorization: Bearer $SK_KEY\" \\\n    -H \"Content-Type: application/json\" \\\n    -d '{\"source\":\"saved\",\"workflow_id\":\"<workflow-id>\",\"input\":{}}'\n  ```\n\n  Der Aufruf wartet auf den Lauf und antwortet mit `200`, `execution_id`, `status`, `output` und `steps`.\n\n`input` muss zur Eingabe des Workflows passen. `GET /v1/workflows/<workflow-id>/input-schema` zeigt, was er erwartet.\n\n### Einen langen Lauf im Hintergrund starten\n\n1. Schick den Lauf mit `\"async\":true`. Optional ergänzt du einen Header `Idempotency-Key`. Mit ihm startet ein versehentlich doppelt gesendeter Aufruf trotzdem nur einen Lauf:\n\n   ```bash\n   curl -s -X POST \"$SK_URL/v1/executions\" \\\n     -H \"Authorization: Bearer $SK_KEY\" \\\n     -H \"Content-Type: application/json\" \\\n     -H \"Idempotency-Key: tagesbericht-<datum>\" \\\n     -d '{\"source\":\"saved\",\"workflow_id\":\"<workflow-id>\",\"input\":{},\"async\":true}'\n   ```\n\n   Die Engine antwortet sofort mit `202`:\n\n   ```json\n   { \"execution_id\": \"<execution-id>\", \"status\": \"queued\", \"hold_writes\": false }\n   ```\n\n2. Kopiere `execution_id` und lies das Ergebnis wie im nächsten Abschnitt beschrieben.\n\n- Der Header `Idempotency-Key` nimmt 1 bis 200 Zeichen.\n- Schickst du denselben Schlüssel noch einmal, startet kein zweiter Lauf. Die Antwort trägt die ID des ersten Laufs und `\"idempotent_replay\": true`.\n\n### Das Ergebnis lesen\n\n1. Lies den Lauf:\n\n   ```bash\n   curl -s \"$SK_URL/v1/executions/<execution-id>\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n2. Prüfe `status`.\n3. Lies bei einem Fehler `outcome.failed_step` für den Schritt und `error` für die Ursache.\n4. Lies die Ausgabe jedes Schritts:\n\n   ```bash\n   curl -s \"$SK_URL/v1/executions/<execution-id>/steps\" \\\n     -H \"Authorization: Bearer $SK_KEY\"\n   ```\n\n   Jeder Eintrag hat `step_key`, `status` und eine Vorschau in `output_preview` oder `result_preview`. Der letzte Schritt enthält meist das Ergebnis des Workflows.\n\n| `status` | Bedeutung |\n| --- | --- |\n| `queued`, `running` | Der Lauf arbeitet noch. |\n| `succeeded` | Der Lauf ist fertig. |\n| `failed`, `timed_out`, `aborted` | Der Lauf wurde vorzeitig beendet. |\n\n`outcome.kind` fasst den Lauf zusammen, zum Beispiel `succeeded`, `failed` oder `held`.\n`sk executions result <execution-id>` zeigt dasselbe Ergebnis im Terminal.\n\n### Prüfen, ob ein Workflow automatisch laufen kann\n\nBevor ein Workflow nach Zeitplan läuft, willst du wissen, ob eine Freigabe ihn überhaupt abdecken kann. Diese Antwort steckt im Feld `automation_readiness`.\n\nDu bekommst es beim Speichern eines Workflows (`POST /v1/workflows`, `PUT /v1/workflows/{id}`). Ebenso beim Anlegen oder Ändern eines Zeitplans (`POST /v1/schedules`, `PUT /v1/schedules/{id}`). Das Feld hat die Form `{environment, workflow_version_id, state, issues, repair_guidance}`.\n\n| `state` | Bedeutung |\n| --- | --- |\n| `eligible` | Eine Person kann wiederkehrende Läufe freigeben. |\n| `repair_required` | Keine Freigabe kann die genannten Schritte abdecken, solange sie nicht geändert sind. |\n| `verification_unavailable` | Die Engine konnte die Prüfung nicht durchführen. Versuch es später erneut. |\n\nJeder Eintrag in `issues` nennt `step_id` und `code`. `repair_guidance` sagt, wie du den Schritt änderst. Ein pausierter Zeitplan bekommt kein Urteil.\n\n### Ein Paket exportieren und importieren\n\nEin Paket bringt die eigenen Ressourcen deines Arbeitsbereichs auf eine andere Engine. Die Schritte nach dem Import stehen in „Die sk-CLI auf deinem Rechner verwenden“.\nDer Export braucht `package:export`, der Import `package:import`.\n\n| Route | Macht |\n| --- | --- |\n| `POST /v1/packages/export` | Erstellt das Paket und antwortet mit seiner `file_id`. |\n| `GET /v1/packages/archives/{file_id}` | Lädt das Paket als ZIP-Datei herunter. |\n| `POST /v1/packages/import/preview` | Nimmt die ZIP-Datei als Multipart-Feld `archive` oder `{\"archive_file_id\": \"<file-id>\"}`. Antwortet mit einem Plan pro Eintrag und einem `plan_digest`. Ändert nichts. |\n| `POST /v1/packages/import/apply` | Nimmt `{\"archive_file_id\": \"<file-id>\", \"expected_plan_digest\": \"<plan-digest>\"}` und wendet den Plan an. |\n| `GET /v1/packages/installs`, `GET /v1/packages/installs/{id}` | Listet frühere Importe. |\n\nHat sich das Ziel nach der Vorschau geändert, antwortet apply mit `409`. Starte die Vorschau erneut.\n\n### Seitenweise lesen\n\nListen liefern jeweils eine Seite. `total` zählt alle Treffer.\n\n| Liste | Seitengröße | Nächste Seite |\n| --- | --- | --- |\n| `GET /v1/workflows` | `limit` (bis 200) | `offset`: so viele Einträge überspringen |\n| `GET /v1/executions` | `limit` (bis 200) | `cursor`: der `next_cursor` der vorigen Seite |\n\nLäufe kommen neueste zuerst. Gib `next_cursor` genau so zurück, wie du ihn bekommen hast. Ist er `null`, bist du auf der letzten Seite.\n\n```bash\ncurl -s \"$SK_URL/v1/executions?workflow_id=<workflow-id>&status=failed,timed_out&limit=50\" \\\n  -H \"Authorization: Bearer $SK_KEY\"\n```\n\n`status` nimmt mehrere Werte, durch Kommas getrennt.\n\n### So ist die API aufgebaut\n\n- Jede Route beginnt mit `/v1`, zum Beispiel `/v1/workflows`.\n- Deinen API-Schlüssel schickst du im Header `Authorization` als `Bearer <api-key>`. „Bearer“ heißt: Wer den Schlüssel vorzeigt, gilt als berechtigt.\n- Anfragen und Antworten sind JSON.\n- `/openapi.json` beschreibt jede Route, jedes Feld und jeden Statuscode im OpenAPI-Format.\n- `/docs` zeigt dieselbe Beschreibung als durchsuchbare Referenz. Öffne `https://<deine-engine>/docs` im Browser.\n\n### Fehler und Statuscodes\n\nFehler sind JSON mit einem maschinenlesbaren `code` und einer lesbaren `message`:\n\n```json\n{\n  \"code\": \"not_found\",\n  \"message\": \"workflow not found\",\n  \"trace_id\": \"<trace-id>\"\n}\n```\n\nManche Fehler ergänzen `hint` (was zu tun ist), `details` (zum Beispiel die ungültigen Felder) oder `retry_after` (Sekunden).\nVerzweige in deinem Programm nach `code`, nicht nach `message`. Heb `trace_id` auf, wenn du ein Problem meldest.\n\n| Status | `code` (Beispiele) | Bedeutung |\n| --- | --- | --- |\n| `200` | | Erledigt. |\n| `202` | | Angenommen. Der Lauf geht im Hintergrund weiter. |\n| `400` | `bad_request` | Die Anfrage ist ungültig. `details` nennt die Felder. |\n| `401` | `unauthorized` | Der Schlüssel fehlt, ist falsch, abgelaufen oder widerrufen. Prüfe `Authorization: Bearer <api-key>` oder leg einen neuen Schlüssel an. |\n| `403` | `forbidden` | Dem Schlüssel fehlt ein Scope oder deiner Rolle das Recht. Leg einen Schlüssel mit `workflow:read`, `workflow:run` und `execution:read` an. |\n| `404` | `not_found` | Die ID gibt es in deinem Arbeitsbereich nicht. |\n| `409` | `conflict` | Der aktuelle Zustand erlaubt es nicht. Bei einem Lauf: Es gibt keine aktive Version, oder die Freigabe fehlt oder ist aufgebraucht. |\n| `429` | `rate_limit_exceeded`, `rate_limited` | Ein Limit ist erreicht. Warte so lange, wie der Header `Retry-After` sagt. Versuch es dann mit demselben `Idempotency-Key` erneut. |\n| `500` | `internal_error` | Ein Fehler in der Engine. Melde die `trace_id`. |\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| `404 Not Found` als reiner Text | Den Pfad gibt es nicht. Prüfe, ob er mit `/v1` beginnt. |\n| `400` mit `request validation failed` | Lies `details`. Oft ist `workflow_id` keine UUID, oder `input` passt nicht zum Eingabeschema. |\n| Der Lauf antwortet mit `\"hold_writes\": true` | Die Version hat für diese Umgebung keine Freigabe. Nichts wurde geschrieben. Gib sie frei wie in „Dein erster Workflow“ beschrieben. |\n| Ein anderer Fehlerstatus | Schlag den Status unter „Fehler und Statuscodes“ nach und lies `message` und `details`. |"
        }
      }
    },
    {
      "slug": "onboard-an-app",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 7,
      "generated": false,
      "locales": {
        "en": {
          "title": "Onboard an app",
          "summary": "Connect an app with its own sign-in so it can start workflows.",
          "headings": [
            {
              "depth": 2,
              "text": "Onboard an app",
              "anchor": "onboard-an-app"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "1. Choose the product ID and sign-in rules",
              "anchor": "1-choose-the-product-id-and-sign-in-rules"
            },
            {
              "depth": 3,
              "text": "2. Set the runtime configuration",
              "anchor": "2-set-the-runtime-configuration"
            },
            {
              "depth": 3,
              "text": "3. Create the connectors",
              "anchor": "3-create-the-connectors"
            },
            {
              "depth": 3,
              "text": "4. Create the workflows",
              "anchor": "4-create-the-workflows"
            },
            {
              "depth": 3,
              "text": "5. Approve the workflows",
              "anchor": "5-approve-the-workflows"
            },
            {
              "depth": 3,
              "text": "6. Test the app's access",
              "anchor": "6-test-the-apps-access"
            },
            {
              "depth": 3,
              "text": "Renew a connector's credentials",
              "anchor": "renew-a-connectors-credentials"
            },
            {
              "depth": 3,
              "text": "Roll back an app",
              "anchor": "roll-back-an-app"
            },
            {
              "depth": 3,
              "text": "Erase an app user",
              "anchor": "erase-an-app-user"
            },
            {
              "depth": 3,
              "text": "Inspect an app",
              "anchor": "inspect-an-app"
            },
            {
              "depth": 3,
              "text": "Where each setting lives",
              "anchor": "where-each-setting-lives"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [],
          "sha256": "9fb3ca5e0ce24377b25ae2748192b927e02ca036c7e374375c22e43fb3b58d00",
          "body": "## Onboard an app\n\nYour app signs its users in at its own identity provider and should start SubKit workflows on their behalf.\nThis checklist is for developers who set up that connection.\nAt the end, the app calls SubKit with its users' tokens and needs only the product ID and the workflow IDs.\n\nThe identity provider is the service your users sign in at.\nAfter sign-in it issues an access token, a signed and time-limited proof of who the person is.\nThe app sends this token to SubKit as a bearer token in the `Authorization` header.\nSubKit checks the token's signature, issuer and audience before a run starts.\n\nWork through the steps in order.\nHosts and IDs in the examples are placeholders (`example.test`, `<...>`).\n\n### What you need\n\n- The `sk` CLI, signed in to your engine. In SubKit Cloud the engine address is `https://subkit-cloud.mikebild.info`, without `/cockpit`.\n- A real access token of a test account of the app.\n- Access to the services the workflows call, such as your AI model's API.\n\n### 1. Choose the product ID and sign-in rules\n\nPick these values before you change any setting.\nA claim is a field in the token, such as `iss` (who issued it) or `aud` (who it is meant for).\nRead both from a real token of the app.\n\n| Setting | What to enter | Example |\n| --- | --- | --- |\n| `product_id` | A lowercase name (`^[a-z][a-z0-9-]{0,62}$`), one per app. It ties provider, workflows, budget and identity binding together. | `<product-id>` |\n| `issuer_url` | The provider's issuer, exactly as in the token's `iss` claim. HTTPS outside localhost. | `https://idp.example.test` |\n| `audience` | Who the token is meant for: the value of the `aud` claim. The issuer defines it; SubKit has no default. | `<audience>` |\n| `required_claims` | Who may sign in: a dot path into the verified token with an exact value. The key is required. | `[{\"path\":\"idp\",\"equals\":\"primary\"}]` |\n\nThe first verified token of a person creates a product user with the built-in member role.\nAn empty `required_claims` list `[]` admits every token of that issuer and audience.\nIf not every person with a token should become a user, narrow `required_claims` to the intended accounts.\n\n### 2. Set the runtime configuration\n\nThe runtime configuration is your engine's settings, which you read and write with `sk settings`.\n`auth.providers` and `products` are each replaced as a whole.\nSo read each value first and write it back with your addition.\n\n1. Read the current sign-in providers.\n\n```bash\nsk settings get auth.providers --json\n```\n\n2. Add your provider entry and write the whole list back. Keep every existing entry, or it is lost.\n\n```bash\nsk settings set auth.providers '[\n  {\"protocol\":\"api_key\",\"id\":\"api-key\",\"label\":\"SubKit API key\"},\n  {\"protocol\":\"oidc_bearer\",\"id\":\"<provider-id>\",\"label\":\"<app> account\",\n   \"issuer_url\":\"https://idp.example.test\",\"audience\":\"<audience>\",\"algorithms\":[\"ES256\"],\n   \"product_id\":\"<product-id>\",\"tenant_slug\":\"default\",\n   \"required_claims\":[{\"path\":\"idp\",\"equals\":\"primary\"}],\n   \"reject_anonymous\":true,\"clock_tolerance_s\":30}\n]'\n```\n\n3. Read the current products.\n\n```bash\nsk settings get products --json\n```\n\n4. Add your product entry and write the whole value back.\n\n```bash\nsk settings set products '{\"<product-id>\":{\"execution_environment\":\"prod\",\n  \"assistant_workflow_id\":\"<assistant-workflow-id>\",\"budget_bucket\":\"<bucket>\"}}'\n```\n\n`tenant_slug` names the workspace, the separate area in the engine where SubKit creates the app's users.\n`assistant_workflow_id` is the ID you choose for the guarded workflow in step 4.\nOnce steps 3 to 5 are done, `sk apps show <product-id>` shows what the values add up to.\n\n### 3. Create the connectors\n\nCreate one connector for each service the workflows call.\nThat is usually the AI model's API and, if the app deletes accounts, the identity provider's admin API.\n\n1. Write each definition as a JSON file without any credentials.\n2. Create the connector.\n3. Store the credentials.\n\n```bash\nsk connectors create --file connector-model.json --skip-checks\nsk credentials set <model-connector-id> --mode bearer --token \"$MODEL_API_KEY\"\nsk credentials set <idp-admin-connector-id> --mode header --header \"Authorization=Bearer $IDP_ADMIN_KEY,apikey=$IDP_ADMIN_KEY\"\n```\n\n- `--skip-checks` is needed because the credentials are still missing when the connector is created. `credentials set` checks them afterwards.\n- `bearer` sends `Authorization: Bearer <token>`. `header` sends the named headers (comma-separated `Name=Value`).\n- Credentials come from your shell or secret store, never from a file, the app or this repository.\n- If you replace credentials with several headers in the Cockpit, fill all header fields. If you leave all of them empty, the old values stay.\n\nSo that SubKit can check the credentials, give the connector a probe. That is a small read that requires sign-in:\n\n```json\n\"config\": {\"probe_endpoint\": {\"method\": \"GET\", \"path\": \"/admin/users?per_page=1\", \"expected_status\": [200, 200]}}\n```\n\nThen run `sk connectors test <id>`.\nIf the probe answers 401 or 403, the connector counts as signed out. Its workflows are then blocked.\n\n### 4. Create the workflows\n\nKeep the definitions in the app's own repository.\nCreate them with fixed IDs so the app can hard-code them.\nOnly an administrator may choose a workflow `id` (an unused UUID).\n\n```bash\nsk workflows create --file workflows/assistant.json\nsk workflows create --file workflows/delete-account.json\n```\n\nEach product workflow sets:\n\n- `\"id\": \"<fixed-uuid>\"` and `\"product_id\": \"<product-id>\"`.\n- `\"required_caller_kind\": \"user\"` and `\"execution_privacy\": \"sensitive\"`.\n- On the workflow whose use is limited per user and day, `execution_guards.caller_daily_limit` (bucket equal to `budget_bucket`, limit, `tz`, unit path) and `execution_guards.input_bytes`.\n- On the deletion workflow, `\"caller_erasure\": \"on_success\"`.\n\nThe identity provider owns the account. SubKit owns only its own records of the calling person.\nThe deletion workflow therefore runs in this order:\n\n1. Delete the account at the identity provider with the admin connector, using `${caller.subject}` (bound with `{caller_bound: true}`). A 404 means \"already gone\" and counts as success.\n2. Revoke tokens at other services as far as possible. A failure here must not block step 3.\n3. SubKit erases its own caller data last, through `caller_erasure: \"on_success\"`. Tokens issued earlier are then refused.\n\nIf step 1 fails, the run fails and nothing is erased. The app retries with the same `idempotency_key`.\n\n### 5. Approve the workflows\n\nWithout a valid approval, a product run answers 403.\nA person with write access approves each product workflow once per environment.\n\n1. In the Cockpit, open **Workflows** and click the workflow.\n2. Select **Approve** in the status line or on the **Approvals** tab. The dialog **Approve <workflow> v<n>** opens.\n3. Check that **Environment** (**Production** or **Test**) matches the product's `execution_environment`.\n4. Review the connectors, addresses and read or write access.\n5. Under **Validity**, choose **7 days**, **30 days** or **Until revoked**. **Until revoked** is preset and sets no run limit and no end date.\n6. Select **Approve**. Approving starts no run.\n\nA workflow that only the app's HTTP calls start is checked in the environment of its connectors.\nIts status line may read \"Not approved\" without a fix banner.\nIf a connector is missing or lives in another environment, fix that first.\n\nA new version needs no new approval as long as it touches no more systems, addresses or write permissions than the approved one. If it reaches further, SubKit asks again and names the difference.\n\n### 6. Test the app's access\n\nCheck readiness first. Every check should read `ok`. A failing check prints its next action.\n\n```bash\nsk apps show <product-id>\n```\n\nThen call the engine with a real token:\n\n- `$TOKEN` is the access token of a test account.\n- `$BAD_TOKEN` is `$TOKEN` with the last characters of its signature changed.\n- `$BASE` is the engine address.\n\n```bash\ncurl -s -w '\\n%{http_code}\\n' -H \"Authorization: Bearer $BAD_TOKEN\" $BASE/v1/budget\ncurl -s -H \"Authorization: Bearer $TOKEN\" $BASE/v1/health\ncurl -s -H \"Authorization: Bearer $TOKEN\" $BASE/v1/budget\ncurl -s -X POST $BASE/v1/executions -H \"Authorization: Bearer $TOKEN\" -H 'content-type: application/json' \\\n  -d '{\"workflow_id\":\"<workflow-id>\",\"idempotency_key\":\"check-1\",\"async\":true,\"input\":{}}'\n```\n\nExpected:\n\n- `$BAD_TOKEN`, a wrong audience, a missing required claim or an expired token answers `401 invalid bearer token`.\n- `sk executions` and the run record show who called and which approval applied.\n\n### Renew a connector's credentials\n\nCredentials in connectors can expire, and admin keys get rotated regularly.\nRecord the name, connector, owner and expiry date of all credentials in the app's repository, never the value.\nRenew them before they expire.\n\n1. Store the new value with `sk credentials set`.\n2. Check it with `sk connectors test <connector-id>`.\n3. Remove the old one with `sk credentials delete <credential-id>`.\n\nThe Cockpit and `GET /v1/health` show failing connectors.\n\n### Roll back an app\n\n1. Revoke the workflow approval on the **Approvals** tab. The app then gets 403 and nothing runs.\n2. Restore the `auth.providers` and `products` values you read in step 2.\n3. Restore a workflow version with `sk workflows history <id>` and `sk workflows restore <id>`.\n\nWithout the provider entry, the app's tokens are no longer accepted. Existing caller records stay until the deletion workflow erases them.\n\n### Erase an app user\n\nErasing cannot be undone.\nIt removes SubKit's own data about one person for one app:\n\n- sign-in bindings\n- budget counters\n- sessions\n- API keys\n- the person's ID in past runs\n\nA new sign-in at the provider creates a new, empty app user.\n\n1. Find the user ID with `sk apps show <product-id>`.\n2. Run `sk apps erase-user <product-id> <user-id>` and confirm.\n\n```bash\nsk apps show <product-id>                          # lists the user ids of the app\nsk apps erase-user <product-id> <user-id>          # asks for confirmation\nsk apps erase-user <product-id> <user-id> --yes    # non-interactive; --json prints the result\n```\n\nGood to know:\n\n- Erasing needs `identity:write` and an admin role. Product users are refused.\n- The account at the sign-in provider stays. Deleting it is up to the app and its identity provider.\n- A person with sign-in links to another app or to SubKit itself is not erased (409).\n- In the Cockpit, the same action is on the user in the app's details, behind a confirmation dialog.\n\n| Interface | Call | Result |\n| --- | --- | --- |\n| HTTP | `DELETE /v1/apps/{id}/users/{user_id}` | `{ \"user_id\", \"app_id\", \"erased\": true }`, or 404 for an unknown, foreign or already erased user. |\n| HTTP | `DELETE /v1/identity/users/{id}` | Only deactivates a user. |\n| MCP (admin mode) | `list_apps`, `get_app` | Read-only. Erasing is not available. |\n\n### Inspect an app\n\nAn app is a read-only view.\nSubKit assembles it from five sources:\n\n- the `products` entry\n- the sign-in providers with the same `product_id`\n- the workflows with the same `product_id`\n- the signed-in users\n- today's budget\n\nThe app itself stores nothing.\nYou change it through `auth.providers`, `products` and the workflows (steps 2 to 5).\n\n```bash\nsk apps list                      # app, environment, users, budget today, readiness\nsk apps show <product-id>         # settings, sign-in, workflows, users, budget today, readiness\nsk apps show <product-id> --json\nsk users list --app <product-id>  # users who signed in to that app\n```\n\nIn the Cockpit, open **People & access** > **Apps** and select an app. Over HTTP, use `GET /v1/apps` and `GET /v1/apps/{id}`. Both need `settings:read`.\n\nReadiness consists of six checks:\n\n| Check | Meaning |\n| --- | --- |\n| `product_configured` | A `products` entry exists. |\n| `sign_in_provider` | A sign-in provider carries the `product_id`. |\n| `assistant_workflow` | Exists in the workspace, carries the `product_id`, is active and valid. |\n| `execution_authority` | A valid approval exists for the product's environment. |\n| `credentials` | Usable on every connector the assistant uses. |\n| `budget_guard` | A `caller_daily_limit` whose bucket equals `budget_bucket`. |\n\nBudget today shows the units used and reserved today, the refusals since local midnight (`rate_limited`, `turn_limit`, `turn_busy`) and when the day resets.\n\n### Where each setting lives\n\n| Setting | Where it lives |\n| --- | --- |\n| Provider entry, `products` entry, connectors and their credentials | Runtime configuration per deployment, set with `sk` |\n| Workflow definitions and their fixed IDs | The app's own repository, created with `sk workflows create` |\n| Workflow approvals | A person, per workflow and environment, in the Cockpit |\n| Credential expiry records | The app's own repository (metadata only) |\n\nEvery change to a sign-in provider or a `products` entry lands in the audit log. The entry names the changed fields, not their values.\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| `401 invalid bearer token` | The token was refused. Check `issuer_url`, `audience` and `required_claims` against a real token, and whether it has expired. |\n| `403` on a product run, or `ok: false` at `GET /v1/health` | The approval from step 5 or credentials are missing. Check `sk apps show <product-id>`. |\n| `429 rate_limited` | The daily limit is used up. `sk apps show` tells when the day resets. |\n| `409 turn_busy` | Another call of the same turn is still running. Wait, or resend the first call with its `idempotency_key` and the engine returns that call's result again. A different key keeps getting 409 until the first call has finished. |\n| `credential_unverified` and `PROBE_AUTH_UNVERIFIED`, or \"Connected · sign-in not verified\" in the Cockpit | The connector has no probe, and `GET /` gave no clear answer. Set a probe path with an authenticated read (step 3) and check with `sk connectors test <id>`. |\n| A connector counts as signed out | Its probe answered 401 or 403. Store the credentials again (step 3) and check with `sk connectors test <id>`. |\n| `409` when erasing an app user | The person has sign-in links to another app or to SubKit itself and is not erased. |"
        },
        "de": {
          "title": "Eine App anbinden",
          "summary": "Binde eine App mit eigener Anmeldung an, damit sie Workflows startet.",
          "headings": [
            {
              "depth": 2,
              "text": "Eine App anbinden",
              "anchor": "eine-app-anbinden"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "1. Produkt-ID und Anmelderegeln festlegen",
              "anchor": "1-produkt-id-und-anmelderegeln-festlegen"
            },
            {
              "depth": 3,
              "text": "2. Laufzeitkonfiguration setzen",
              "anchor": "2-laufzeitkonfiguration-setzen"
            },
            {
              "depth": 3,
              "text": "3. Konnektoren anlegen",
              "anchor": "3-konnektoren-anlegen"
            },
            {
              "depth": 3,
              "text": "4. Workflows anlegen",
              "anchor": "4-workflows-anlegen"
            },
            {
              "depth": 3,
              "text": "5. Die Workflows freigeben",
              "anchor": "5-die-workflows-freigeben"
            },
            {
              "depth": 3,
              "text": "6. Den Zugriff der App testen",
              "anchor": "6-den-zugriff-der-app-testen"
            },
            {
              "depth": 3,
              "text": "Zugangsdaten eines Konnektors erneuern",
              "anchor": "zugangsdaten-eines-konnektors-erneuern"
            },
            {
              "depth": 3,
              "text": "Eine App zurückrollen",
              "anchor": "eine-app-zurückrollen"
            },
            {
              "depth": 3,
              "text": "Einen App-Benutzer löschen",
              "anchor": "einen-app-benutzer-löschen"
            },
            {
              "depth": 3,
              "text": "App prüfen",
              "anchor": "app-prüfen"
            },
            {
              "depth": 3,
              "text": "Wo welche Einstellung liegt",
              "anchor": "wo-welche-einstellung-liegt"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [],
          "sha256": "ac0d078f6639ddae2189ebedc60f85b2e14505b65946c1978ee5acd898538fee",
          "body": "## Eine App anbinden\n\nDeine App meldet ihre Nutzer bei einem eigenen Identitätsanbieter an und soll in deren Namen SubKit-Workflows starten.\nDiese Checkliste ist für Entwickler, die diese Anbindung einrichten.\nAm Ende ruft die App SubKit mit dem Token ihrer Nutzer auf und braucht dafür nur die Produkt-ID und die Workflow-IDs.\n\nDer Identitätsanbieter ist der Dienst, bei dem sich deine Nutzer anmelden.\nNach der Anmeldung stellt er ein Access-Token aus, einen signierten und befristeten Nachweis, wer die Person ist.\nDie App schickt dieses Token als Bearer-Token im Header `Authorization` an SubKit.\nSubKit prüft Signatur, Aussteller und Empfänger des Tokens, bevor ein Lauf startet.\n\nArbeite die Schritte der Reihe nach ab.\nHosts und IDs in den Beispielen sind Platzhalter (`example.test`, `<...>`).\n\n### Was du brauchst\n\n- Die `sk`-CLI, angemeldet an deiner Engine. In SubKit Cloud ist die Engine-Adresse `https://subkit-cloud.mikebild.info`, ohne `/cockpit`.\n- Ein echtes Access-Token eines Testkontos der App.\n- Zugang zu den Diensten, die die Workflows aufrufen, etwa zur API deines KI-Modells.\n\n### 1. Produkt-ID und Anmelderegeln festlegen\n\nLeg diese Werte fest, bevor du eine Einstellung änderst.\nEin Claim ist ein Feld im Token, etwa `iss` (wer es ausgestellt hat) oder `aud` (für wen es gedacht ist).\nLies beide aus einem echten Token der App.\n\n| Einstellung | Was du einträgst | Beispiel |\n| --- | --- | --- |\n| `product_id` | Ein kleingeschriebener Name (`^[a-z][a-z0-9-]{0,62}$`), einer pro App. Er verbindet Anbieter, Workflows, Budget und Identitätsbindung. | `<product-id>` |\n| `issuer_url` | Der Aussteller des Anbieters, genau wie im `iss`-Claim des Tokens. HTTPS außerhalb von localhost. | `https://idp.example.test` |\n| `audience` | Für wen das Token gedacht ist: der Wert des `aud`-Claims. Der Aussteller legt ihn fest, SubKit hat keinen Standardwert. | `<audience>` |\n| `required_claims` | Wer sich anmelden darf: ein Punktpfad in das verifizierte Token mit exaktem Wert. Der Schlüssel ist erforderlich. | `[{\"path\":\"idp\",\"equals\":\"primary\"}]` |\n\nDas erste geprüfte Token einer Person legt einen Produktbenutzer mit der eingebauten Mitgliedsrolle an.\nEine leere Liste `required_claims: []` lässt jedes Token dieses Ausstellers und dieser Audience zu.\nSoll nicht jede Person mit einem Token Benutzer werden, schränke `required_claims` auf die vorgesehenen Konten ein.\n\n### 2. Laufzeitkonfiguration setzen\n\nDie Laufzeitkonfiguration sind Einstellungen deiner Engine, die du mit `sk settings` liest und schreibst.\n`auth.providers` und `products` werden dabei jeweils als Ganzes ersetzt.\nLies deshalb jeden Wert zuerst und schreib ihn mit deiner Ergänzung zurück.\n\n1. Lies die aktuellen Anmeldeanbieter.\n\n```bash\nsk settings get auth.providers --json\n```\n\n2. Ergänze deinen Anbietereintrag und schreib die ganze Liste zurück. Behalte jeden bestehenden Eintrag, sonst geht er verloren.\n\n```bash\nsk settings set auth.providers '[\n  {\"protocol\":\"api_key\",\"id\":\"api-key\",\"label\":\"SubKit API key\"},\n  {\"protocol\":\"oidc_bearer\",\"id\":\"<provider-id>\",\"label\":\"<app> account\",\n   \"issuer_url\":\"https://idp.example.test\",\"audience\":\"<audience>\",\"algorithms\":[\"ES256\"],\n   \"product_id\":\"<product-id>\",\"tenant_slug\":\"default\",\n   \"required_claims\":[{\"path\":\"idp\",\"equals\":\"primary\"}],\n   \"reject_anonymous\":true,\"clock_tolerance_s\":30}\n]'\n```\n\n3. Lies die aktuellen Produkte.\n\n```bash\nsk settings get products --json\n```\n\n4. Ergänze deinen Produkteintrag und schreib den ganzen Wert zurück.\n\n```bash\nsk settings set products '{\"<product-id>\":{\"execution_environment\":\"prod\",\n  \"assistant_workflow_id\":\"<assistant-workflow-id>\",\"budget_bucket\":\"<bucket>\"}}'\n```\n\n`tenant_slug` nennt den Arbeitsbereich, also den abgetrennten Bereich in der Engine, in dem SubKit die Nutzer der App anlegt.\n`assistant_workflow_id` ist die ID, die du in Schritt 4 für den abgesicherten Workflow wählst.\nSobald die Schritte 3 bis 5 erledigt sind, zeigt `sk apps show <product-id>`, was die Werte ergeben.\n\n### 3. Konnektoren anlegen\n\nLege für jeden Dienst, den die Workflows aufrufen, einen Konnektor an.\nDas ist meist die API des KI-Modells und, falls die App Konten löscht, die Admin-API des Identitätsanbieters.\n\n1. Schreibe jede Definition ohne Zugangsdaten in eine JSON-Datei.\n2. Lege den Konnektor an.\n3. Hinterlege die Zugangsdaten.\n\n```bash\nsk connectors create --file connector-model.json --skip-checks\nsk credentials set <model-connector-id> --mode bearer --token \"$MODEL_API_KEY\"\nsk credentials set <idp-admin-connector-id> --mode header --header \"Authorization=Bearer $IDP_ADMIN_KEY,apikey=$IDP_ADMIN_KEY\"\n```\n\n- `--skip-checks` ist nötig, weil die Zugangsdaten beim Anlegen des Konnektors noch fehlen. `credentials set` prüft sie anschließend.\n- `bearer` sendet `Authorization: Bearer <token>`. `header` sendet die genannten Header (kommagetrennt `Name=Value`).\n- Zugangsdaten stammen aus deiner Shell oder deinem Secret-Speicher, nie aus einer Datei, der App oder diesem Repository.\n- Ersetzt du im Cockpit Zugangsdaten mit mehreren Headern, füll alle Header-Felder aus. Lässt du alle leer, bleiben die alten Werte.\n\nDamit SubKit die Zugangsdaten prüfen kann, gib dem Konnektor eine Probe. Das ist ein kleiner Lesezugriff, der eine Anmeldung braucht:\n\n```json\n\"config\": {\"probe_endpoint\": {\"method\": \"GET\", \"path\": \"/admin/users?per_page=1\", \"expected_status\": [200, 200]}}\n```\n\nFühre dann `sk connectors test <id>` aus.\nAntwortet die Probe mit 401 oder 403, gilt der Konnektor als abgemeldet. Seine Workflows sind dann blockiert.\n\n### 4. Workflows anlegen\n\nHalte die Definitionen im eigenen Repository der App.\nLege sie mit festen IDs an, damit die App sie fest im Code hinterlegen kann.\nNur ein Administrator darf eine Workflow-`id` (eine unbenutzte UUID) wählen.\n\n```bash\nsk workflows create --file workflows/assistant.json\nsk workflows create --file workflows/delete-account.json\n```\n\nJeder Produkt-Workflow setzt:\n\n- `\"id\": \"<fixed-uuid>\"` und `\"product_id\": \"<product-id>\"`.\n- `\"required_caller_kind\": \"user\"` und `\"execution_privacy\": \"sensitive\"`.\n- Beim Workflow, dessen Verbrauch je Nutzer und Tag begrenzt ist, `execution_guards.caller_daily_limit` (Bucket gleich `budget_bucket`, Limit, `tz`, Einheitenpfad) und `execution_guards.input_bytes`.\n- Beim Lösch-Workflow `\"caller_erasure\": \"on_success\"`.\n\nDas Konto gehört dem Identitätsanbieter. SubKit besitzt nur seine eigenen Datensätze über die aufrufende Person.\nDer Lösch-Workflow läuft deshalb in dieser Reihenfolge:\n\n1. Lösche das Konto beim Identitätsanbieter mit dem Admin-Konnektor, über `${caller.subject}` (gebunden mit `{caller_bound: true}`). Ein 404 bedeutet „schon weg“ und gilt als Erfolg.\n2. Widerrufe Tokens bei anderen Diensten, so weit das möglich ist. Ein Fehler hier darf Schritt 3 nicht blockieren.\n3. SubKit löscht seine eigenen Aufruferdaten zuletzt, über `caller_erasure: \"on_success\"`. Früher ausgestellte Tokens werden danach abgelehnt.\n\nSchlägt Schritt 1 fehl, schlägt der Lauf fehl, und nichts wird gelöscht. Die App versucht es mit demselben `idempotency_key` erneut.\n\n### 5. Die Workflows freigeben\n\nOhne gültige Freigabe antwortet ein Produktlauf mit 403.\nEine Person mit Schreibrecht gibt jeden Produkt-Workflow einmal pro Umgebung frei.\n\n1. Öffne im Cockpit **Workflows** und klicke auf den Workflow.\n2. Wähle **Freigeben** in der Statuszeile oder auf dem Tab **Freigaben**. Der Dialog **<Workflow> v<n> freigeben** öffnet sich.\n3. Prüfe, ob **Umgebung** (**Produktion** oder **Test**) zur `execution_environment` des Produkts passt.\n4. Prüfe Konnektoren, Adressen und Lese- oder Schreibzugriff.\n5. Wähle unter **Gültigkeit** **7 Tage**, **30 Tage** oder **Bis auf Widerruf**. **Bis auf Widerruf** ist vorausgewählt und setzt weder eine Laufgrenze noch ein Ablaufdatum.\n6. Wähle **Freigeben**. Die Freigabe startet keinen Lauf.\n\nEin Workflow, den nur die HTTP-Aufrufe der App starten, wird in der Umgebung seiner Konnektoren geprüft.\nSeine Statuszeile zeigt dann eventuell „Nicht freigegeben“ ohne Korrekturbanner.\nFehlt ein Konnektor oder liegt er in einer anderen Umgebung, behebe das zuerst.\n\nEine neue Version braucht keine neue Freigabe, solange sie nicht mehr Systeme, Adressen oder Schreibrechte anfasst als die freigegebene. Greift sie weiter, fragt SubKit erneut und nennt den Unterschied.\n\n### 6. Den Zugriff der App testen\n\nPrüfe zuerst die Bereitschaft. Jede Prüfung sollte `ok` lauten. Eine fehlschlagende Prüfung nennt ihre nächste Maßnahme.\n\n```bash\nsk apps show <product-id>\n```\n\nRuf dann die Engine mit einem echten Token auf:\n\n- `$TOKEN` ist das Access-Token eines Testkontos.\n- `$BAD_TOKEN` ist `$TOKEN`, bei dem du die letzten Zeichen der Signatur änderst.\n- `$BASE` ist die Adresse der Engine.\n\n```bash\ncurl -s -w '\\n%{http_code}\\n' -H \"Authorization: Bearer $BAD_TOKEN\" $BASE/v1/budget\ncurl -s -H \"Authorization: Bearer $TOKEN\" $BASE/v1/health\ncurl -s -H \"Authorization: Bearer $TOKEN\" $BASE/v1/budget\ncurl -s -X POST $BASE/v1/executions -H \"Authorization: Bearer $TOKEN\" -H 'content-type: application/json' \\\n  -d '{\"workflow_id\":\"<workflow-id>\",\"idempotency_key\":\"check-1\",\"async\":true,\"input\":{}}'\n```\n\nErwartet:\n\n- `$BAD_TOKEN`, eine falsche Audience, ein fehlender Pflicht-Claim oder ein abgelaufenes Token antworten `401 invalid bearer token`.\n- `sk executions` und der Datensatz des Laufs zeigen, wer aufgerufen hat und welche Freigabe galt.\n\n### Zugangsdaten eines Konnektors erneuern\n\nZugangsdaten in Konnektoren können ablaufen, und Admin-Schlüssel werden regelmäßig getauscht.\nHalte Name, Konnektor, Verantwortliche und Ablaufdatum aller Zugangsdaten im Repository der App fest, nie den Wert.\nErneuere sie vor Ablauf.\n\n1. Hinterlege den neuen Wert mit `sk credentials set`.\n2. Prüfe ihn mit `sk connectors test <connector-id>`.\n3. Entferne den alten mit `sk credentials delete <credential-id>`.\n\nDas Cockpit und `GET /v1/health` zeigen fehlschlagende Konnektoren.\n\n### Eine App zurückrollen\n\n1. Widerrufe die Freigabe des Workflows im Tab **Freigaben**. Die App erhält dann 403, nichts läuft.\n2. Stell die Werte von `auth.providers` und `products` aus Schritt 2 wieder her.\n3. Stell eine Workflow-Version mit `sk workflows history <id>` und `sk workflows restore <id>` wieder her.\n\nOhne den Anbietereintrag werden die Tokens der App nicht mehr angenommen. Bestehende Aufruferdatensätze bleiben, bis der Lösch-Workflow sie löscht.\n\n### Einen App-Benutzer löschen\n\nDas Löschen lässt sich nicht rückgängig machen.\nEs entfernt die eigenen Daten von SubKit über eine Person für eine App:\n\n- Anmeldebindungen\n- Budgetzähler\n- Sitzungen\n- API-Schlüssel\n- die ID der Person in vergangenen Läufen\n\nEine neue Anmeldung beim Anbieter legt einen neuen, leeren App-Benutzer an.\n\n1. Ermittle die Benutzer-ID mit `sk apps show <product-id>`.\n2. Führe `sk apps erase-user <product-id> <user-id>` aus und bestätige.\n\n```bash\nsk apps show <product-id>                          # lists the user ids of the app\nsk apps erase-user <product-id> <user-id>          # asks for confirmation\nsk apps erase-user <product-id> <user-id> --yes    # non-interactive; --json prints the result\n```\n\nGut zu wissen:\n\n- Das Löschen braucht `identity:write` und eine Admin-Rolle. Produktbenutzer werden abgelehnt.\n- Das Konto beim Anmeldeanbieter bleibt bestehen. Dessen Löschung liegt bei der App und ihrem Identitätsanbieter.\n- Eine Person mit Anmeldeverknüpfungen zu einer anderen App oder zu SubKit selbst wird nicht gelöscht (409).\n- Im Cockpit liegt dieselbe Aktion beim Benutzer in den Details der App, hinter einem Bestätigungsdialog.\n\n| Schnittstelle | Aufruf | Ergebnis |\n| --- | --- | --- |\n| HTTP | `DELETE /v1/apps/{id}/users/{user_id}` | `{ \"user_id\", \"app_id\", \"erased\": true }`, oder 404 bei einem unbekannten, fremden oder bereits gelöschten Benutzer. |\n| HTTP | `DELETE /v1/identity/users/{id}` | Deaktiviert einen Benutzer nur. |\n| MCP (Admin-Modus) | `list_apps`, `get_app` | Nur lesend. Löschen ist nicht möglich. |\n\n### App prüfen\n\nEine App ist eine reine Ansicht.\nSubKit setzt sie beim Lesen aus fünf Quellen zusammen:\n\n- dem `products`-Eintrag\n- den Anmeldeanbietern mit derselben `product_id`\n- den Workflows mit derselben `product_id`\n- den angemeldeten Benutzern\n- dem heutigen Budget\n\nDie App selbst speichert nichts.\nÄnderungen machst du über `auth.providers`, `products` und die Workflows (Schritte 2 bis 5).\n\n```bash\nsk apps list                      # app, environment, users, budget today, readiness\nsk apps show <product-id>         # settings, sign-in, workflows, users, budget today, readiness\nsk apps show <product-id> --json\nsk users list --app <product-id>  # users who signed in to that app\n```\n\nIm Cockpit öffnest du **Personen & Rechte** > **Apps** und wählst eine App. Über HTTP nutzt du `GET /v1/apps` und `GET /v1/apps/{id}`. Beide brauchen `settings:read`.\n\nDie Bereitschaft besteht aus sechs Prüfungen:\n\n| Prüfung | Bedeutung |\n| --- | --- |\n| `product_configured` | Es gibt einen `products`-Eintrag. |\n| `sign_in_provider` | Ein Anmeldeanbieter trägt die `product_id`. |\n| `assistant_workflow` | Existiert im Arbeitsbereich, trägt die `product_id`, ist aktiv und gültig. |\n| `execution_authority` | Für die Umgebung des Produkts gibt es eine gültige Freigabe. |\n| `credentials` | Nutzbar an jedem vom Assistenten verwendeten Konnektor. |\n| `budget_guard` | Ein `caller_daily_limit`, dessen Bucket `budget_bucket` entspricht. |\n\nDas heutige Budget zeigt die heute verbrauchten und reservierten Einheiten, die Ablehnungen seit lokaler Mitternacht (`rate_limited`, `turn_limit`, `turn_busy`) und wann der Tag zurückgesetzt wird.\n\n### Wo welche Einstellung liegt\n\n| Einstellung | Wo sie liegt |\n| --- | --- |\n| Anbietereintrag, `products`-Eintrag, Konnektoren und ihre Zugangsdaten | Laufzeitkonfiguration pro Deployment, gesetzt mit `sk` |\n| Workflow-Definitionen und ihre festen IDs | Das eigene Repository der App, angelegt mit `sk workflows create` |\n| Freigaben der Workflows | Eine Person, pro Workflow und Umgebung, im Cockpit |\n| Ablaufnachweise für Zugangsdaten | Das eigene Repository der App (nur Metadaten) |\n\nJede Änderung an einem Anmeldeanbieter oder `products`-Eintrag landet im Verlauf. Der Eintrag nennt die geänderten Felder, nicht ihre Werte.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| `401 invalid bearer token` | Das Token wurde abgelehnt. Prüfe `issuer_url`, `audience` und `required_claims` gegen ein echtes Token und ob es abgelaufen ist. |\n| `403` bei einem Produktlauf oder `ok: false` bei `GET /v1/health` | Es fehlt die Freigabe aus Schritt 5 oder Zugangsdaten. Prüfe `sk apps show <product-id>`. |\n| `429 rate_limited` | Das Tageslimit ist verbraucht. `sk apps show` nennt, wann der Tag zurückgesetzt wird. |\n| `409 turn_busy` | Ein Aufruf desselben Durchgangs läuft noch. Warte ab, oder sende den ersten Aufruf mit seinem `idempotency_key` erneut; dann liefert die Engine dessen Ergebnis noch einmal. Ein anderer Schlüssel bekommt weiter 409, bis der erste Aufruf fertig ist. |\n| `credential_unverified` und `PROBE_AUTH_UNVERIFIED`, oder „Verbunden · Anmeldung nicht geprüft“ im Cockpit | Der Konnektor hat keine Probe, und `GET /` lieferte keine klare Antwort. Setze einen Probe-Pfad mit authentifiziertem Lesezugriff (Schritt 3) und prüfe mit `sk connectors test <id>`. |\n| Ein Konnektor gilt als abgemeldet | Dessen Probe hat 401 oder 403 geliefert. Hinterlege die Zugangsdaten neu (Schritt 3) und prüfe mit `sk connectors test <id>`. |\n| `409` beim Löschen eines App-Benutzers | Die Person hat Anmeldeverknüpfungen zu einer anderen App oder zu SubKit selbst und wird nicht gelöscht. |"
        }
      }
    },
    {
      "slug": "transactional-email-replies",
      "llms_path": "transactional-email.md",
      "audience": "public",
      "section": "work",
      "order": 8,
      "generated": false,
      "locales": {
        "en": {
          "title": "Reply by email to a signed request",
          "summary": "Confirm a form request with exactly one email to the person who sent it.",
          "headings": [
            {
              "depth": 2,
              "text": "Reply by email to a signed request",
              "anchor": "reply-by-email-to-a-signed-request"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Set up the workflow",
              "anchor": "set-up-the-workflow"
            },
            {
              "depth": 3,
              "text": "Bind and review",
              "anchor": "bind-and-review"
            },
            {
              "depth": 3,
              "text": "Test the reply",
              "anchor": "test-the-reply"
            },
            {
              "depth": 3,
              "text": "Compute the signature",
              "anchor": "compute-the-signature"
            },
            {
              "depth": 3,
              "text": "What happens next",
              "anchor": "what-happens-next"
            },
            {
              "depth": 3,
              "text": "Send one email per queued message",
              "anchor": "send-one-email-per-queued-message"
            },
            {
              "depth": 3,
              "text": "Inspect outcomes",
              "anchor": "inspect-outcomes"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [],
          "sha256": "66de2ed2c662bb07d83b8862893b631e73218dc0c40bd66928b050e00af36a74",
          "body": "## Reply by email to a signed request\n\nSomeone sends a request through your form, for example for access, and should get a confirmation by email: exactly one, and only to their own address.\nThis chapter shows developers how a workflow sends that reply as plain text through Gmail.\nAfterwards, SubKit checks origin, approval and recipient before every send, and a request sent twice produces no second email.\n\nSigned means: your website or backend computes a checksum over the request with a secret key.\nSubKit recomputes it and starts nothing if it does not match.\nA person reviews sender, template and limits before anything is sent.\n\nThe path is always the same: **signed request → reviewed workflow → approval → one reply**.\n\n### What you need\n\n- A Gmail connection (connector) in your workspace.\n- A signed source, that is your form backend, which sends requests in the Standard Webhooks format. Standard Webhooks is an open format for signed HTTP messages.\n- A person who approves the workflow.\n- An operator who reviews the workflow before activation.\n\nNever skip signature verification.\nNever use a public API key or credentials from the browser for the source.\n\n### Set up the workflow\n\n1. Set `execution_privacy: sensitive` and a strict input schema with bounded lengths.\n2. Add exactly one plain-text Gmail send step. Its request body contains only `raw`.\n3. Keep sender, connection and template in the workflow. The request selects only the reviewed original recipient.\n4. On the Gmail request step, add the `transactional_delivery` profile and `max_retries: 0`.\n5. Set `max_body_bytes` from the bounded template, not the largest allowed value.\n\nThe signed JSON body must contain the request UUID and the event type.\nInput paths start at `body`.\nFor a body with `event`, `reference` and `contact.address`, the profile looks like this:\n\n```json\n{\n  \"kind\": \"gmail_transactional\",\n  \"webhook_id\": \"<reviewed-binding-uuid>\",\n  \"event_type\": \"registration.requested\",\n  \"event_type_input\": \"body.event\",\n  \"request_id_input\": \"body.reference\",\n  \"recipient_input\": \"body.contact.address\",\n  \"from\": \"sender@example.test\",\n  \"content_type\": \"text/plain\",\n  \"max_body_bytes\": 8192\n}\n```\n\n`max_body_bytes` counts the finished Gmail JSON, including the extra size from base64.\nThis step cannot read page by page and cannot spread to several recipients. It also does not support a second fixed-recipient profile or response filtering.\n\nYou can also describe this workflow in the Cockpit chat. The chat knows this profile and its limits.\n\n### Bind and review\n\n1. In the same workspace, create an active Standard Webhooks binding for the workflow. The binding links the source to the workflow. Use exactly the reviewed event type and its own signing secret.\n2. In the source, save the request UUID and the original payload before sending.\n3. Send the UUID in the signed body and in `webhook-id`.\n4. Ask an operator to review version, sender, connection, signed source, field paths, byte limit and run limits.\n5. Activate the workflow and approve it.\n\n### Test the reply\n\n1. Send a test request to a controlled recipient.\n2. Check that the signed source still exists after activation.\n3. Connect the public form.\n4. Send the same request twice and check that one message arrives.\n\n### Compute the signature\n\nYour source signs each request with HMAC-SHA256, a checksum with a secret key.\nUse the secret verbatim as the UTF-8 key. SubKit does not strip a `whsec_` prefix and does not Base64-decode the key.\n\n1. Compute HMAC-SHA256 over `id.timestamp.rawBody`.\n2. Base64-encode the result.\n3. Send `webhook-signature: v1,<base64>`.\n\nAlso send matching timestamp and event-type headers.\nThe header alone is unsigned. So the event type must also match the reviewed field in the signed body.\n\n### What happens next\n\nBefore sending, the engine checks the approval, the signed source and the recipient again.\nIt refuses CC, BCC and extra recipients.\n\nGood to know:\n\n- A failed or unclear send is never resent automatically. There is no retry or reset operation.\n- Each original request gets at most one reply, across workflow versions and runs.\n- A signature only confirms where the request comes from. Only the approval allows the workflow to send.\n- A retried handoff keeps the same payload and ID and renews only timestamp and signature. Changed content under the same ID is refused.\n\n### Send one email per queued message\n\nSometimes the source cannot send a webhook, for example because its server may not open outbound connections.\nThen it puts messages into a queue, and a scheduled workflow picks them up with `outbox_delivery`.\nAn earlier fixed, read-only `GET` step returns the next queue entry. The email step declares `{kind: \"gmail_outbox\", source_step_id, recipient_field, item_id_field, from, content_type: \"text/plain\", max_body_bytes, max_per_day}`. Use `execution_privacy: sensitive` and `max_retries: 0`.\n\n- The recipient comes only from that queue response in the same run. The engine compares it with the message before sending.\n- Each queue entry gets at most one attempt, across workflow versions and runs. An unclear result is never resent automatically.\n- `max_per_day` caps the messages within any 24 hours.\n- Whoever can fill the queue chooses the recipients. Approve only a queue you trust; the approval dialog names it.\n\n### Inspect outcomes\n\n`GET /v1/workflows/{id}/transactional-mail-receipts?limit=20&offset=0` requires `workflow:read` for that workflow.\n\nIt returns:\n\n- Request, run and step IDs\n- State and timestamps\n\nIt does not return the applicant's address or the message content.\n\nThe audit log records when a send was reserved and how it ended.\n\n| State | Meaning |\n| --- | --- |\n| `sent` | Gmail answered with a message ID. This confirms that Gmail accepted it, not that it reached the inbox. |\n| `attempted`, `delivery_unknown` | The operator inspects the case. |\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| The state is `attempted` or `delivery_unknown` | The operator inspects the case. There is no automatic resend and no reset endpoint. |\n| A request is refused although the signature is correct | Check that the event type in the signed body matches the header and the reviewed field path, and that the UUID in the body and in `webhook-id` agree. |\n| A repeated handoff is refused | The content under that signed ID changed. Send the same payload and ID again and renew only timestamp and signature. |\n| Sending is refused because of recipient headers | Remove CC, BCC and extra recipient headers. Only the reviewed original recipient is allowed. |\n| The signed source is gone after activation | Create a new binding and activate a reviewed workflow version that references its actual ID. |"
        },
        "de": {
          "title": "Per E-Mail auf eine signierte Anfrage antworten",
          "summary": "Bestätige eine Formularanfrage mit genau einer E-Mail an die anfragende Person.",
          "headings": [
            {
              "depth": 2,
              "text": "Per E-Mail auf eine signierte Anfrage antworten",
              "anchor": "per-e-mail-auf-eine-signierte-anfrage-antworten"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Den Workflow einrichten",
              "anchor": "den-workflow-einrichten"
            },
            {
              "depth": 3,
              "text": "Binden und prüfen",
              "anchor": "binden-und-prüfen"
            },
            {
              "depth": 3,
              "text": "Die Antwort testen",
              "anchor": "die-antwort-testen"
            },
            {
              "depth": 3,
              "text": "Die Signatur berechnen",
              "anchor": "die-signatur-berechnen"
            },
            {
              "depth": 3,
              "text": "Wie es weitergeht",
              "anchor": "wie-es-weitergeht"
            },
            {
              "depth": 3,
              "text": "Eine E-Mail je Eintrag einer Warteschlange senden",
              "anchor": "eine-e-mail-je-eintrag-einer-warteschlange-senden"
            },
            {
              "depth": 3,
              "text": "Ergebnisse prüfen",
              "anchor": "ergebnisse-prüfen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [],
          "sha256": "1d374072a077431eb42f2c9c18280e0b780b6068542895ca7514d5d5b7977616",
          "body": "## Per E-Mail auf eine signierte Anfrage antworten\n\nJemand schickt über dein Formular eine Anfrage, etwa um Zugang, und soll eine Bestätigung per E-Mail bekommen: genau eine und nur an die eigene Adresse.\nDieses Kapitel zeigt Entwicklern, wie ein Workflow diese Antwort als reinen Text über Gmail schickt.\nDanach prüft SubKit vor jedem Versand Herkunft, Freigabe und Empfänger, und eine doppelt gesendete Anfrage erzeugt keine zweite Mail.\n\nSigniert heißt: Deine Website oder dein Backend rechnet mit einem geheimen Schlüssel eine Prüfsumme über die Anfrage.\nSubKit rechnet sie nach und startet nichts, wenn sie nicht passt.\nAbsender, Vorlage und Grenzen prüft eine Person, bevor etwas gesendet wird.\n\nDer Weg ist immer gleich: **signierte Anfrage → geprüfter Workflow → Freigabe → eine Antwort**.\n\n### Was du brauchst\n\n- Eine Gmail-Verbindung (Konnektor) in deinem Arbeitsbereich.\n- Eine signierte Quelle, also dein Formular-Backend, das Anfragen im Format Standard Webhooks schickt. Standard Webhooks ist ein offenes Format für signierte HTTP-Meldungen.\n- Eine Person, die den Workflow freigibt.\n- Einen Betreiber, der den Workflow vor der Aktivierung prüft.\n\nÜberspring nie die Signaturprüfung.\nNutze für die Quelle nie einen öffentlichen API-Schlüssel oder Zugangsdaten aus dem Browser.\n\n### Den Workflow einrichten\n\n1. Setze `execution_privacy: sensitive` und ein striktes Eingabeschema mit begrenzten Längen.\n2. Füge genau einen Gmail-Sendeschritt mit reinem Text hinzu. Sein Request-Body enthält nur `raw`.\n3. Behalte Absender, Verbindung und Vorlage im Workflow. Die Anfrage wählt nur den geprüften ursprünglichen Empfänger.\n4. Ergänze am Gmail-Schritt das Profil `transactional_delivery` und `max_retries: 0`.\n5. Leite `max_body_bytes` aus der begrenzten Vorlage ab, nicht aus dem größten erlaubten Wert.\n\nDer signierte JSON-Body muss die UUID der Anfrage und den Ereignistyp enthalten.\nEingabepfade beginnen bei `body`.\nFür einen Body mit `event`, `reference` und `contact.address` sieht das Profil so aus:\n\n```json\n{\n  \"kind\": \"gmail_transactional\",\n  \"webhook_id\": \"<reviewed-binding-uuid>\",\n  \"event_type\": \"registration.requested\",\n  \"event_type_input\": \"body.event\",\n  \"request_id_input\": \"body.reference\",\n  \"recipient_input\": \"body.contact.address\",\n  \"from\": \"sender@example.test\",\n  \"content_type\": \"text/plain\",\n  \"max_body_bytes\": 8192\n}\n```\n\n`max_body_bytes` misst das fertige Gmail-JSON einschließlich des Aufschlags durch Base64.\nDieser Schritt kann nicht seitenweise lesen und nicht an mehrere Empfänger verteilen. Ein zweites Profil mit festem Empfänger und Antwortfilter unterstützt er ebenfalls nicht.\n\nDu kannst diesen Workflow auch im Cockpit-Chat beschreiben. Der Chat kennt dieses Profil und seine Grenzen.\n\n### Binden und prüfen\n\n1. Lege im selben Arbeitsbereich eine aktive Standard-Webhooks-Bindung für den Workflow an. Die Bindung verknüpft die Quelle mit dem Workflow. Nutze genau den geprüften Ereignistyp und ein eigenes Signaturgeheimnis.\n2. Speichere in der Quelle die UUID der Anfrage und die ursprünglichen Daten vor dem Senden.\n3. Sende die UUID im signierten Body und in `webhook-id`.\n4. Lass Version, Absender, Verbindung, signierte Quelle, Feldpfade, Byte-Grenze und Laufgrenzen vom Betreiber prüfen.\n5. Aktiviere den Workflow und gib ihn frei.\n\n### Die Antwort testen\n\n1. Sende eine Testanfrage an einen kontrollierten Empfänger.\n2. Prüfe, dass die signierte Quelle nach der Aktivierung noch existiert.\n3. Verbinde das öffentliche Formular.\n4. Sende dieselbe Anfrage zweimal und prüfe, dass genau eine Nachricht ankommt.\n\n### Die Signatur berechnen\n\nDeine Quelle signiert jede Anfrage mit HMAC-SHA256, einer Prüfsumme mit geheimem Schlüssel.\nNutze das Geheimnis unverändert als UTF-8-Schlüssel. SubKit entfernt kein Präfix `whsec_` und dekodiert den Schlüssel nicht aus Base64.\n\n1. Berechne HMAC-SHA256 über `id.timestamp.rawBody`.\n2. Kodiere das Ergebnis in Base64.\n3. Sende `webhook-signature: v1,<base64>`.\n\nSende auch passende Header für Zeitstempel und Ereignistyp.\nDer Header allein ist nicht signiert. Deshalb muss der Ereignistyp auch zum geprüften Feld im signierten Body passen.\n\n### Wie es weitergeht\n\nVor dem Senden prüft die Engine Freigabe, signierte Quelle und Empfänger erneut.\nCC, BCC und zusätzliche Empfänger lehnt sie ab.\n\nGut zu wissen:\n\n- Ein fehlgeschlagener oder unklarer Versand wird nie automatisch wiederholt. Es gibt kein Wiederholen und kein Zurücksetzen.\n- Jede ursprüngliche Anfrage bekommt höchstens eine Antwort, über Workflow-Versionen und Läufe hinweg.\n- Eine Signatur bestätigt nur, woher die Anfrage kommt. Erst die Freigabe erlaubt dem Workflow das Senden.\n- Eine wiederholte Übergabe behält dieselben Daten und dieselbe ID und erneuert nur Zeitstempel und Signatur. Geänderter Inhalt unter derselben ID wird abgelehnt.\n\n### Eine E-Mail je Eintrag einer Warteschlange senden\n\nManchmal kann die Quelle keinen Webhook schicken, etwa weil ihr Server keine Verbindung nach außen aufbauen darf.\nDann legt sie Nachrichten in eine Warteschlange, und ein Workflow mit Zeitplan holt sie mit `outbox_delivery` ab.\nEin früherer, fester Lese-`GET`-Schritt liefert den nächsten Eintrag. Der Mail-Schritt deklariert `{kind: \"gmail_outbox\", source_step_id, recipient_field, item_id_field, from, content_type: \"text/plain\", max_body_bytes, max_per_day}`. Nutze `execution_privacy: sensitive` und `max_retries: 0`.\n\n- Der Empfänger stammt nur aus dieser Antwort der Warteschlange im selben Lauf. Die Engine vergleicht ihn vor dem Senden mit der Nachricht.\n- Jeder Eintrag bekommt höchstens einen Versuch, über Workflow-Versionen und Läufe hinweg. Ein unklares Ergebnis wird nie automatisch erneut gesendet.\n- `max_per_day` begrenzt die Nachrichten innerhalb von 24 Stunden.\n- Wer die Warteschlange füllen kann, bestimmt die Empfänger. Gib nur eine Warteschlange frei, der du vertraust; der Freigabedialog nennt sie.\n\n### Ergebnisse prüfen\n\n`GET /v1/workflows/{id}/transactional-mail-receipts?limit=20&offset=0` erfordert `workflow:read` für diesen Workflow.\n\nDer Aufruf liefert:\n\n- IDs von Anfrage, Lauf und Schritt\n- Status und Zeitstempel\n\nAdresse des Antragstellers und Nachrichteninhalt liefert er nicht.\n\nDer Verlauf hält fest, wann ein Versand vorgemerkt wurde und wie er ausging.\n\n| Status | Bedeutung |\n| --- | --- |\n| `sent` | Gmail hat mit einer Nachrichten-ID geantwortet. Das bestätigt die Annahme durch Gmail, nicht die Zustellung im Posteingang. |\n| `attempted`, `delivery_unknown` | Der Betreiber prüft den Fall. |\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| Der Status ist `attempted` oder `delivery_unknown` | Der Betreiber prüft den Fall. Es gibt kein automatisches erneutes Senden und keinen Endpunkt zum Zurücksetzen. |\n| Eine Anfrage wird abgelehnt, obwohl die Signatur stimmt | Prüfe, ob der Ereignistyp im signierten Body zum Header und zum geprüften Feldpfad passt und ob die UUID im Body und in `webhook-id` übereinstimmt. |\n| Eine wiederholte Übergabe wird abgelehnt | Der Inhalt unter dieser signierten ID hat sich geändert. Sende dieselben Daten und dieselbe ID erneut und erneuere nur Zeitstempel und Signatur. |\n| Der Versand wird abgelehnt, weil Empfänger-Header vorhanden sind | Entferne CC, BCC und zusätzliche Empfänger-Header. Nur der geprüfte ursprüngliche Empfänger ist erlaubt. |\n| Die signierte Quelle ist nach der Aktivierung verschwunden | Lege eine neue Bindung an und aktiviere eine geprüfte Workflow-Version, die ihre tatsächliche ID referenziert. |"
        }
      }
    },
    {
      "slug": "cockpit-app",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 9,
      "generated": false,
      "locales": {
        "en": {
          "title": "Cockpit as an app",
          "summary": "Launch your workspace's Cockpit as its own app in its own window.",
          "headings": [
            {
              "depth": 2,
              "text": "Cockpit as an app",
              "anchor": "cockpit-as-an-app"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Install the Cockpit of a workspace",
              "anchor": "install-the-cockpit-of-a-workspace"
            },
            {
              "depth": 3,
              "text": "Use several workspaces as separate apps",
              "anchor": "use-several-workspaces-as-separate-apps"
            },
            {
              "depth": 3,
              "text": "Sign in and sign out in the app",
              "anchor": "sign-in-and-sign-out-in-the-app"
            },
            {
              "depth": 3,
              "text": "Set the branding of a workspace",
              "anchor": "set-the-branding-of-a-workspace"
            },
            {
              "depth": 3,
              "text": "Remove an installed app",
              "anchor": "remove-an-installed-app"
            },
            {
              "depth": 3,
              "text": "Good to know",
              "anchor": "good-to-know"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            }
          ],
          "images": [
            {
              "src": "/docs-images/cockpit-app-install.en.webp?v=7303d96df379",
              "alt": "Open workspace menu with the current workspace checked and the \"Install this workspace\" entry highlighted",
              "build": "10.6.0",
              "width": 1440,
              "height": 788
            },
            {
              "src": "/docs-images/cockpit-app-branding.en.webp?v=7146710ec87d",
              "alt": "Workspace branding settings of the fictional workspace Brennwerk with the organization name Brennwerk, the subtitle Logistik, the dark teal app icon with an orange flame, the light and dark logo, and the Teal palette selected; the sidebar shows the same logo and wordmark",
              "build": "10.4.12",
              "width": 1440,
              "height": 788
            }
          ],
          "sha256": "4d679ec736ec3dcb26716cb86ceaf3cda5bd1546f02f61f8eae49efca6607f77",
          "body": "## Cockpit as an app\n\nThis chapter is for anyone who works in the Cockpit every day and does not want to hunt for it among browser tabs. You install the Cockpit of a workspace as an app on your computer or phone, provided your browser can install web apps. You then start it like any other program, in its own window and with the workspace's name, icon and colors.\n\n### What you need\n\n- Access to a workspace in SubKit Cloud at https://subkit-cloud.mikebild.info or on a self-hosted engine.\n- An account you sign in with through **Sign in with work account**. An installed app cannot sign in again with an API key.\n- A browser that supports web app installation.\n- For branding: the `settings:write` and `identity:write` permissions in the workspace.\n\n### Install the Cockpit of a workspace\n\n1. Open the Cockpit in the browser and sign in.\n2. Open the workspace menu in the sidebar and choose **Install this workspace**.\n\n   ![Open workspace menu with the current workspace checked and the \"Install this workspace\" entry highlighted](/docs-images/cockpit-app-install.en.webp?v=7303d96df379)\n\n3. Check the name and icon in the install dialog and select **Install app**.\n4. The Cockpit moves to this workspace's own address and shows the dialog again. Select **Install app** once more.\n5. Confirm the installation in your browser's dialog.\n\nThe app carries the workspace name. It uses the stored app icon or the SubKit icon and takes the color of the selected color palette.\n\n### Use several workspaces as separate apps\n\nIf you work in several workspaces, each one gets its own app.\n\n1. In the regular Cockpit, switch to the next workspace from the workspace menu.\n2. Install it as above through **Install this workspace**.\n3. Start each app on its own. Each app only ever opens its own workspace.\n\nEach app has its own sign-in. Your sign-in in the regular Cockpit stays untouched.\n\n### Sign in and sign out in the app\n\n1. To sign out, open the **User menu** in the app and choose **Sign out**.\n2. To sign in again, start the app and choose **Sign in with work account**.\n3. If that fails, sign in to the regular Cockpit and reopen the app there through **Install this workspace**.\n\n**Sign out** only signs out this app, not your other apps and not the regular Cockpit.\n\n### Set the branding of a workspace\n\n1. Open **Settings** and, under **Working with sk**, the **Workspace branding** section.\n2. Under **App icon (1:1)**, upload a square PNG with at least 512 pixels per side.\n3. Under **Color palette**, choose **Standard**, **Indigo** or **Teal**.\n\n   ![Workspace branding settings of the fictional workspace Brennwerk with the organization name Brennwerk, the subtitle Logistik, the dark teal app icon with an orange flame, the light and dark logo, and the Teal palette selected; the sidebar shows the same logo and wordmark](/docs-images/cockpit-app-branding.en.webp?v=7146710ec87d)\n\n4. Check the preview and select **Save changes**.\n\nWithout both permissions you can only view the branding.\nThe app name comes from the workspace name, not from the **Organization name** in the branding.\n**Reset branding** restores the SubKit look for all members.\n\n### Remove an installed app\n\n1. Open the regular Cockpit in the browser and switch to the app's workspace.\n2. Choose **Revoke installation** in the workspace menu and confirm. This signs the app out on all its devices.\n3. Then remove the app from your device like any other app.\n\nIf you install again later, the app gets a new address. Old links stop working.\n\n### Good to know\n\n- To get notifications, open **Notifications** in the app and turn on **Enable neutral notifications**. The alerts contain no workspace or workflow details.\n- Text and files you share with the app only reach the **Inbox** after you confirm them. This neither turns them into knowledge nor starts a workflow.\n- Your browser or operating system may keep showing an installed app's name and icon after you sign out.\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| \"Installation unavailable\" | Keep using the Cockpit in the browser, or open it in a browser that can install web apps. |\n| \"Installed apps require an existing OIDC account to sign in again. …\" | Sign in to the regular Cockpit and reopen the app there through **Install this workspace**. |\n| \"Browser permission was denied. Allow notifications in your browser settings.\" | Allow notifications for the Cockpit address in your browser settings. |\n| \"Open the app, sign in and share again.\" | Start the app, sign in and share the content again. |\n| \"Use a still PNG, JPEG or WebP up to 2 MiB and 4 megapixels.\" | Upload a square PNG of at least 512 pixels per side and at most 2 MiB as the app icon. |"
        },
        "de": {
          "title": "Cockpit als App",
          "summary": "Starte das Cockpit deines Arbeitsbereichs als eigene App im eigenen Fenster.",
          "headings": [
            {
              "depth": 2,
              "text": "Cockpit als App",
              "anchor": "cockpit-als-app"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Cockpit eines Arbeitsbereichs installieren",
              "anchor": "cockpit-eines-arbeitsbereichs-installieren"
            },
            {
              "depth": 3,
              "text": "Mehrere Arbeitsbereiche als getrennte Apps nutzen",
              "anchor": "mehrere-arbeitsbereiche-als-getrennte-apps-nutzen"
            },
            {
              "depth": 3,
              "text": "In der App anmelden und abmelden",
              "anchor": "in-der-app-anmelden-und-abmelden"
            },
            {
              "depth": 3,
              "text": "Branding eines Arbeitsbereichs festlegen",
              "anchor": "branding-eines-arbeitsbereichs-festlegen"
            },
            {
              "depth": 3,
              "text": "Installierte App entfernen",
              "anchor": "installierte-app-entfernen"
            },
            {
              "depth": 3,
              "text": "Gut zu wissen",
              "anchor": "gut-zu-wissen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            }
          ],
          "images": [
            {
              "src": "/docs-images/cockpit-app-install.de.webp?v=adf8567cc2bb",
              "alt": "Geöffnetes Menü der Arbeitsbereiche mit abgehaktem aktuellem Arbeitsbereich und hervorgehobenem Eintrag „Arbeitsbereich installieren“",
              "build": "10.6.0",
              "width": 1440,
              "height": 787
            },
            {
              "src": "/docs-images/cockpit-app-branding.de.webp?v=c5e5bbfda5b2",
              "alt": "Arbeitsbereich-Branding des fiktiven Arbeitsbereichs Brennwerk mit dem Organisationsnamen Brennwerk, dem Untertitel Logistik, dem dunkelgrünen App-Icon mit orangefarbener Flamme, dem hellen und dunklen Logo und der gewählten Farbpalette Teal; die Seitenleiste zeigt dasselbe Logo und die Wortmarke",
              "build": "10.4.16",
              "width": 1440,
              "height": 787
            }
          ],
          "sha256": "dd9b82df3b95c41e4bf7c26c15ee95d9db1fce3e2ef36337e8eb71f0724ba823",
          "body": "## Cockpit als App\n\nDieses Kapitel ist für alle, die täglich im Cockpit arbeiten und es nicht jedes Mal in einem Browser-Tab suchen wollen. Du installierst das Cockpit eines Arbeitsbereichs als App auf dem Rechner oder Handy, sofern dein Browser Web-Apps installieren kann. Danach startest du es wie jedes andere Programm, in eigenem Fenster und mit Name, Symbol und Farben des Arbeitsbereichs.\n\n### Was du brauchst\n\n- Zugang zu einem Arbeitsbereich in SubKit Cloud unter https://subkit-cloud.mikebild.info oder auf einer selbst betriebenen Engine.\n- Ein Konto, mit dem du dich über **Mit Firmenkonto anmelden** anmeldest. Mit einem API-Schlüssel kann sich eine installierte App nicht neu anmelden.\n- Einen Browser, der die Installation von Web-Apps unterstützt.\n- Für das Branding: die Rechte `settings:write` und `identity:write` im Arbeitsbereich.\n\n### Cockpit eines Arbeitsbereichs installieren\n\n1. Öffne das Cockpit im Browser und melde dich an.\n2. Öffne in der Seitenleiste das Menü des Arbeitsbereichs und wähle **Arbeitsbereich installieren**.\n\n   ![Geöffnetes Menü der Arbeitsbereiche mit abgehaktem aktuellem Arbeitsbereich und hervorgehobenem Eintrag „Arbeitsbereich installieren“](/docs-images/cockpit-app-install.de.webp?v=adf8567cc2bb)\n\n3. Prüfe Name und Symbol im Installationsdialog und wähle **App installieren**.\n4. Das Cockpit wechselt zur eigenen Adresse dieses Arbeitsbereichs und zeigt den Dialog erneut. Wähle noch einmal **App installieren**.\n5. Bestätige die Installation im Dialog deines Browsers.\n\nDie App heißt wie der Arbeitsbereich. Sie nutzt das hinterlegte App-Icon oder das SubKit-Symbol und übernimmt die Farbe der gewählten Farbpalette.\n\n### Mehrere Arbeitsbereiche als getrennte Apps nutzen\n\nArbeitest du in mehreren Arbeitsbereichen, bekommt jeder seine eigene App.\n\n1. Wechsle im normalen Cockpit im Menü des Arbeitsbereichs zum nächsten Arbeitsbereich.\n2. Installiere ihn wie oben über **Arbeitsbereich installieren**.\n3. Starte jede App einzeln. Jede App öffnet immer nur ihren eigenen Arbeitsbereich.\n\nJede App hat ihre eigene Anmeldung. Deine Anmeldung im normalen Cockpit bleibt davon unberührt.\n\n### In der App anmelden und abmelden\n\n1. Zum Abmelden öffne in der App das **Benutzermenü** und wähle **Abmelden**.\n2. Zum erneuten Anmelden starte die App und wähle **Mit Firmenkonto anmelden**.\n3. Klappt das nicht, melde dich im normalen Cockpit an und öffne die App dort über **Arbeitsbereich installieren** erneut.\n\n**Abmelden** meldet nur diese App ab, nicht deine anderen Apps und nicht das normale Cockpit.\n\n### Branding eines Arbeitsbereichs festlegen\n\n1. Öffne **Einstellungen** und darin unter **Arbeiten mit sk** den Bereich **Arbeitsbereich-Branding**.\n2. Lade unter **App-Icon (1:1)** ein quadratisches PNG mit mindestens 512 Pixeln Kantenlänge hoch.\n3. Wähle unter **Farbpalette** zwischen **Standard**, **Indigo** und **Teal**.\n\n   ![Arbeitsbereich-Branding des fiktiven Arbeitsbereichs Brennwerk mit dem Organisationsnamen Brennwerk, dem Untertitel Logistik, dem dunkelgrünen App-Icon mit orangefarbener Flamme, dem hellen und dunklen Logo und der gewählten Farbpalette Teal; die Seitenleiste zeigt dasselbe Logo und die Wortmarke](/docs-images/cockpit-app-branding.de.webp?v=c5e5bbfda5b2)\n\n4. Prüfe die Vorschau und wähle **Änderungen speichern**.\n\nOhne beide Rechte kannst du das Branding nur ansehen.\nDen App-Namen bestimmt der Name des Arbeitsbereichs, nicht der **Organisationsname** im Branding.\n**Branding zurücksetzen** stellt das SubKit-Erscheinungsbild für alle Mitglieder wieder her.\n\n### Installierte App entfernen\n\n1. Öffne das normale Cockpit im Browser und wechsle zum Arbeitsbereich der App.\n2. Wähle im Menü des Arbeitsbereichs **Installation widerrufen** und bestätige. Die App ist damit auf allen ihren Geräten abgemeldet.\n3. Entferne die App danach wie jede andere App von deinem Gerät.\n\nInstallierst du später neu, entsteht eine neue App-Adresse. Alte Links funktionieren nicht mehr.\n\n### Gut zu wissen\n\n- Benachrichtigungen schaltest du in der App unter **Benachrichtigungen** mit **Neutrale Benachrichtigungen aktivieren** ein. Die Hinweise enthalten keine Details zu Arbeitsbereich oder Workflow.\n- Texte und Dateien, die du mit der App teilst, landen erst nach deiner Bestätigung im **Eingang**. Sie werden dadurch weder Wissen, noch starten sie einen Workflow.\n- Name und Symbol einer installierten App kann dein Browser oder Betriebssystem auch nach dem Abmelden weiter anzeigen.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| „Installation nicht möglich“ | Nutze das Cockpit weiter im Browser oder öffne es in einem Browser, der Web-Apps installieren kann. |\n| „Installierte Apps benötigen für die erneute Anmeldung ein bestehendes OIDC-Konto. …“ | Melde dich im normalen Cockpit an und öffne die App dort über **Arbeitsbereich installieren** erneut. |\n| „Browser-Berechtigung verweigert. Bitte in den Einstellungen erlauben.“ | Erlaube Benachrichtigungen für die Cockpit-Adresse in den Einstellungen deines Browsers. |\n| \"Open the app, sign in and share again.\" | Starte die App, melde dich an und teile den Inhalt erneut. |\n| „Verwende ein nicht animiertes PNG, JPEG oder WebP mit maximal 2 MiB und 4 Megapixeln.“ | Lade als App-Icon ein quadratisches PNG mit mindestens 512 Pixeln Kantenlänge und höchstens 2 MiB hoch. |"
        }
      }
    },
    {
      "slug": "maintain-sources-skills-and-files",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 10,
      "generated": false,
      "locales": {
        "en": {
          "title": "Maintain sources, skills and files",
          "summary": "Keep your team's knowledge current and bring back earlier states.",
          "headings": [
            {
              "depth": 2,
              "text": "Maintain sources, skills and files",
              "anchor": "maintain-sources-skills-and-files"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Compare versions of a source or a skill",
              "anchor": "compare-versions-of-a-source-or-a-skill"
            },
            {
              "depth": 3,
              "text": "Restore an earlier version",
              "anchor": "restore-an-earlier-version"
            },
            {
              "depth": 3,
              "text": "Find conversations about a source or a skill",
              "anchor": "find-conversations-about-a-source-or-a-skill"
            },
            {
              "depth": 3,
              "text": "Decide skill proposals",
              "anchor": "decide-skill-proposals"
            },
            {
              "depth": 3,
              "text": "Replace a file",
              "anchor": "replace-a-file"
            },
            {
              "depth": 3,
              "text": "Restore an earlier state of a file",
              "anchor": "restore-an-earlier-state-of-a-file"
            },
            {
              "depth": 3,
              "text": "If something does not work",
              "anchor": "if-something-does-not-work"
            },
            {
              "depth": 3,
              "text": "The same in the terminal",
              "anchor": "the-same-in-the-terminal"
            }
          ],
          "images": [],
          "sha256": "fe94c3da765b22c2a2a1568a4fd9f15556c244f2e666b4ef91f47f4f0fa84758",
          "body": "## Maintain sources, skills and files\n\nThis chapter is for anyone who maintains their team's knowledge in the Cockpit. You find sources, skills and files in the **Knowledge** group. Afterwards you know who changed what, and you bring back an earlier state without losing the current one.\n\nThe three terms in everyday words:\n\n- **Source**: a document the assistant looks things up in, such as a price list or a manual.\n- **Skill**: a rule the assistant follows, such as your guidelines for invoice texts.\n- **File**: a file a workflow reads or produces, such as a template or a report.\n\n### What you need\n\n- To view: `knowledge:read` for sources, `skill:read` for skills, `file:read` for files.\n- To restore and replace: `knowledge:write`, `skill:write` or `file:write`.\n\n### Compare versions of a source or a skill\n\nEvery change to a source or a skill becomes a new version. For each version you see who saved it and when. Sources often also say why. For sources, SubKit keeps up to 50 versions.\n\n1. Open **Sources** or **Skills** and click a source or a skill.\n2. Open the **Versions** tab. The newest version is on top and marked **Current**.\n3. Click a version. Under **Change since v…** you see **Before** and **After** side by side.\n\n### Restore an earlier version\n\n1. Open the version as above.\n2. Select **Restore this version**. The current version cannot be restored.\n3. The question **Restore this version?** appears. Confirm with **Restore**.\n\nSubKit saves the restored content as a new version. The previous version stays under **Versions**, so you can always go back.\n\n### Find conversations about a source or a skill\n\n1. Open the source or the skill.\n2. Open the **Usage** tab and expand **Conversations about this**.\n\nThe list shows conversations that name the source or the skill with an `@` reference. For a source, it also counts conversations in which the assistant read or found the source. For a skill, it also counts conversations that loaded the skill. Click a conversation to open it. If there is none yet, start one with **Ask in chat**.\n\n### Decide skill proposals\n\nSubKit proposes skills when a pattern keeps recurring. You decide them on the **Skill candidates** page, not in the skills table.\n\n1. Open **Skills** and click **… proposals open** in the header.\n2. Click a candidate and review its content and scope.\n3. Choose **Accept** or **Discard**. To decide several candidates at once, select them in the list.\n\nDiscarding needs `skill:write`; accepting also needs `skill:activate`. SubKit does not propose a discarded candidate again.\n\n### Replace a file\n\n1. Open **Files** and click the file.\n2. Open **More actions** and choose **Replace**.\n3. Choose the new file and confirm with **Replace**.\n\nThe reference to the file stays the same. Workflows and the chat therefore use the new content right away, without you changing them. The new filename is adopted, and the previous content stays as an earlier version.\n\n### Restore an earlier state of a file\n\n1. Open the file and its **Usage** tab.\n2. Expand **Replaced**. The section appears once a file has earlier versions.\n3. Click a version. You see its preview.\n4. On an earlier version, select **Restore**.\n\nThe earlier state becomes current again as a new version. The current content stays as an earlier version.\n\nGood to know:\n\n- SubKit keeps the last 20 earlier versions of a file.\n- Deleting a file also removes all its earlier versions.\n\n### If something does not work\n\n| What you see | What to do |\n| --- | --- |\n| **Restore this version** is missing | You opened the current version. Open an earlier one. If the button is still missing, ask an administrator for the write permission for sources or skills. |\n| \"This version has no saved state, so it cannot be restored.\" | Choose another version, or change the skill directly. |\n| The **Replaced** section is missing | The file was never replaced. It has no earlier versions yet. |\n| **Replace** is missing in the menu | Ask an administrator for `file:write`. |\n\n### The same in the terminal\n\nYou can also replace files with the `sk` command line. How to set it up is in the chapter \"Use the sk CLI on your machine\".\n\n```bash\nsk files replace <file-id> <path>\nsk files versions <file-id>\nsk files restore <file-id> <version>\n```"
        },
        "de": {
          "title": "Quellen, Skills und Dateien pflegen",
          "summary": "Halte das Wissen deines Teams aktuell und hol frühere Stände zurück.",
          "headings": [
            {
              "depth": 2,
              "text": "Quellen, Skills und Dateien pflegen",
              "anchor": "quellen-skills-und-dateien-pflegen"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Versionen einer Quelle oder eines Skills vergleichen",
              "anchor": "versionen-einer-quelle-oder-eines-skills-vergleichen"
            },
            {
              "depth": 3,
              "text": "Eine frühere Version wiederherstellen",
              "anchor": "eine-frühere-version-wiederherstellen"
            },
            {
              "depth": 3,
              "text": "Unterhaltungen zu einer Quelle oder einem Skill finden",
              "anchor": "unterhaltungen-zu-einer-quelle-oder-einem-skill-finden"
            },
            {
              "depth": 3,
              "text": "Skill-Vorschläge entscheiden",
              "anchor": "skill-vorschläge-entscheiden"
            },
            {
              "depth": 3,
              "text": "Eine Datei ersetzen",
              "anchor": "eine-datei-ersetzen"
            },
            {
              "depth": 3,
              "text": "Einen früheren Stand einer Datei wiederherstellen",
              "anchor": "einen-früheren-stand-einer-datei-wiederherstellen"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            },
            {
              "depth": 3,
              "text": "Dasselbe im Terminal",
              "anchor": "dasselbe-im-terminal"
            }
          ],
          "images": [],
          "sha256": "939560cbb1e4f847af64148eb1b6752695aba77984d7b70bf5fbed8c8f4107de",
          "body": "## Quellen, Skills und Dateien pflegen\n\nDieses Kapitel ist für alle, die im Cockpit das Wissen ihres Teams pflegen. Du findest Quellen, Skills und Dateien in der Gruppe **Wissen**. Danach weißt du, wer was geändert hat, und holst einen früheren Stand zurück, ohne den jetzigen zu verlieren.\n\nDie drei Begriffe im Alltag:\n\n- **Quelle**: ein Dokument, in dem der Assistent nachschlägt, etwa eine Preisliste oder ein Handbuch.\n- **Skill**: eine Regel, an die sich der Assistent hält, etwa eure Vorgaben für Rechnungstexte.\n- **Datei**: eine Datei, die ein Workflow liest oder erzeugt, etwa eine Vorlage oder ein Bericht.\n\n### Was du brauchst\n\n- Zum Ansehen: `knowledge:read` für Quellen, `skill:read` für Skills, `file:read` für Dateien.\n- Zum Wiederherstellen und Ersetzen: `knowledge:write`, `skill:write` oder `file:write`.\n\n### Versionen einer Quelle oder eines Skills vergleichen\n\nJede Änderung an einer Quelle oder einem Skill wird eine neue Version. Zu jeder Version siehst du, wer sie gespeichert hat und wann. Bei Quellen steht oft auch dabei, warum. Bei Quellen bewahrt SubKit bis zu 50 Versionen auf.\n\n1. Öffne **Quellen** oder **Skills** und klicke auf eine Quelle oder einen Skill.\n2. Öffne den Tab **Versionen**. Die neueste Version steht oben und ist mit **Aktuell** markiert.\n3. Klicke auf eine Version. Unter **Änderung gegenüber v…** siehst du **Vorher** und **Nachher** nebeneinander.\n\n### Eine frühere Version wiederherstellen\n\n1. Öffne die Version wie oben.\n2. Wähle **Diese Version wiederherstellen**. Die aktuelle Version lässt sich nicht wiederherstellen.\n3. Die Frage **Diese Version wiederherstellen?** erscheint. Bestätige mit **Wiederherstellen**.\n\nSubKit speichert den wiederhergestellten Inhalt als neue Version. Die bisherige Version bleibt unter **Versionen** erhalten, du kannst also jederzeit zurück.\n\n### Unterhaltungen zu einer Quelle oder einem Skill finden\n\n1. Öffne die Quelle oder den Skill.\n2. Öffne den Tab **Verwendung** und klappe **Unterhaltungen dazu** auf.\n\nDie Liste zeigt Unterhaltungen, die die Quelle oder den Skill mit einem `@`-Verweis nennen. Bei einer Quelle zählen auch Unterhaltungen, in denen der Assistent die Quelle gelesen oder gefunden hat. Bei einem Skill zählen auch Unterhaltungen, die den Skill geladen haben. Klicke auf eine Unterhaltung, um sie zu öffnen. Gibt es noch keine, startest du mit **Im Chat fragen** eine neue.\n\n### Skill-Vorschläge entscheiden\n\nSubKit schlägt Skills vor, wenn sich ein Muster wiederholt. Du entscheidest sie auf der Seite **Skill-Kandidaten**, nicht in der Skill-Tabelle.\n\n1. Öffne **Skills** und klicke im Kopf auf **… Vorschläge offen**.\n2. Klicke auf einen Kandidaten und prüfe Inhalt und Geltungsbereich.\n3. Wähle **Übernehmen** oder **Verwerfen**. Mehrere Kandidaten wählst du in der Liste aus und entscheidest sie gemeinsam.\n\nZum Verwerfen brauchst du `skill:write`, zum Übernehmen zusätzlich `skill:activate`. Einen verworfenen Kandidaten schlägt SubKit nicht noch einmal vor.\n\n### Eine Datei ersetzen\n\n1. Öffne **Dateien** und klicke auf die Datei.\n2. Öffne **Weitere Aktionen** und wähle **Ersetzen**.\n3. Wähle die neue Datei und bestätige mit **Ersetzen**.\n\nDer Verweis auf die Datei bleibt gleich. Workflows und Chat nutzen deshalb sofort den neuen Inhalt, ohne dass du sie anpasst. Der neue Dateiname wird übernommen, der bisherige Inhalt bleibt als frühere Version erhalten.\n\n### Einen früheren Stand einer Datei wiederherstellen\n\n1. Öffne die Datei und den Tab **Verwendung**.\n2. Klappe **Ersetzt** auf. Der Bereich erscheint, sobald eine Datei frühere Versionen hat.\n3. Klicke auf eine Version. Du siehst ihre Vorschau.\n4. Wähle bei einer früheren Version **Wiederherstellen**.\n\nDer frühere Stand wird als neue Version aktuell. Der jetzige Inhalt bleibt als frühere Version erhalten.\n\nGut zu wissen:\n\n- SubKit behält die letzten 20 früheren Versionen einer Datei.\n- Löschst du eine Datei, entfernt das auch alle ihre früheren Versionen.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| **Diese Version wiederherstellen** fehlt | Du hast die aktuelle Version geöffnet. Öffne eine frühere. Fehlt der Button weiter, bitte eine Administratorin oder einen Administrator um das Schreibrecht für Quellen oder Skills. |\n| „Für diese Version ist kein Stand gespeichert; sie lässt sich nicht wiederherstellen.“ | Wähle eine andere Version oder ändere den Skill direkt. |\n| Der Bereich **Ersetzt** fehlt | Die Datei wurde noch nie ersetzt. Es gibt noch keine früheren Versionen. |\n| **Ersetzen** fehlt im Menü | Bitte eine Administratorin oder einen Administrator um `file:write`. |\n\n### Dasselbe im Terminal\n\nDateien ersetzt du auch mit der Kommandozeile `sk`. Wie du sie einrichtest, steht im Kapitel „Die sk-CLI auf deinem Rechner verwenden“.\n\n```bash\nsk files replace <file-id> <path>\nsk files versions <file-id>\nsk files restore <file-id> <version>\n```"
        }
      }
    },
    {
      "slug": "usage-and-costs",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "work",
      "order": 11,
      "generated": false,
      "locales": {
        "en": {
          "title": "Keep track of usage and costs",
          "summary": "See what AI calls cost, and set the budget and prices.",
          "headings": [
            {
              "depth": 2,
              "text": "Keep track of usage and costs",
              "anchor": "keep-track-of-usage-and-costs"
            },
            {
              "depth": 3,
              "text": "What you need",
              "anchor": "what-you-need"
            },
            {
              "depth": 3,
              "text": "Choose the time window",
              "anchor": "choose-the-time-window"
            },
            {
              "depth": 3,
              "text": "The five tiles",
              "anchor": "the-five-tiles"
            },
            {
              "depth": 3,
              "text": "Worth a look",
              "anchor": "worth-a-look"
            },
            {
              "depth": 3,
              "text": "Cost by origin",
              "anchor": "cost-by-origin"
            },
            {
              "depth": 3,
              "text": "Break down by",
              "anchor": "break-down-by"
            },
            {
              "depth": 3,
              "text": "Open details",
              "anchor": "open-details"
            },
            {
              "depth": 3,
              "text": "Adjust the budget",
              "anchor": "adjust-the-budget"
            },
            {
              "depth": 3,
              "text": "Set a price",
              "anchor": "set-a-price"
            },
            {
              "depth": 3,
              "text": "Export",
              "anchor": "export"
            },
            {
              "depth": 3,
              "text": "Technical details",
              "anchor": "technical-details"
            },
            {
              "depth": 3,
              "text": "When something does not work",
              "anchor": "when-something-does-not-work"
            },
            {
              "depth": 3,
              "text": "The same in the terminal",
              "anchor": "the-same-in-the-terminal"
            }
          ],
          "images": [],
          "sha256": "2fbf7ab8031a150be8a52e0152084078f3a24bc45cdeab64acaed92a8b4c2423",
          "body": "## Keep track of usage and costs\n\nThis chapter is for anyone who needs to know what AI costs in the workspace, usually team leads or admins. Afterwards you know the cost per workflow, person and model, and you set how many tokens a month allows. An AI call is one request from SubKit to an AI model.\n\nEverything is on the **Usage** page. At the top, one sentence sums up the time window, for example \"This week: $84.20 for 1,240 AI calls.\" When costs rise, the sentence names the largest driver.\n\n### What you need\n\n- To view the page: `stats:read`. By default only the Admin role has it.\n- For **Person** and **Conversation** under **Break down by**: `stats:read:all`. Without it you do not see these tabs.\n- To change the budget and prices: `settings:write`. The Admin role has both.\n\n### Choose the time window\n\nChoose the **Time window** at the top right: **24 h**, **This week**, **Last week**, **This month** or **Last month**.\nWeeks start on Monday, and your time zone applies.\nAll figures compare the window with the same span before.\n\nThe **Overview** offers the same choice. Its **Usage** tile follows the chosen time window and shows the cost in it or \"No AI calls in this window\". Below that it shows how much of the monthly budget is used, for example \"42% of the monthly token budget\". The tile is enough for a quick look; for the reasons, open **Usage**.\n\nHow to read the trend:\n\n- **↑ 18%** or **↓ 18%**: more or less than in the window before.\n- **≈ same**: less than 5% difference.\n- **New**: not used in the window before.\n- **–**: there is no data for the window before.\n\n### The five tiles\n\n- **Cost**: the estimated cost of all AI calls in the window.\n- **AI calls**: how often SubKit asked an AI model. When calls failed, it shows for example **3 failed**. A click opens the Failed AI calls.\n- **Budget · Month**: how much of the monthly budget is used. This tile always covers the current month.\n- **Saved by cache**: what reused input saved compared with full price.\n- **From the cache**: the share of input that was reused instead of paid again. Below it, **Cache per flow** shows the share for each source. Higher is cheaper and faster. **No data** means the provider reports no cache for that source.\n\nThe forecast sits below the budget. SubKit projects it from the last 7 days:\n\n- **Lasts to month end.**\n- **About 94% by month end.** The budget is getting tight.\n- **Used up on the 26.** The budget does not last to month end.\n- **Used up. Chat, creating and fixes are paused.**\n- **No forecast yet. Too few days this month.** This applies to the first two days of a month.\n\nWhen a model has no price, the cost shows **at least** in front.\nThe amount is then a floor. The real cost is higher.\nBelow it you see how many calls have no price, for example **Calls without a price: 12**.\nWhen no prices are known at all, the tile shows **Cost unknown**.\n\n### Worth a look\n\n**Worth a look** lists what changed clearly or costs money.\nEach notice has a matching action:\n\n| Notice | Action |\n| --- | --- |\n| A workflow costs at least 1.5 times as much per run as in the window before. | **View cost** |\n| A model has no price. | **View model** |\n| Several models have no price. | **View models** |\n| The monthly budget will likely run out before month end. | **Adjust budget** |\n| One person accounts for at least half of the cost. | **View breakdown** |\n\nWhen nothing stands out, it says \"Nothing unusual in this window.\"\n\n### Cost by origin\n\n**Cost by origin** shows the cost per day, or per hour for **24 h**.\nThe bars are stacked by origin:\n\n- **Chat**: replies in conversations.\n- **Designing workflows**: creating and fixing workflows in chat.\n- **Summaries**: short summaries of runs and content.\n- **Checks**: AI checks drafts and results.\n- **Knowledge & files**: reading and describing sources and files.\n- **Workflow runs**: \"Ask AI\" steps in runs.\n- **Other**: everything without a known origin.\n\n**As table** shows the same values as a table with a **Total** column. **As chart** switches back.\nClick an origin in the list below to open its details.\nWhen prices are missing, the chart shows token amounts instead of cost.\n\n### Break down by\n\nUnder **Break down by** you choose **Workflow**, **Person**, **Model** or **Conversation**.\nEach row shows **Cost**, **AI calls**, **Share** and **Trend**.\nSome tabs add a column: **Runs** for Workflow, **Error rate** for Model, **Last active** for Conversation.\n\nThe last row collects what belongs to no row:\n\n- **No workflow (chat, designing, knowledge …)**\n- **No person (automatic)**: schedules, webhooks and background work such as cataloguing\n- **Other** for models\n- **No conversation (runs, knowledge, checks …)**\n\nThat way all rows together add up to the total at the top.\n\n### Open details\n\nClick a row to open its details at the side:\n\n- **Workflow**: **Cost per run**, **AI calls per run**, **Most expensive runs** and **Models used**. **Open workflow** takes you to the workflow.\n- **Person**: **Where usage comes from**, plus their **Workflows** and **Conversations**.\n- **Model**: **Share from cache**, **Error rate**, **Price per 1M tokens** and **Response time (typical)**.\n- **Conversation**: cost and AI calls. **Open conversation** takes you to the chat.\n- **Origin**: under **Largest items**, the most expensive workflows, people or models of this origin.\n\nLong conversations get more expensive because every reply reads the history so far. A new topic is worth a new conversation.\n\nYou open **Failed AI calls** from the **AI calls** tile.\nFailed calls can still cost money. The sheet names the amount.\nUnder **Where they happen** you see the workflow or conversation and the reason:\n**Provider error**, **Input too large** or **Budget used up**.\n\n### Adjust the budget\n\nThe monthly budget is the maximum number of tokens your workspace may use in a month. It covers all people and workflows together.\n\n1. Click **Adjust budget** under Worth a look, or the forecast in the tile.\n   Without a budget, choose **Set a budget** in the tile.\n2. Enter a value under **Tokens per month**.\n3. Save. The message **Budget saved** confirms the change.\n\nYou need `settings:write` for this, so by default the Admin role.\nWithout it you only see the current state and \"Ask someone with the Admin role.\"\n\nWhat happens as tokens are used:\n\n- From 75% a notice appears.\n- At 100% chat, designing workflows and fixes pause until the first of the month.\n- Approved workflows keep running. What is already in operation does not stop.\n- Requests SubKit rejects because of the budget never count towards usage.\n\nWithout a budget, AI calls are unlimited.\n\n### Set a price\n\nWhen a model has no price, its calls are missing from the cost.\n\n1. Open the model, for example through **View model** or the **Model** tab.\n2. Choose **Set a price**.\n3. Enter **Input per 1M tokens** and **Output per 1M tokens** and save.\n\nThe message **Price saved** confirms the change. The page then calculates with the new price.\nYou need `settings:write` for this too, so by default the Admin role.\nThe price applies to your workspace. In the settings it sits under `tokens.prices`.\n\n### Export\n\n1. Choose **Export** at the top.\n2. Confirm with **Export**.\n\nYou get a CSV file for the chosen window.\nThe file has one line per day, origin and model, or per hour for **24 h**.\nThe columns are the time, **Origin**, **Model**, **AI calls**, the four token kinds, **Cost** and **Currency**.\n\n### Technical details\n\nExpand **Technical details** at the end of the page. It shows:\n\n- **Input tokens**, **Output tokens**, **Cache read**, **Cache written** and **Total**.\n- **Models without a price** and the number of calls without a price.\n- The **Budget** in tokens, for example \"120,000 of 150,000 tokens · 30,000 left\".\n- The **Price source**: built-in list prices per model, or the prices set in `tokens.prices`.\n- Your **Time zone** and the **Internal flows per origin**.\n- The **Query** that fetches the same numbers through the CLI or the API.\n\n### When something does not work\n\n| What you see | What you do |\n| --- | --- |\n| **No rights** instead of the page | Ask someone with the Admin role for `stats:read`. |\n| **Person** and **Conversation** are missing | You lack `stats:read:all`. Ask someone with the Admin role for it. |\n| **at least** in front of the cost | Some models have no price. Add it through **Set a price**. |\n| **Cost unknown** | None of the models used has a price. Add the prices. |\n| \"Ask someone with the Admin role.\" instead of **Adjust budget** | You lack `settings:write`. Ask someone with the Admin role to change the budget. |\n| Chat, designing and fixes are paused | The monthly budget is used up. Raise it or wait for the first of the month. |\n| \"The budget could not be read …\" | Reload the page. This says nothing about whether a budget is set. |\n| \"No AI calls in this window.\" | Choose **Show this month** or another window. |\n\n### The same in the terminal\n\nYou get the same numbers with `sk stats llm` or through the HTTP API with `GET /v1/stats/llm`. Each answer includes tokens, cost and the savings from the cache. How to set up `sk` is in the chapter \"Use the sk CLI on your machine\".\n\n```bash\nsk stats llm --bucket day --from <from> --to <to> --group-by workflow\n```\n\n- `group_by` breaks down by `model`, `flow`, `user`, `workflow`, `conversation` or `execution`. At most two values at once.\n- `result=` filters by result: `success`, `quota_exhausted`, `context_too_large` or `error`.\n- `workflow_id=` shows only the calls of one workflow.\n- Breakdowns by `user` or `conversation` need `stats:read:all`. That does not apply when `user_id` is your own ID."
        },
        "de": {
          "title": "Nutzung und Kosten im Blick",
          "summary": "Sieh, was KI-Aufrufe kosten, und lege Budget und Preise fest.",
          "headings": [
            {
              "depth": 2,
              "text": "Nutzung und Kosten im Blick",
              "anchor": "nutzung-und-kosten-im-blick"
            },
            {
              "depth": 3,
              "text": "Was du brauchst",
              "anchor": "was-du-brauchst"
            },
            {
              "depth": 3,
              "text": "Den Zeitraum wählen",
              "anchor": "den-zeitraum-wählen"
            },
            {
              "depth": 3,
              "text": "Die fünf Kacheln",
              "anchor": "die-fünf-kacheln"
            },
            {
              "depth": 3,
              "text": "Auffälligkeiten",
              "anchor": "auffälligkeiten"
            },
            {
              "depth": 3,
              "text": "Kosten nach Herkunft",
              "anchor": "kosten-nach-herkunft"
            },
            {
              "depth": 3,
              "text": "Aufschlüsseln nach",
              "anchor": "aufschlüsseln-nach"
            },
            {
              "depth": 3,
              "text": "Details öffnen",
              "anchor": "details-öffnen"
            },
            {
              "depth": 3,
              "text": "Kontingent anpassen",
              "anchor": "kontingent-anpassen"
            },
            {
              "depth": 3,
              "text": "Preis hinterlegen",
              "anchor": "preis-hinterlegen"
            },
            {
              "depth": 3,
              "text": "Exportieren",
              "anchor": "exportieren"
            },
            {
              "depth": 3,
              "text": "Technische Angaben",
              "anchor": "technische-angaben"
            },
            {
              "depth": 3,
              "text": "Wenn etwas nicht klappt",
              "anchor": "wenn-etwas-nicht-klappt"
            },
            {
              "depth": 3,
              "text": "Dasselbe im Terminal",
              "anchor": "dasselbe-im-terminal"
            }
          ],
          "images": [],
          "sha256": "d28429f02142432493f2c94d71dd4999a635a52cce090770747d81f8eae5f2f8",
          "body": "## Nutzung und Kosten im Blick\n\nDieses Kapitel ist für alle, die wissen müssen, was die KI im Arbeitsbereich kostet, meist Teamleitung oder Admin. Danach kennst du die Kosten je Workflow, Person und Modell und legst fest, wie viele Token pro Monat erlaubt sind. Ein KI-Aufruf ist dabei eine Anfrage von SubKit an ein KI-Modell.\n\nAlles steht auf der Seite **Nutzung**. Ganz oben fasst ein Satz den Zeitraum zusammen, etwa „Diese Woche 84,20 $ für 1.240 KI-Aufrufe.“ Steigen die Kosten, nennt der Satz den größten Treiber.\n\n### Was du brauchst\n\n- Zum Ansehen: `stats:read`. Standardmäßig hat das nur die Rolle Admin.\n- Für **Person** und **Unterhaltung** unter **Aufschlüsseln nach**: `stats:read:all`. Ohne dieses Recht siehst du diese Tabs nicht.\n- Zum Ändern von Kontingent und Preisen: `settings:write`. Die Rolle Admin hat beide Rechte.\n\n### Den Zeitraum wählen\n\nWähle oben rechts den **Zeitraum**: **24 Std**, **Diese Woche**, **Letzte Woche**, **Dieser Monat** oder **Letzter Monat**.\nWochen beginnen am Montag, und es gilt deine Zeitzone.\nAlle Zahlen vergleichen den Zeitraum mit dem gleich langen Abschnitt davor.\n\nDie **Übersicht** bietet dieselbe Auswahl. Dort folgt die Kachel **Nutzung** dem gewählten Zeitraum und zeigt die Kosten darin oder „Keine KI-Aufrufe im Zeitraum“. Darunter steht, wie viel des Monatskontingents verbraucht ist, etwa „42 % des Monatskontingents“. Für den schnellen Blick reicht diese Kachel, für die Gründe öffnest du **Nutzung**.\n\nSo liest du den Trend:\n\n- **↑ 18 %** oder **↓ 18 %**: mehr oder weniger als im Zeitraum davor.\n- **≈ gleich**: weniger als 5 % Unterschied.\n- **Neu**: im Zeitraum davor noch nicht genutzt.\n- **–**: Für den Zeitraum davor fehlen Daten.\n\n### Die fünf Kacheln\n\n- **Kosten**: geschätzte Kosten aller KI-Aufrufe im Zeitraum.\n- **KI-Aufrufe**: wie oft SubKit ein KI-Modell gefragt hat. Gibt es Fehler, steht darunter etwa **3 fehlgeschlagen**. Ein Klick öffnet die Fehlgeschlagenen KI-Aufrufe.\n- **Kontingent · Monat**: wie viel vom Monatskontingent verbraucht ist. Diese Kachel gilt immer für den laufenden Monat.\n- **Gespart durch Cache**: was wiederverwendete Eingaben gegenüber dem vollen Preis gespart haben.\n- **Aus dem Zwischenspeicher**: welcher Anteil der Eingabe wiederverwendet statt neu bezahlt wurde. Darunter zeigt **Zwischenspeicher je Ablauf** den Anteil je Herkunft. Höher ist günstiger und schneller. **Ohne Daten** heißt: Der Anbieter meldet für diese Herkunft keinen Zwischenspeicher.\n\nUnter dem Kontingent steht die Prognose. SubKit rechnet dafür den Verbrauch der letzten 7 Tage hoch:\n\n- **Reicht bis Monatsende.**\n- **Bis Monatsende etwa 94 %.** Das Kontingent wird knapp.\n- **Aufgebraucht am 26.** Das Kontingent reicht nicht bis Monatsende.\n- **Aufgebraucht. Chat, Erstellen und Korrekturen stehen still.**\n- **Noch keine Prognose. Zu wenige Tage im Monat.** Das gilt für die ersten beiden Tage im Monat.\n\nFehlt für ein Modell ein Preis, steht vor den Kosten **mind.**\nDer Betrag ist dann eine Untergrenze. Die echten Kosten sind höher.\nDarunter steht, wie viele Aufrufe keinen Preis haben, etwa **Aufrufe ohne Preis: 12**.\nFehlen alle Preise, zeigt die Kachel **Kosten unbekannt**.\n\n### Auffälligkeiten\n\nUnter **Auffälligkeiten** steht, was sich deutlich verändert hat oder Geld kostet.\nJeder Hinweis hat eine passende Aktion:\n\n| Hinweis | Aktion |\n| --- | --- |\n| Ein Workflow kostet je Lauf mindestens 1,5-mal so viel wie im Zeitraum davor. | **Kosten ansehen** |\n| Für ein Modell ist kein Preis hinterlegt. | **Modell ansehen** |\n| Für mehrere Modelle ist kein Preis hinterlegt. | **Modelle ansehen** |\n| Das Monatskontingent ist voraussichtlich vor Monatsende aufgebraucht. | **Kontingent anpassen** |\n| Eine Person verursacht mindestens die Hälfte der Kosten. | **Aufschlüsselung ansehen** |\n\nIst alles ruhig, steht dort „Nichts Auffälliges in diesem Zeitraum.“\n\n### Kosten nach Herkunft\n\n**Kosten nach Herkunft** zeigt die Kosten je Tag, bei **24 Std** je Stunde.\nDie Balken sind nach Herkunft gestapelt:\n\n- **Chat**: Antworten in Unterhaltungen.\n- **Workflows entwerfen**: Workflows im Chat erstellen und korrigieren.\n- **Zusammenfassungen**: Kurzfassungen von Läufen und Inhalten.\n- **Prüfungen**: KI prüft Entwürfe und Ergebnisse.\n- **Wissen & Dateien**: Quellen und Dateien lesen und beschreiben.\n- **Workflow-Läufe**: Schritte „KI fragen“ in Läufen.\n- **Sonstiges**: alles, was keiner Herkunft zuzuordnen ist.\n\nMit **Als Tabelle** siehst du dieselben Werte als Tabelle mit einer Spalte **Summe**. **Als Diagramm** schaltet zurück.\nKlick auf eine Herkunft in der Liste darunter, um ihre Details zu öffnen.\nFehlen Preise, zeigt das Diagramm die Token-Menge statt der Kosten.\n\n### Aufschlüsseln nach\n\nUnter **Aufschlüsseln nach** wählst du **Workflow**, **Person**, **Modell** oder **Unterhaltung**.\nJede Zeile zeigt **Kosten**, **KI-Aufrufe**, **Anteil** und **Trend**.\nJe nach Tab kommt eine Spalte dazu: **Läufe** bei Workflow, **Fehlerquote** bei Modell, **Zuletzt** bei Unterhaltung.\n\nDie letzte Zeile sammelt, was keiner Zeile zuzuordnen ist:\n\n- **Ohne Workflow (Chat, Entwerfen, Wissen …)**\n- **Ohne Person (automatisch)**: Zeitpläne, Webhooks und Hintergrundarbeit wie das Katalogisieren\n- **Weitere** bei Modellen\n- **Ohne Unterhaltung (Läufe, Wissen, Prüfungen …)**\n\nSo ergeben alle Zeilen zusammen die Summe oben.\n\n### Details öffnen\n\nKlick auf eine Zeile, um ihre Details seitlich zu öffnen:\n\n- **Workflow**: **Kosten je Lauf**, **KI-Aufrufe je Lauf**, **Teuerste Läufe** und **Genutzte Modelle**. Mit **Workflow öffnen** springst du zum Workflow.\n- **Person**: **Woher die Nutzung kommt**, dazu ihre **Workflows** und **Unterhaltungen**.\n- **Modell**: **Anteil aus Cache**, **Fehlerquote**, **Preis je 1 Mio. Token** und **Antwortzeit (typisch)**.\n- **Unterhaltung**: Kosten und KI-Aufrufe. Mit **Unterhaltung öffnen** springst du in den Chat.\n- **Herkunft**: unter **Größte Posten** die teuersten Workflows, Personen oder Modelle dieser Herkunft.\n\nLange Unterhaltungen werden teurer, weil jede Antwort den bisherigen Verlauf mitliest. Für ein neues Thema lohnt eine neue Unterhaltung.\n\n**Fehlgeschlagene KI-Aufrufe** öffnest du über die Kachel **KI-Aufrufe**.\nFehlgeschlagene Aufrufe können trotzdem kosten. Das Sheet nennt den Betrag.\nUnter **Wo sie auftreten** siehst du Workflow oder Unterhaltung und den Grund:\n**Fehler beim Anbieter**, **Eingabe zu groß** oder **Kontingent aufgebraucht**.\n\n### Kontingent anpassen\n\nDas Monatskontingent ist die Höchstmenge an Token, die dein Arbeitsbereich im Monat verbrauchen darf. Es gilt für alle Personen und Workflows zusammen.\n\n1. Klick auf **Kontingent anpassen** in den Auffälligkeiten oder auf die Prognose in der Kachel.\n   Ohne Kontingent wählst du **Kontingent setzen** in der Kachel.\n2. Trag unter **Token pro Monat** einen Wert ein.\n3. Speichere. Die Meldung **Kontingent gespeichert** bestätigt die Änderung.\n\nDafür brauchst du `settings:write`, standardmäßig also die Rolle Admin.\nOhne dieses Recht siehst du nur den Stand und „Frag eine Person mit Admin-Rolle.“\n\nWas beim Verbrauch passiert:\n\n- Ab 75 % erscheint ein Hinweis.\n- Ab 100 % pausieren Chat, das Entwerfen von Workflows und Korrekturen bis zum Monatsersten.\n- Freigegebene Workflows laufen weiter. Was schon im Betrieb ist, bleibt also nicht stehen.\n- Anfragen, die SubKit wegen des Kontingents abweist, zählen nicht zum Verbrauch.\n\nOhne Kontingent sind KI-Aufrufe unbegrenzt.\n\n### Preis hinterlegen\n\nFehlt für ein Modell ein Preis, fehlen seine Aufrufe in den Kosten.\n\n1. Öffne das Modell, etwa über **Modell ansehen** oder den Tab **Modell**.\n2. Wähle **Preis hinterlegen**.\n3. Trag **Eingabe je 1 Mio. Token** und **Ausgabe je 1 Mio. Token** ein und speichere.\n\nDie Meldung **Preis gespeichert** bestätigt die Änderung. Danach rechnet die Seite mit dem neuen Preis.\nAuch dafür brauchst du `settings:write`, standardmäßig also die Rolle Admin.\nDer Preis gilt für deinen Arbeitsbereich. In den Einstellungen steht er unter `tokens.prices`.\n\n### Exportieren\n\n1. Wähle oben **Exportieren**.\n2. Bestätige mit **Exportieren**.\n\nDu bekommst eine CSV-Datei für den gewählten Zeitraum.\nDie Datei hat eine Zeile je Tag, Herkunft und Modell, bei **24 Std** je Stunde.\nDie Spalten sind Zeitpunkt, **Herkunft**, **Modell**, **KI-Aufrufe**, die vier Token-Arten, **Kosten** und **Währung**.\n\n### Technische Angaben\n\nKlappe **Technische Angaben** am Ende der Seite auf. Dort stehen:\n\n- **Eingabe-Token**, **Ausgabe-Token**, **Aus Cache gelesen**, **In Cache geschrieben** und **Gesamt**.\n- **Modelle ohne Preis** und die Zahl der Aufrufe ohne Preis.\n- Das **Kontingent** in Token, etwa „120.000 von 150.000 Token · 30.000 übrig“.\n- Die **Preisquelle**: eingebaute Listenpreise je Modell oder die Preise in `tokens.prices`.\n- Deine **Zeitzone** und die **Internen Abläufe je Herkunft**.\n- Die **Abfrage**, mit der du dieselben Zahlen per CLI oder API holst.\n\n### Wenn etwas nicht klappt\n\n| Was du siehst | Was du tust |\n| --- | --- |\n| **Keine Rechte** statt der Seite | Bitte eine Person mit Admin-Rolle um `stats:read`. |\n| **Person** und **Unterhaltung** fehlen | Dir fehlt `stats:read:all`. Bitte eine Person mit Admin-Rolle darum. |\n| **mind.** vor den Kosten | Für manche Modelle fehlt ein Preis. Hinterleg ihn über **Preis hinterlegen**. |\n| **Kosten unbekannt** | Für keines der genutzten Modelle ist ein Preis hinterlegt. Hinterleg die Preise. |\n| „Frag eine Person mit Admin-Rolle.“ statt **Kontingent anpassen** | Dir fehlt `settings:write`. Bitte eine Person mit Admin-Rolle, das Kontingent zu ändern. |\n| Chat, Entwerfen und Korrekturen stehen still | Das Monatskontingent ist aufgebraucht. Erhöhe es oder warte bis zum Monatsersten. |\n| „Das Kontingent war nicht lesbar …“ | Lad die Seite neu. Das sagt nichts darüber, ob ein Kontingent gesetzt ist. |\n| „Keine KI-Aufrufe in diesem Zeitraum.“ | Wähle **Dieser Monat anzeigen** oder einen anderen Zeitraum. |\n\n### Dasselbe im Terminal\n\nDieselben Zahlen holst du mit `sk stats llm` oder über die HTTP-API mit `GET /v1/stats/llm`. Jede Antwort enthält Token, Kosten und die Ersparnis durch den Cache. Wie du `sk` einrichtest, steht im Kapitel „Die sk-CLI auf deinem Rechner verwenden“.\n\n```bash\nsk stats llm --bucket day --from <from> --to <to> --group-by workflow\n```\n\n- `group_by` schlüsselt nach `model`, `flow`, `user`, `workflow`, `conversation` oder `execution` auf. Höchstens zwei Werte zugleich.\n- `result=` filtert nach Ergebnis: `success`, `quota_exhausted`, `context_too_large` oder `error`.\n- `workflow_id=` zeigt nur die Aufrufe eines Workflows.\n- Aufschlüsselungen nach `user` oder `conversation` brauchen `stats:read:all`. Das gilt nicht, wenn `user_id` deine eigene Kennung ist."
        }
      }
    },
    {
      "slug": "cockpit-branding",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 1,
      "generated": false,
      "locales": {
        "en": {
          "title": "Cockpit branding",
          "summary": "Give the Cockpit your company's name, logo and colors.",
          "headings": [
            {
              "depth": 2,
              "text": "Cockpit branding",
              "anchor": "cockpit-branding"
            },
            {
              "depth": 3,
              "text": "Change it in the Cockpit",
              "anchor": "change-it-in-the-cockpit"
            },
            {
              "depth": 3,
              "text": "What happens to uploaded logos",
              "anchor": "what-happens-to-uploaded-logos"
            },
            {
              "depth": 3,
              "text": "Through HTTP, CLI and MCP",
              "anchor": "through-http-cli-and-mcp"
            }
          ],
          "images": [],
          "sha256": "6b748412ad4b6357236b504f838a6c79181e860b4165347d619578a807487a8b",
          "body": "## Cockpit branding\n\nBranding makes the signed-in Cockpit show your name, your logo and a matching color palette instead of the SubKit look. You need it when your team should recognize the Cockpit as its own tool. Afterwards everyone signed in to your workspace sees the same look; login, email and other clients stay with SubKit.\n\n### Change it in the Cockpit\n\nA workspace is your tenant in the engine: its own data, its own users, its own permissions. To make changes you need `settings:write` and `identity:write` there. Under Settings → Operations, in the Appearance area (section Workspace branding), you set:\n\n- the wordmark, meaning the displayed name, and an optional subtitle,\n- one logo each for the light and the dark theme,\n- one of three reviewed palette pairs.\n\nThe preview stays in your browser until you save. Reset restores the SubKit look. An accessible “powered by SubKit” attribution remains even with your own branding.\n\n### What happens to uploaded logos\n\nPNG, JPEG and WebP up to 2 MiB and 4 megapixels are accepted. SubKit decodes every image and stores it again as a still PNG of at most 512 pixels per edge; source metadata is dropped. SubKit refuses animation, SVG, external image addresses, scripts and custom CSS. The palette leaves the status colors unchanged, for example those that show errors or success.\n\nBranding lives in your workspace's PostgreSQL schema. In hosted operation it counts against the storage quota.\n\n### Through HTTP, CLI and MCP\n\nCockpit, HTTP API, `sk` and MCP follow the same rules: the same image checks, the same permissions, the same revisions. Every saved version has a revision. If someone else has saved in the meantime, your save fails with a conflict and the saved version stays. Reload and try again.\n\nAuthenticated callers read with `GET /v1/tenant/branding`, save with `PUT` and reset with `DELETE`. Writing needs both permissions, `settings:write` and `identity:write`. A scoped API key stays limited to its permissions; browser writes additionally check the CSRF token. Logo reads are bound to the workspace and revision. If only one logo is stored, the Cockpit uses it for both the light and the dark theme; HTTP, CLI and MCP return both logo addresses.\n\nThe CLI offers these commands:\n\n```bash\nsk branding get\nsk branding update <json-file|->\nsk branding reset <revision>\nsk branding logo <light|dark> --output <file>\n```\n\nMCP provides `get_tenant_branding`, `update_tenant_branding`, `reset_tenant_branding` and `get_tenant_branding_logo`. Changes through MCP need the usual approval by a signed-in person. SubKit checks both write permissions before it requests that approval. Ordinary reads return metadata; only `get_tenant_branding_logo` returns the normalized PNG bytes. The OpenAPI and MCP input schemas are generated from the same request definition."
        },
        "de": {
          "title": "Cockpit-Branding",
          "summary": "Gib dem Cockpit den Namen, das Logo und die Farben deiner Firma.",
          "headings": [
            {
              "depth": 2,
              "text": "Cockpit-Branding",
              "anchor": "cockpit-branding"
            },
            {
              "depth": 3,
              "text": "Im Cockpit ändern",
              "anchor": "im-cockpit-ändern"
            },
            {
              "depth": 3,
              "text": "Was mit hochgeladenen Logos passiert",
              "anchor": "was-mit-hochgeladenen-logos-passiert"
            },
            {
              "depth": 3,
              "text": "Über HTTP, CLI und MCP",
              "anchor": "über-http-cli-und-mcp"
            }
          ],
          "images": [],
          "sha256": "116890285bd5010b89c34b3e5eaeed876c4429e3a993c6a7196ec78f9a6c28b6",
          "body": "## Cockpit-Branding\n\nMit dem Branding zeigt das angemeldete Cockpit deinen Namen, dein Logo und eine passende Farbpalette statt des SubKit-Auftritts. Du brauchst es, wenn dein Team das Cockpit als eigenes Werkzeug erkennen soll. Danach sehen alle Angemeldeten deines Arbeitsbereichs denselben Auftritt; Anmeldung, E-Mails und andere Clients bleiben bei SubKit.\n\n### Im Cockpit ändern\n\nDein Arbeitsbereich ist in der Engine ein eigener Mandant: eigene Daten, eigene Nutzer, eigene Rechte. Zum Ändern brauchst du dort die Rechte `settings:write` und `identity:write`. In den Einstellungen unter „Betrieb“, Bereich „Erscheinungsbild“ (Abschnitt „Arbeitsbereich-Branding“), legst du fest:\n\n- das Wortzeichen, also den angezeigten Namen, und einen optionalen Untertitel,\n- je ein Logo für die helle und die dunkle Darstellung,\n- eines von drei geprüften Farbpaletten-Paaren.\n\nDie Vorschau bleibt in deinem Browser, bis du speicherst. Zurücksetzen stellt den SubKit-Auftritt wieder her. Ein barrierefreier Hinweis „powered by SubKit“ bleibt auch mit eigenem Branding erhalten.\n\n### Was mit hochgeladenen Logos passiert\n\nErlaubt sind PNG, JPEG und WebP bis 2 MiB und 4 Megapixel. SubKit dekodiert jedes Bild und speichert es neu als unbewegtes PNG mit höchstens 512 Pixeln je Kante; Metadaten der Quelle fallen dabei weg. Animationen, SVG, externe Bildadressen, Skripte und eigenes CSS lehnt SubKit ab. Die Palette lässt die Statusfarben unverändert, die etwa Fehler oder Erfolg anzeigen.\n\nDas Branding liegt im PostgreSQL-Schema deines Arbeitsbereichs. Im gehosteten Betrieb wird es auf das Speicherkontingent angerechnet.\n\n### Über HTTP, CLI und MCP\n\nCockpit, HTTP-API, `sk` und MCP folgen denselben Regeln: gleiche Bildprüfung, gleiche Berechtigungen, gleiche Revisionen. Jede gespeicherte Fassung hat eine Revision. Hat jemand anderes inzwischen gespeichert, schlägt dein Speichern mit einem Konflikt fehl und die gespeicherte Fassung bleibt erhalten. Lade dann neu und versuche es noch einmal.\n\nAngemeldete Aufrufer lesen mit `GET /v1/tenant/branding`, speichern mit `PUT` und setzen mit `DELETE` zurück. Schreiben braucht beide Rechte, `settings:write` und `identity:write`. Ein API-Schlüssel mit Scope bleibt auf seine Rechte begrenzt; Schreibzugriffe aus dem Browser prüfen zusätzlich das CSRF-Token. Logo-Abrufe sind an Arbeitsbereich und Revision gebunden. Ist nur ein Logo hinterlegt, nutzt das Cockpit es für das helle und das dunkle Design; HTTP, CLI und MCP liefern beide Logo-Adressen aus.\n\nDie CLI bietet diese Befehle:\n\n```bash\nsk branding get\nsk branding update <json-file|->\nsk branding reset <revision>\nsk branding logo <light|dark> --output <file>\n```\n\nÜber MCP stehen `get_tenant_branding`, `update_tenant_branding`, `reset_tenant_branding` und `get_tenant_branding_logo` bereit. Änderungen über MCP brauchen wie üblich die Freigabe einer angemeldeten Person. SubKit prüft beide Schreibrechte, bevor es die Freigabe anfordert. Normale Lesezugriffe liefern Metadaten; nur `get_tenant_branding_logo` liefert die normalisierten PNG-Bytes. Die OpenAPI- und MCP-Eingabeschemas werden aus derselben Anfragebeschreibung erzeugt."
        }
      }
    },
    {
      "slug": "installed-cockpit-sessions",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 2,
      "generated": false,
      "locales": {
        "en": {
          "title": "Installed Cockpit sessions",
          "summary": "Install the Cockpit as an app and receive neutral push notifications.",
          "headings": [
            {
              "depth": 2,
              "text": "Installed Cockpit sessions",
              "anchor": "installed-cockpit-sessions"
            },
            {
              "depth": 3,
              "text": "Create the installation",
              "anchor": "create-the-installation"
            },
            {
              "depth": 3,
              "text": "Session and sign-out",
              "anchor": "session-and-sign-out"
            },
            {
              "depth": 3,
              "text": "App name and icon",
              "anchor": "app-name-and-icon"
            },
            {
              "depth": 3,
              "text": "Sharing and files",
              "anchor": "sharing-and-files"
            },
            {
              "depth": 3,
              "text": "Push in the installed app",
              "anchor": "push-in-the-installed-app"
            },
            {
              "depth": 3,
              "text": "Push in the normal browser Cockpit",
              "anchor": "push-in-the-normal-browser-cockpit"
            }
          ],
          "images": [],
          "sha256": "02e98d2cea96d3c7f8e3259d953c748c11d8e5891d4de2e134fd8cefb0730a62",
          "body": "## Installed Cockpit sessions\n\nYou can install your workspace's Cockpit as a web app on a phone or computer. It pays off when your team should get notifications by push or share files and text from other apps to SubKit. Afterwards the app has its own address, its own session and its own icon, and it checks the same permissions as the normal Cockpit.\n\n### Create the installation\n\nFrom a signed-in browser session you create the installation with `POST /v1/cockpit/installations` and an empty JSON object. If one already exists, SubKit reuses it. The request needs the usual browser CSRF token. The response contains the installation address and its manifest address, and the installation gets its own browser session. Your session in the normal Cockpit (root Cockpit) stays active.\n\nThere is exactly one installation per active workspace and owner on the current host; another workspace gets its own.\n\n- `GET /v1/cockpit/installations` reads this owner's current installation without issuing a session.\n- `DELETE /v1/cockpit/installations/{id}` revokes the installation. The normal Cockpit offers this revocation.\n\n### Session and sign-out\n\nEach app runs under `/cockpit/i/{installationId}/` with its own cookie for exactly that path: HttpOnly, SameSite=Lax and, over HTTPS, also Secure. Under `/cockpit/i/{installationId}/api/v1/` the app reaches the same API as the normal Cockpit. The same handlers, permissions, CSRF checks, tenant-context checks and hosted quotas apply.\n\nThe server checks the session's owner, workspace, installation, expiry and revocation. An app session cannot switch workspace and never falls back to the normal Cockpit session. App event streams recheck the session before delivering each chunk.\n\nThis is how an app session ends:\n\n- Signing out revokes only the presented session of this app.\n- If you revoke the installation in the normal Cockpit, all its sessions become invalid. If you create it again, it gets a new identity; old links do not become valid again.\n- Signing in again through OIDC (OpenID Connect, sign-in through an external identity provider) must return exactly the existing owner identity. It never creates an account and never links one by email address.\n- An API key cannot renew an app session. Open the normal Cockpit instead and reopen the workspace app from there.\n\n### App name and icon\n\nThe app manifest is only available when signed in and has its own ID, scope and start address. It uses the workspace's saved name, the palette and an optional square app icon. The uploaded icon must be square and at least 512 pixels per edge; the branding byte and pixel limits apply. SubKit generates 192 and 512 pixel PNGs from it.\n\nName, icon and manifest responses are private and never stored in an HTTP cache. Signed-out entry pages stay neutral. The browser or operating system may still keep an installed app's name and icon after sign-out.\n\n### Sharing and files\n\nThe app's service worker is a background script with its own scope. It accepts a bounded amount of content that you send through “Share” from other apps, and it shows neutral push messages. It does not cache pages, API responses or private drafts, and it does not queue writes for later.\n\nShared files and text stay in volatile memory until you explicitly confirm the import. Even then nothing happens on its own: uploading or collecting does not admit the source to knowledge, create a skill, call a model or start a workflow. Sources keep their original references. Local files and clipboard text are stored as a source artifact.\n\nIf the sign-in or the worker's volatile receipt is lost, share the content again after signing in or pick the file once more. The app checks file launch, clipboard and native file dialogs at runtime and uses them only after an explicit action by you. It never persists access to files or folders.\n\n### Push in the installed app\n\nYou turn on push separately for each app and device. On the explicit preparation step, SubKit creates an encrypted VAPID key pair for your tenant, which the server uses to sign web push messages. Subscriptions are stored encrypted and bound to the installation and its owner.\n\nA message arrives within about a minute when an item that needs attention is new or changes. Unchanged items do not notify again. The message contains only a generic SubKit hint and opens or focuses the app's start page. It never contains branding, private content or approval actions.\n\nWhen push ends:\n\n- If an idle session expires, push stays on. When you reopen the app, the existing subscription is bound to the new session.\n- Push ends on sign-out, on any explicit session revocation and when the installation is revoked.\n- Push also ends when the owner is deactivated, the workspace is switched or deleted, and after 30 days without app use.\n- Inactive or deleted owners and workspaces receive no new messages.\n\nThere are three limits to know. Neutral messages already sent may still arrive after sign-out. The browser's notification permission may apply to all apps on the same origin (scheme, host and port of the address) and is not revoked automatically on sign-out. Path-bound sessions do not create their own origin, so browser storage and local permissions are not separated.\n\n### Push in the normal browser Cockpit\n\nThe normal Cockpit at `/cockpit/` can also receive these neutral notifications without an installation. The bell opens the same opt-in. When you turn push on, the browser asks for its permission. SubKit then registers the push-only worker at `/cockpit/sw.js` and binds the subscription to you and your workspace.\n\nThe same push routes accept a normal Cockpit session with a CSRF token. SubKit refuses API keys and bearer tokens, meaning credentials sent in the `Authorization` header. Installation paths never fall back to this session.\n\nIf an idle session expires, the subscription remains. After your next sign-in it applies to the new session without asking again. It ends:\n\n- on sign-out, on an explicit session revocation or when you turn push off,\n- when the workspace is switched or its lifecycle changes,\n- when the user is deactivated or deleted,\n- when the push endpoint expires or after 30 days without use.\n\nAnother user or workspace in the same browser must opt in again. Each device receives at most one message per change. If the installed app is enabled on the device, the message goes to the app and not to the browser tab. Browsers without push in a tab, such as Safari on iOS, offer installation as an app instead."
        },
        "de": {
          "title": "Sitzungen installierter Cockpits",
          "summary": "Installiere das Cockpit als App und erhalte neutrale Hinweise per Push.",
          "headings": [
            {
              "depth": 2,
              "text": "Sitzungen installierter Cockpits",
              "anchor": "sitzungen-installierter-cockpits"
            },
            {
              "depth": 3,
              "text": "Installation anlegen",
              "anchor": "installation-anlegen"
            },
            {
              "depth": 3,
              "text": "Sitzung und Abmeldung",
              "anchor": "sitzung-und-abmeldung"
            },
            {
              "depth": 3,
              "text": "App-Name und Symbol",
              "anchor": "app-name-und-symbol"
            },
            {
              "depth": 3,
              "text": "Teilen und Dateien",
              "anchor": "teilen-und-dateien"
            },
            {
              "depth": 3,
              "text": "Push in der installierten App",
              "anchor": "push-in-der-installierten-app"
            },
            {
              "depth": 3,
              "text": "Push im normalen Browser-Cockpit",
              "anchor": "push-im-normalen-browser-cockpit"
            }
          ],
          "images": [],
          "sha256": "e117e01ce52b7362dc7a2447524619d4dcb7272967f896cc16f9df85d5299109",
          "body": "## Sitzungen installierter Cockpits\n\nDu kannst das Cockpit deines Arbeitsbereichs als Web-App auf Handy oder Rechner installieren. Das lohnt sich, wenn dein Team Hinweise per Push bekommen oder Dateien und Texte aus anderen Apps an SubKit teilen soll. Danach hat die App eine eigene Adresse, eine eigene Sitzung und ein eigenes Symbol, und sie prüft dieselben Rechte wie das normale Cockpit.\n\n### Installation anlegen\n\nAus einer angemeldeten Browsersitzung legst du die Installation mit `POST /v1/cockpit/installations` und einem leeren JSON-Objekt an. Gibt es schon eine, verwendet SubKit sie wieder. Die Anfrage braucht das übliche CSRF-Token des Browsers. Die Antwort enthält die Adresse der Installation und ihres Manifests, und die Installation bekommt eine eigene Browsersitzung. Deine Sitzung im normalen Cockpit (Root-Cockpit) bleibt aktiv.\n\nJe aktivem Arbeitsbereich und Eigentümer gibt es auf dem aktuellen Host genau eine Installation; ein anderer Arbeitsbereich bekommt eine eigene.\n\n- `GET /v1/cockpit/installations` liest die aktuelle Installation dieses Eigentümers, ohne eine Sitzung auszustellen.\n- `DELETE /v1/cockpit/installations/{id}` widerruft die Installation. Das normale Cockpit bietet diesen Widerruf an.\n\n### Sitzung und Abmeldung\n\nJede App läuft unter `/cockpit/i/{installationId}/` mit einem eigenen Cookie genau für diesen Pfad: HttpOnly, SameSite=Lax und bei HTTPS zusätzlich Secure. Unter `/cockpit/i/{installationId}/api/v1/` erreicht die App dieselbe API wie das normale Cockpit. Es gelten dieselben Handler, Berechtigungen, CSRF-Prüfungen, Prüfungen des Mandantenkontexts (Mandant, im Cockpit: Arbeitsbereich) und gehosteten Kontingente.\n\nDer Server prüft Eigentümer, Arbeitsbereich, Installation, Ablauf und Widerruf der Sitzung. Eine App-Sitzung kann den Arbeitsbereich nicht wechseln und fällt nie auf die Sitzung des normalen Cockpits zurück. Ereignisströme der App prüfen die Sitzung vor jedem ausgelieferten Abschnitt neu.\n\nSo endet eine App-Sitzung:\n\n- Abmelden widerruft nur die vorgelegte Sitzung dieser App.\n- Widerrufst du die Installation im normalen Cockpit, werden alle ihre Sitzungen ungültig. Legst du sie neu an, bekommt sie eine neue Identität; alte Links werden nicht wieder gültig.\n- Eine erneute Anmeldung über OIDC (OpenID Connect, die Anmeldung über einen externen Identitätsanbieter) muss genau die bisherige Eigentümer-Identität liefern. Sie legt nie ein Konto an und verknüpft nie eines über die E-Mail-Adresse.\n- Mit einem API-Schlüssel lässt sich eine App-Sitzung nicht erneuern. Öffne dann das normale Cockpit und von dort die Arbeitsbereich-App neu.\n\n### App-Name und Symbol\n\nDas Manifest der App ist nur angemeldet abrufbar und hat eine eigene ID, einen eigenen Scope und eine eigene Startadresse. Es nutzt den gespeicherten Namen des Arbeitsbereichs, die Palette und ein optionales quadratisches App-Symbol. Das hochgeladene Symbol muss quadratisch sein und mindestens 512 Pixel je Kante haben; es gelten die Byte- und Pixelgrenzen des Brandings. SubKit erzeugt daraus PNGs mit 192 und 512 Pixeln.\n\nAntworten zu Name, Symbol und Manifest sind privat und landen in keinem HTTP-Cache. Einstiegsseiten ohne Anmeldung bleiben neutral. Browser oder Betriebssystem können Name und Symbol einer installierten App nach dem Abmelden trotzdem behalten.\n\n### Teilen und Dateien\n\nDer Service Worker der App ist ein Hintergrundskript mit eigenem Scope. Er nimmt in begrenztem Umfang Inhalte an, die du über „Teilen“ aus anderen Apps schickst, und zeigt neutrale Push-Nachrichten. Seiten, API-Antworten und private Entwürfe legt er nicht im Cache ab, und er sammelt keine Schreibvorgänge für später.\n\nGeteilte Dateien und Texte bleiben im flüchtigen Speicher, bis du den Import ausdrücklich bestätigst. Auch danach passiert nichts von selbst: Hochladen oder Sammeln nimmt die Quelle nicht ins Wissen auf, erstellt keinen Skill, ruft kein Modell auf und startet keinen Workflow. Quellen behalten ihre ursprünglichen Verweise. Lokale Dateien und Text aus der Zwischenablage werden als Quellartefakt gespeichert.\n\nGehen die Anmeldung oder der flüchtige Empfang des Workers verloren, teile den Inhalt nach dem Anmelden erneut oder wähle die Datei noch einmal. Dateistart, Zwischenablage und native Dateidialoge prüft die App zur Laufzeit und nutzt sie nur nach einer ausdrücklichen Aktion von dir. Einen Zugriff auf Dateien oder Ordner speichert sie nie dauerhaft.\n\n### Push in der installierten App\n\nPush schaltest du je App und Gerät gesondert ein. Beim ausdrücklichen Vorbereiten erzeugt SubKit für deinen Arbeitsbereich ein verschlüsseltes VAPID-Schlüsselpaar, mit dem der Server Web-Push-Nachrichten signiert. Abonnements werden verschlüsselt gespeichert und sind an die Installation und ihren Eigentümer gebunden.\n\nEine Nachricht kommt innerhalb von etwa einer Minute, wenn ein Punkt, der Aufmerksamkeit braucht, neu ist oder sich ändert. Unveränderte Punkte melden sich nicht erneut. Die Nachricht enthält nur einen allgemeinen SubKit-Hinweis und öffnet oder fokussiert die Startseite der App. Branding, private Inhalte oder Freigabe-Aktionen stehen nie darin.\n\nWann Push endet:\n\n- Läuft eine untätige Sitzung ab, bleibt Push aktiv. Öffnest du die App wieder, wird das bestehende Abonnement an die neue Sitzung gebunden.\n- Push endet beim Abmelden, bei jedem ausdrücklichen Sitzungswiderruf und beim Widerruf der Installation.\n- Push endet auch, wenn der Eigentümer deaktiviert wird, der Arbeitsbereich wechselt oder gelöscht wird, und nach 30 Tagen ohne App-Nutzung.\n- Inaktive oder gelöschte Eigentümer und Arbeitsbereiche bekommen keine neuen Nachrichten.\n\nDrei Grenzen solltest du kennen. Bereits versendete neutrale Nachrichten können nach dem Abmelden noch ankommen. Die Benachrichtigungs-Erlaubnis des Browsers kann für alle Apps auf demselben Origin gelten (Schema, Host und Port der Adresse) und wird beim Abmelden nicht automatisch entzogen. Pfadgebundene Sitzungen erzeugen keinen eigenen Origin; Browserspeicher und lokale Berechtigungen sind also nicht getrennt.\n\n### Push im normalen Browser-Cockpit\n\nAuch das normale Cockpit unter `/cockpit/` kann diese neutralen Hinweise ohne Installation empfangen. Die Glocke öffnet dieselbe Zustimmung. Schaltest du Push ein, fragt der Browser nach seiner Erlaubnis. SubKit registriert dann den reinen Push-Worker unter `/cockpit/sw.js` und bindet das Abonnement an dich und deinen Arbeitsbereich.\n\nDieselben Push-Routen akzeptieren eine Sitzung des normalen Cockpits mit CSRF-Token. API-Schlüssel und Bearer-Tokens, also Zugangsnachweise im Header `Authorization`, weist SubKit ab. Installationspfade fallen nie auf diese Sitzung zurück.\n\nLäuft eine untätige Sitzung ab, bleibt das Abonnement bestehen. Nach der nächsten Anmeldung gilt es ohne neue Nachfrage für die neue Sitzung. Es endet:\n\n- beim Abmelden, bei einem ausdrücklichen Sitzungswiderruf oder wenn du Push ausschaltest,\n- beim Wechsel des Arbeitsbereichs oder wenn sich sein Lebenszyklus ändert,\n- wenn der Benutzer deaktiviert oder gelöscht wird,\n- wenn der Push-Endpunkt abläuft oder nach 30 Tagen ohne Nutzung.\n\nEin anderer Benutzer oder Arbeitsbereich im selben Browser muss neu zustimmen. Jedes Gerät bekommt je Änderung höchstens eine Nachricht. Ist auf dem Gerät die installierte App aktiviert, geht die Nachricht an die App und nicht an den Browser-Tab. Browser ohne Push im Tab, etwa Safari auf iOS, bieten stattdessen die Installation als App an."
        }
      }
    },
    {
      "slug": "engine-operator",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 3,
      "generated": false,
      "locales": {
        "en": {
          "title": "Engine operator",
          "summary": "Decide which workspace administers the whole engine.",
          "headings": [
            {
              "depth": 2,
              "text": "Engine operator",
              "anchor": "engine-operator"
            },
            {
              "depth": 3,
              "text": "What only the operator may do",
              "anchor": "what-only-the-operator-may-do"
            },
            {
              "depth": 3,
              "text": "Your workspace's settings",
              "anchor": "your-workspaces-settings"
            },
            {
              "depth": 3,
              "text": "Scopes for API keys and invites",
              "anchor": "scopes-for-api-keys-and-invites"
            }
          ],
          "images": [],
          "sha256": "7e5fa923e53fc9f9efeb359aaa1c402618033ee77bbd96ce9fc370368a4f70e3",
          "body": "## Engine operator\n\nAn engine can hold several workspaces; one of them is the engine operator and administers the engine as a whole. You need this chapter when you change settings, maintain secrets or issue API keys. Afterwards you know which change applies to everyone and which only to your workspace.\n\n### What only the operator may do\n\nTechnically, every workspace is its own tenant with separate data, users and permissions. The operator is the workspace that completed first-run setup (on a local development seed, `default`). Only its admins can read or change the whole engine:\n\n- engine-wide settings and their revisions,\n- runtime secrets and prepared secret approvals,\n- engine restarts,\n- engine diagnostics and logs, and `/metrics`,\n- disabling an MCP OAuth client for every workspace.\n\nIn `GET /v1/rbac/permissions` these permissions carry `operator: true`: `settings:read:global`, `settings:write:global`, `system:restart`, `metrics:read` and `mcp_oauth_client:disable`. Outside the operator workspace, no role, grant or key scope can unlock them. Such a request answers `403` with `details.cause: \"operator_only\"`. `GET /v1/identity/whoami` reports `engine_operator` for this.\n\nThe operator workspace is chosen once. You can move it only on the host:\n\n```bash\nengine --set-operator-tenant <slug>\n```\n\n### Your workspace's settings\n\nEvery other workspace keeps its own settings. `GET /v1/settings` returns your tenant's view: only settings that support a per-tenant overlay, each with its effective value. A change applies to your workspace only when you name it explicitly:\n\n```bash\nsk settings set llm.model '\"<model>\"' --tenant <your-tenant-id>\n```\n\nIn the Cockpit, workspaces outside the operator currently see settings read-only. Use the CLI command above to make changes.\n\nWithout `--tenant` the engine refuses the change instead of applying it to everyone. While the operator has saved engine-wide settings that are not active yet, a workspace change answers `409 operator_change_pending` and is not saved. If you revoke an MCP OAuth client outside the operator, it loses access in your workspace only.\n\n### Scopes for API keys and invites\n\nA scope limits what an API key or invite may do. Allowed are scopes from the permission catalog, `*`, or the MCP modes `mcp:read`, `mcp:authoring` and `mcp:admin`. These rules apply:\n\n- The issuing credential must hold every scope itself.\n- Only a credential without scope limits can issue `*`.\n- A key without scopes inherits the limits of whoever issues it.\n- Rotating a key applies the same check to the scopes it already carries.\n\nUnknown scopes answer `422 unknown_scope`, scopes beyond the issuer's permissions answer `403 scope_exceeds_issuer`."
        },
        "de": {
          "title": "Engine-Betreiber",
          "summary": "Lege fest, welcher Arbeitsbereich die ganze Engine verwaltet.",
          "headings": [
            {
              "depth": 2,
              "text": "Engine-Betreiber",
              "anchor": "engine-betreiber"
            },
            {
              "depth": 3,
              "text": "Was nur der Betreiber darf",
              "anchor": "was-nur-der-betreiber-darf"
            },
            {
              "depth": 3,
              "text": "Einstellungen deines Arbeitsbereichs",
              "anchor": "einstellungen-deines-arbeitsbereichs"
            },
            {
              "depth": 3,
              "text": "Scopes für API-Schlüssel und Einladungen",
              "anchor": "scopes-für-api-schlüssel-und-einladungen"
            }
          ],
          "images": [],
          "sha256": "44185eb583799c554c5907683145025581761f13f312d83bc6879faadd379b23",
          "body": "## Engine-Betreiber\n\nEine Engine kann mehrere Arbeitsbereiche tragen; einer davon ist der Engine-Betreiber und verwaltet die Engine als Ganzes. Dieses Kapitel brauchst du, wenn du Einstellungen änderst, Secrets pflegst oder API-Schlüssel ausstellst. Danach weißt du, welche Änderung für alle gilt und welche nur für deinen Arbeitsbereich.\n\n### Was nur der Betreiber darf\n\nJeder Arbeitsbereich ist technisch ein eigener Mandant (Tenant) mit getrennten Daten, Nutzern und Rechten. Betreiber ist der Arbeitsbereich, der die Ersteinrichtung abgeschlossen hat (bei einem lokalen Entwicklungs-Seed `default`). Nur seine Admins können die ganze Engine lesen oder ändern:\n\n- engineweite Einstellungen und ihre Revisionen,\n- Laufzeit-Secrets und vorbereitete Secret-Freigaben,\n- Neustarts der Engine,\n- Diagnosen und Logs der Engine sowie `/metrics`,\n- das Abschalten eines MCP-OAuth-Clients für alle Arbeitsbereiche.\n\nIn `GET /v1/rbac/permissions` tragen diese Rechte `operator: true`: `settings:read:global`, `settings:write:global`, `system:restart`, `metrics:read` und `mcp_oauth_client:disable`. Außerhalb des Betreiber-Arbeitsbereichs schaltet sie keine Rolle, keine Rechtezuweisung und kein Key-Scope frei. Eine solche Anfrage endet mit `403` und `details.cause: \"operator_only\"`. `GET /v1/identity/whoami` meldet dazu `engine_operator`.\n\nDer Betreiber-Arbeitsbereich wird einmal gewählt. Verschieben kannst du ihn nur auf dem Host:\n\n```bash\nengine --set-operator-tenant <slug>\n```\n\n### Einstellungen deines Arbeitsbereichs\n\nJeder andere Arbeitsbereich behält seine eigenen Einstellungen. `GET /v1/settings` liefert die Sicht deines Mandanten: nur Einstellungen, die eine Überlagerung je Mandant unterstützen, jeweils mit ihrem wirksamen Wert. Eine Änderung gilt nur für deinen Arbeitsbereich, wenn du ihn ausdrücklich nennst:\n\n```bash\nsk settings set llm.model '\"<model>\"' --tenant <your-tenant-id>\n```\n\nIm Cockpit sehen Arbeitsbereiche außerhalb des Betreibers die Einstellungen derzeit nur lesend. Zum Ändern nimmst du den CLI-Befehl oben.\n\nOhne `--tenant` lehnt die Engine die Änderung ab, statt sie für alle anzuwenden. Hat der Betreiber engineweite Einstellungen gespeichert, die noch nicht aktiv sind, antwortet eine Änderung im Arbeitsbereich mit `409 operator_change_pending` und wird nicht gespeichert. Widerrufst du außerhalb des Betreibers einen MCP-OAuth-Client, verliert er den Zugriff nur in deinem Arbeitsbereich.\n\n### Scopes für API-Schlüssel und Einladungen\n\nEin Scope begrenzt, was ein API-Schlüssel oder eine Einladung darf. Erlaubt sind Scopes aus dem Berechtigungskatalog, `*` oder die MCP-Modi `mcp:read`, `mcp:authoring` und `mcp:admin`. Dabei gilt:\n\n- Jeden Scope muss die ausstellende Anmeldung selbst haben.\n- Nur eine Anmeldung ohne Scope-Grenzen kann `*` ausstellen.\n- Ein Schlüssel ohne Scopes erbt die Grenzen der Person oder des Schlüssels, der ihn ausstellt.\n- Beim Rotieren gilt dieselbe Prüfung für die Scopes, die der Schlüssel schon trägt.\n\nUnbekannte Scopes antworten mit `422 unknown_scope`, Scopes über den Rechten des Ausstellers mit `403 scope_exceeds_issuer`."
        }
      }
    },
    {
      "slug": "execution-identity-and-permission",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 4,
      "generated": false,
      "locales": {
        "en": {
          "title": "Execution identity and permission",
          "summary": "See who triggered a run and what it may do.",
          "headings": [
            {
              "depth": 2,
              "text": "Execution identity and permission",
              "anchor": "execution-identity-and-permission"
            },
            {
              "depth": 3,
              "text": "The four concepts",
              "anchor": "the-four-concepts"
            },
            {
              "depth": 3,
              "text": "Who the caller is",
              "anchor": "who-the-caller-is"
            },
            {
              "depth": 3,
              "text": "Trace a run",
              "anchor": "trace-a-run"
            },
            {
              "depth": 3,
              "text": "In chat: draft, run and cost",
              "anchor": "in-chat-draft-run-and-cost"
            }
          ],
          "images": [],
          "sha256": "599c47376c2a11dd094f2257f6e956516363a1f62f5a2e0503f082ade63a2fd8",
          "body": "## Execution identity and permission\n\nEvery run involves four separate things: who triggered it, how it signs in, what it may do and what a person approved. You need this chapter when a workflow should run only for particular signed-in people or apps, or when you want to attribute a run afterwards. Afterwards you know where to find a run's identity and which details cannot establish it.\n\n### The four concepts\n\n- `$caller` answers who authenticated this run.\n- Connector credentials authenticate an outbound request to another service.\n- RBAC, role-based access control, decides which workflows and resources that principal may use. A principal is the authenticated identity, meaning a person, an app or a key.\n- A person's approval permits a reviewed reach of effect for an environment.\n\nThe four are independent. A credential or an approval does not create caller identity and does not replace authorization. The approver need not be the run's caller.\n\n### Who the caller is\n\nHTTP and MCP runs take the caller from their authenticated principal. Trusted callerless webhook and scheduled runs receive `null`. Whoever configured or approved them does not automatically become their caller. Child workflows keep the parent's caller.\n\nIf a workflow should run only for a particular authenticated identity, set `required_caller_kind` and `product_id`. Never infer that identity from input fields or `request_source`.\n\n### Trace a run\n\nThrough HTTP and MCP every run shows source, status, workflow version, execution authority, step evidence and a safe summary under `caller`. It names the stored principal, product, authentication method, channel and origin run, but no credentials and no session identifiers. If the stored identity is missing, it shows `kind: unknown`; a channel alone does not identify a caller.\n\nHTTP audit queries and MCP `list_audit` filter by actor and trace. These records correlate only partially and do not form a complete caller timeline. The exact rules and their limits are in the built-in Core Concepts, Auth Flows and REST API guidance.\n\n### In chat: draft, run and cost\n\nIf a saved draft changes while you work on it in chat, chat keeps your local edits. Saving, activating and running are separate steps with their own outcome. After you apply a draft in DEV, a single run with the recorded test inputs starts only when you tick **Start a run afterwards**. If you ask not to run live, this run does not happen. In PROD a live run needs an explicit request.\n\nThe recorded run shows what actually happened. The chat's model cost is an estimate from the provider's reported usage and the configured prices, not an invoice. The token count includes context that is sent repeatedly across model calls. Short release notes are under **Changes** in the lower-left account menu; unpublished changes are listed separately there."
        },
        "de": {
          "title": "Ausführungsidentität und Berechtigung",
          "summary": "Erkenne, wer einen Lauf ausgelöst hat und was er darf.",
          "headings": [
            {
              "depth": 2,
              "text": "Ausführungsidentität und Berechtigung",
              "anchor": "ausführungsidentität-und-berechtigung"
            },
            {
              "depth": 3,
              "text": "Die vier Begriffe",
              "anchor": "die-vier-begriffe"
            },
            {
              "depth": 3,
              "text": "Wer der Aufrufer ist",
              "anchor": "wer-der-aufrufer-ist"
            },
            {
              "depth": 3,
              "text": "Einen Lauf nachvollziehen",
              "anchor": "einen-lauf-nachvollziehen"
            },
            {
              "depth": 3,
              "text": "Im Chat: Entwurf, Lauf und Kosten",
              "anchor": "im-chat-entwurf-lauf-und-kosten"
            }
          ],
          "images": [],
          "sha256": "ec30a01b8fcd177972dc3a714cf1ee4ceb14ea97a6d7bf9436e4850e4ad27b86",
          "body": "## Ausführungsidentität und Berechtigung\n\nBei jedem Lauf zählen vier getrennte Dinge: wer ihn ausgelöst hat, womit er sich anmeldet, was er darf und was eine Person freigegeben hat. Dieses Kapitel brauchst du, wenn ein Workflow nur für bestimmte angemeldete Personen oder Apps laufen soll oder du einen Lauf im Nachhinein zuordnen willst. Danach weißt du, wo du die Identität eines Laufs findest und welche Angaben dafür nicht taugen.\n\n### Die vier Begriffe\n\n- `$caller` beantwortet, wer diesen Lauf authentifiziert hat.\n- Konnektor-Zugangsdaten melden eine ausgehende Anfrage bei einem anderen Dienst an.\n- RBAC, die rollenbasierte Rechteprüfung, entscheidet, welche Workflows und Ressourcen dieser Principal nutzen darf. Ein Principal ist die angemeldete Identität, also eine Person, eine App oder ein Schlüssel.\n- Die Freigabe einer Person erlaubt für eine Umgebung eine geprüfte Reichweite der Wirkung.\n\nDie vier hängen nicht voneinander ab. Zugangsdaten oder eine Freigabe erzeugen keine Aufruferidentität und ersetzen keine Rechteprüfung. Wer freigibt, muss nicht der Aufrufer des Laufs sein.\n\n### Wer der Aufrufer ist\n\nHTTP- und MCP-Läufe übernehmen den Aufrufer aus ihrem angemeldeten Principal. Vertrauenswürdige Webhook- und Zeitplan-Läufe ohne Aufrufer bekommen `null`. Wer sie eingerichtet oder freigegeben hat, wird dadurch nicht automatisch ihr Aufrufer. Untergeordnete Workflows behalten den Aufrufer des übergeordneten.\n\nSoll ein Workflow nur für eine bestimmte angemeldete Identität laufen, setze `required_caller_kind` und `product_id`. Leite diese Identität nie aus Eingabefeldern oder `request_source` ab.\n\n### Einen Lauf nachvollziehen\n\nÜber HTTP und MCP zeigt jeder Lauf Quelle, Status, Workflow-Version, Freigabe, Schrittnachweise und eine sichere Zusammenfassung unter `caller`. Sie nennt gespeicherten Principal, Produkt, Anmeldeart, Kanal und Ursprungslauf, aber keine Zugangsdaten und keine Sitzungskennungen. Fehlt die gespeicherte Identität, steht dort `kind: unknown`; ein Kanal allein identifiziert keinen Aufrufer.\n\nAudit-Abfragen über HTTP und `list_audit` über MCP filtern nach Akteur und Trace. Diese Einträge lassen sich nur teilweise zuordnen und ergeben keine vollständige Zeitleiste eines Aufrufers. Die genauen Regeln und ihre Grenzen stehen in den eingebauten Hinweisen zu Kernkonzepten, Auth-Abläufen und REST-API.\n\n### Im Chat: Entwurf, Lauf und Kosten\n\nÄndert sich ein gespeicherter Entwurf, während du im Chat daran arbeitest, behält der Chat deine lokalen Änderungen. Speichern, Aktivieren und Ausführen sind getrennte Schritte mit eigenem Ergebnis. Übernimmst du einen Entwurf in DEV, startet ein einzelner Lauf mit den aufgezeichneten Testeingaben nur, wenn du **Danach einen Lauf starten** anhakst. Bittest du darum, nicht live auszuführen, unterbleibt dieser Lauf. In PROD braucht ein Live-Lauf eine ausdrückliche Anforderung.\n\nWas tatsächlich geschehen ist, zeigt der aufgezeichnete Lauf. Die Modellkosten im Chat sind eine Schätzung aus der gemeldeten Nutzung beim Anbieter und den hinterlegten Preisen, keine Rechnung. Die Token-Zahl enthält Kontext, der über mehrere Modellaufrufe wiederholt gesendet wird. Kurze Versionshinweise findest du unter **Änderungen** im Kontomenü unten links; noch nicht veröffentlichte Änderungen stehen dort getrennt."
        }
      }
    },
    {
      "slug": "product-identity-binding",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 5,
      "generated": false,
      "locales": {
        "en": {
          "title": "Product identity binding",
          "summary": "Link your app's users to a SubKit account with minimal rights.",
          "headings": [
            {
              "depth": 2,
              "text": "Product identity binding",
              "anchor": "product-identity-binding"
            },
            {
              "depth": 3,
              "text": "Prepare the account",
              "anchor": "prepare-the-account"
            },
            {
              "depth": 3,
              "text": "Bind the subject",
              "anchor": "bind-the-subject"
            },
            {
              "depth": 3,
              "text": "What applies at sign-in",
              "anchor": "what-applies-at-sign-in"
            }
          ],
          "images": [],
          "sha256": "a631d68a55e64e512c508e35c2ecdb027db74d76314e35def7d12b9d075e0c6c",
          "body": "## Product identity binding\n\nWith an identity binding, a user of your app who signs in through your own sign-in service lands on exactly one prepared account in SubKit. You need it when an app or customer portal should start selected workflows without its users getting full SubKit accounts. Afterwards every sign-in is bound to an account with minimal rights, and no new accounts appear on their own.\n\nThree terms first. A product is your own app or service, which you mark in SubKit with `product_id`. OIDC (OpenID Connect) is a standard through which an external sign-in service, the issuer, confirms who signed in. The subject is the stable user identifier that this issuer provides.\n\n### Prepare the account\n\nFor an OIDC provider configured with `product_id`, you as operator prepare the account first:\n\n1. Create an active user in the tenant.\n2. Give it a custom role with minimal rights.\n3. Grant it only the intended saved workflows.\n\nDo not use a built-in member role for this. It allows running considerably more workflows.\n\n### Bind the subject\n\nBind the issuer's verified subject to this user:\n\n```http\nPOST /v1/identity/users/{id}/provider-identities\n\n{\"provider_id\":\"<provider-id>\",\"subject\":\"<verified-subject>\"}\n```\n\nThis requires administrator policy and `identity:write`. Tenant, issuer and product come from the provider configuration. An exactly repeated request changes nothing. If it conflicts with an existing binding on owner, subject, issuer or product, SubKit refuses it. The endpoint changes neither roles nor grants.\n\n### What applies at sign-in\n\nProduct providers require this binding. They create no accounts and link none by email address, even when signup is enabled globally. For older product bindings, an operator must pin the same owner and subject before sign-in.\n\nProviders without a product binding link by email address by default; `link_by_email: false` turns that off. Older bindings without a product pin the configured issuer at their first verified sign-in. That cannot establish which issuer applied earlier.\n\nPins are checked for new sign-ins. If you change the provider configuration, existing browser sessions stay valid. Revoke them separately or let their configured lifetime expire."
        },
        "de": {
          "title": "Produkt-Identitätsbindung",
          "summary": "Verknüpfe Nutzer deiner App mit einem SubKit-Konto, das nur wenig darf.",
          "headings": [
            {
              "depth": 2,
              "text": "Produkt-Identitätsbindung",
              "anchor": "produkt-identitätsbindung"
            },
            {
              "depth": 3,
              "text": "Konto vorbereiten",
              "anchor": "konto-vorbereiten"
            },
            {
              "depth": 3,
              "text": "Subject binden",
              "anchor": "subject-binden"
            },
            {
              "depth": 3,
              "text": "Was bei der Anmeldung gilt",
              "anchor": "was-bei-der-anmeldung-gilt"
            }
          ],
          "images": [],
          "sha256": "5979ee102b1ca201b056209ba3407ddf65efb3ee6b4f472252cd8560ab81ef0e",
          "body": "## Produkt-Identitätsbindung\n\nMit einer Identitätsbindung landet ein Nutzer deiner App, der sich über deinen eigenen Anmeldedienst anmeldet, in SubKit bei genau einem vorbereiteten Konto. Du brauchst das, wenn eine App oder ein Kundenportal ausgewählte Workflows starten soll, ohne dass ihre Nutzer volle SubKit-Konten bekommen. Danach ist jede Anmeldung an ein Konto mit minimalen Rechten gebunden, und neue Konten entstehen nicht von selbst.\n\nDrei Begriffe vorab. Ein Produkt ist eine eigene App oder ein Dienst, den du in SubKit mit `product_id` kennzeichnest. OIDC (OpenID Connect) ist ein Standard, mit dem ein externer Anmeldedienst, der Aussteller, bestätigt, wer sich angemeldet hat. Das Subject ist die feste Nutzerkennung, die dieser Aussteller liefert.\n\n### Konto vorbereiten\n\nFür einen OIDC-Anbieter mit `product_id` bereitest du als Betreiber zuerst das Konto vor:\n\n1. Lege im Mandanten (im Cockpit: Arbeitsbereich) einen aktiven Benutzer an.\n2. Gib ihm eine eigene Rolle mit minimalen Rechten.\n3. Erlaube ihm nur die vorgesehenen gespeicherten Workflows.\n\nNimm dafür keine eingebaute Mitgliedsrolle. Sie erlaubt die Ausführung von deutlich mehr Workflows.\n\n### Subject binden\n\nBinde das geprüfte Subject des Ausstellers an diesen Benutzer:\n\n```http\nPOST /v1/identity/users/{id}/provider-identities\n\n{\"provider_id\":\"<provider-id>\",\"subject\":\"<verified-subject>\"}\n```\n\nDafür brauchst du die Administrator-Policy und `identity:write`. Mandant, Aussteller und Produkt kommen aus der Konfiguration des Anbieters. Eine exakt wiederholte Anfrage ändert nichts. Widerspricht sie einer bestehenden Bindung bei Eigentümer, Subject, Aussteller oder Produkt, lehnt SubKit sie ab. Rollen und Rechtezuweisungen ändert der Endpunkt nicht.\n\n### Was bei der Anmeldung gilt\n\nProdukt-Anbieter verlangen diese Bindung. Sie legen keine Konten an und verknüpfen keine über die E-Mail-Adresse, auch wenn die Registrierung global eingeschaltet ist. Bei älteren Produktbindungen muss ein Betreiber vor der Anmeldung denselben Eigentümer und dasselbe Subject festschreiben.\n\nAnbieter ohne Produktbindung verknüpfen standardmäßig über die E-Mail-Adresse; `link_by_email: false` schaltet das ab. Ältere Bindungen ohne Produkt schreiben bei ihrer ersten geprüften Anmeldung den konfigurierten Aussteller fest. Welcher Aussteller früher galt, lässt sich damit nicht belegen.\n\nFestschreibungen werden bei neuen Anmeldungen geprüft. Änderst du die Konfiguration des Anbieters, bleiben bestehende Browsersitzungen gültig. Widerrufe sie gesondert oder lass ihre konfigurierte Lebensdauer ablaufen."
        }
      }
    },
    {
      "slug": "product-bearer-tokens-and-caller-budgets",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 6,
      "generated": false,
      "locales": {
        "en": {
          "title": "Product bearer tokens and caller budgets",
          "summary": "Let your app call SubKit with its own sign-in, limited per user.",
          "headings": [
            {
              "depth": 2,
              "text": "Product bearer tokens and caller budgets",
              "anchor": "product-bearer-tokens-and-caller-budgets"
            },
            {
              "depth": 3,
              "text": "Configure provider and product",
              "anchor": "configure-provider-and-product"
            },
            {
              "depth": 3,
              "text": "How SubKit verifies the token",
              "anchor": "how-subkit-verifies-the-token"
            },
            {
              "depth": 3,
              "text": "What a product caller may do",
              "anchor": "what-a-product-caller-may-do"
            },
            {
              "depth": 3,
              "text": "Daily quota per caller",
              "anchor": "daily-quota-per-caller"
            },
            {
              "depth": 3,
              "text": "Charge and refund",
              "anchor": "charge-and-refund"
            },
            {
              "depth": 3,
              "text": "Endpoints for product clients",
              "anchor": "endpoints-for-product-clients"
            },
            {
              "depth": 3,
              "text": "Erase the caller after success",
              "anchor": "erase-the-caller-after-success"
            },
            {
              "depth": 3,
              "text": "Credentials of the step's own connector",
              "anchor": "credentials-of-the-steps-own-connector"
            }
          ],
          "images": [],
          "sha256": "2ea1dade8866090c9a8ad15ebd204af7a5a3e064ad202f9bc7cdbf143953dbce",
          "body": "## Product bearer tokens and caller budgets\n\nYour app can call SubKit with its own users' sign-in instead of shipping a SubKit key. You need this when a native app or portal starts workflows for signed-in customers. Afterwards SubKit verifies every token itself and creates a tightly limited account per user; per workflow you can also set a daily quota per user.\n\nA bearer token is a credential the app sends in the `Authorization: Bearer …` header. Here it is a JWT (JSON Web Token): a signed data package whose issuer and content SubKit can verify. OIDC (OpenID Connect) is the standard through which SubKit finds the issuer's keys and details.\n\n### Configure provider and product\n\nAdd a provider with `oidc_bearer` and an entry under `products` through runtime configuration. Hosts in the example are placeholders. `audience` and `required_claims` have no defaults; you state both for your issuer. The complete checklist is in the chapter \"Onboard an app\".\n\n```json\n{\n  \"auth\": {\n    \"providers\": [\n      { \"protocol\": \"api_key\", \"id\": \"api-key\", \"label\": \"SubKit API key\" },\n      {\n        \"protocol\": \"oidc_bearer\",\n        \"id\": \"app-accounts\",\n        \"label\": \"App account\",\n        \"issuer_url\": \"https://idp.example.test\",\n        \"audience\": \"app-audience\",\n        \"algorithms\": [\"ES256\"],\n        \"product_id\": \"app\",\n        \"tenant_slug\": \"default\",\n        \"required_claims\": [\n          { \"path\": \"idp\", \"equals\": \"primary\" },\n          { \"path\": \"claims.tier\", \"equals\": \"member\" }\n        ],\n        \"reject_anonymous\": true,\n        \"clock_tolerance_s\": 30\n      }\n    ]\n  },\n  \"products\": {\n    \"app\": {\n      \"execution_environment\": \"prod\",\n      \"assistant_workflow_id\": \"00000000-0000-4000-8000-000000000001\",\n      \"budget_bucket\": \"assistant\"\n    }\n  }\n}\n```\n\n`label` is only the provider's display name, in the example the app account (\"App account\"). A claim is a field in the token. `reject_anonymous` refuses tokens whose `is_anonymous` claim is true.\n\n### How SubKit verifies the token\n\nThe app sends `Authorization: Bearer <access token>`. SubKit reads only that header, never a `token` query parameter. SubKit claims a token only when it is a compact JWS, meaning a signed JWT in the usual dot-separated form, and its `iss` equals a configured `issuer_url`. This provider never claims SubKit keys, portal tokens (short-lived SubKit tokens for embedded end-user runs), MCP tokens or exchanged tokens.\n\nSubKit then verifies:\n\n- the signature against the issuer's JWKS, meaning its published keys; it comes from `jwks_uri` or the OIDC discovery, is cached per provider and refetched once for an unknown key,\n- the audience and the list of allowed algorithms,\n- `exp`, `iat` and a `sub` in UUID format,\n- every `required_claims` entry, where `path` is a dot path into the verified payload,\n- anonymous subjects, when `reject_anonymous` is true.\n\nIf any check fails, SubKit answers `401 {\"code\":\"unauthorized\",\"error\":\"unauthorized\",\"message\":\"invalid bearer token\"}`. For that request SubKit then tries no other provider, cookie or key.\n\n### What a product caller may do\n\nOn a subject's first verified token, SubKit creates a product user. It gets the built-in member role, a placeholder address and an identity binding to the provider, issuer and product; email addresses are never linked. The product ceiling leaves this principal, meaning the authenticated identity, only `workflow:run`, `execution:read` and `execution:abort`. These apply to saved workflows with the same `product_id` and to its own executions.\n\nThese limits also apply:\n\n- No MCP surface: `/mcp` answers `403 product_caller_forbidden`, and the tool dispatcher refuses every tool outside those three permissions with `policy_denied`.\n- `oidc_bearer` providers never issue API keys or browser sessions and are not listed for browser login.\n- Runs always use the product's `execution_environment`; SubKit ignores an `x-subkit-environment` header for them.\n- Runs of a product principal verified through `oidc_bearer` are always live. Without a live execution authority, an active version or a usable prepared credential, SubKit answers 403 with the refusal code.\n- The run then does not start as a held preparation, meaning a preview with writes held back. `hold_writes: true` answers `403 product_preparation_forbidden`.\n\n### Daily quota per caller\n\nA sensitive product workflow with `required_caller_kind: \"user\"` may declare two guards:\n\n- `execution_guards.caller_daily_limit` limits use per caller and day. Fields: `bucket`, `limit`, IANA `tz`, `unit` as a `$input` path, `lease_ms`, `billable_steps`, optional `meter` (JSONata), `max_metered`, `commit_when` (JSONata over the run output) and `attach_usage_as`.\n- `execution_guards.input_bytes` limits the UTF-8 bytes per `$input` path. A string counts itself, other values count their JSON text.\n\nCounting happens in units; `unit` decides which input value defines a unit. On admission SubKit first checks the sizes. It then reserves one unit per caller and local day, in the same transaction that creates the execution, and only after the idempotency replay check. A replay therefore never charges.\n\nLater calls of a reserved or committed unit are free until `max_metered` calls were used. A unit runs only one call at a time. A call whose cancel was requested no longer counts as running. Refusals create no execution:\n\n- `429 {\"error\":\"rate-limited\",\"code\":\"rate_limited\",\"message\":\"…\",\"usage\":{\"usedToday\":50,\"dailyLimit\":50}}` when the day is used up,\n- `409 {\"error\":\"turn-busy\",\"code\":\"turn_busy\"}` while another run of the unit is queued or running; that run continues, and the same request with the same `idempotency_key` replays it (`idempotent_replay: true`, 202 while it runs) instead of reserving again,\n- `429 {\"error\":\"turn-limit\",\"code\":\"turn_limit\"}` once `max_metered` calls were used (every request a billable step sends counts when it is sent),\n- `400 {\"error\":\"invalid\",\"code\":\"invalid\"}` for an input part above its byte limit.\n\n### Charge and refund\n\nWhen a run ends:\n\n- On success SubKit commits the unit if `commit_when` is true. Otherwise it stays reserved for the next call.\n- As soon as a billable step sends its request, the unit counts as billable. This happens after the execution authority check. A failure, abort or timeout after that point stays charged.\n- A failed, aborted or timed-out run gets the unit refunded only under three conditions: no billable request was sent, no billable step succeeded, and no other run of the unit is active.\n- SubKit settles reservations whose lease expires on the next read: billable units are committed, the others refunded.\n\nA successful run's sensitive result contains `usage: {usedToday, dailyLimit}`.\n\n### Endpoints for product clients\n\n- `GET /v1/budget` returns `{usedToday, dailyLimit, day, resetsAt}` for the product's assistant workflow.\n- `GET /v1/health` returns `{ok, version, model, key}`. `ok` needs the active workflow, a live execution authority for the product environment and a usable credential on every connector it uses; no secret is read.\n- Both answer 404 to principals without a product.\n- `POST /v1/executions` with a `workflow_id` and no `source` runs that saved workflow. A product client therefore sends only `{workflow_id, idempotency_key, async, input}`.\n- `GET /v1/executions/{id}` also returns `execution_id` and `error: {code}` for failed or timed-out runs.\n\nAn admin may create a workflow under a fixed `id` so an app can address it without configuration. The id must be unused.\n\n### Erase the caller after success\n\n`caller_erasure: \"on_success\"` on such a workflow erases the caller as soon as the run succeeds:\n\n- Budget rows and identity bindings are deleted.\n- Sessions and keys are revoked.\n- The user is disabled and anonymised.\n- The subject is removed from its executions' caller context.\n- A tombstone holding only the subject's SHA-256 refuses tokens issued before the erasure.\n\nRequest steps can address the caller's own record with `${caller.subject}` and the boundary rule `{caller_bound: true}`. The rule is also accepted on a DELETE.\n\n### Credentials of the step's own connector\n\nA request step of a saved workflow may read its own connector's credential as `${cred.<own-slug>.<field>}` without `connector:read`. This applies only under a live execution authority and not in a held preparation. The reference must stay inside the approved reach. Draft and step runs, held preparations and saved runs without an authority still need `connector:read` on that connector.\n\nThe actual boundary: the credential is sent only to that connector's origin and never with a redirect. SubKit also redacts the raw, URL-encoded, form-encoded and JSON-escaped forms of the value from step outputs, errors, audit and logs. This is only a best-effort aid. If an upstream reflects the value in another encoding, or stores it and returns it later, it is not covered."
        },
        "de": {
          "title": "Produkt-Bearer-Tokens und Aufruferbudgets",
          "summary": "Lass deine App SubKit mit eigener Anmeldung aufrufen, mit Tageskontingent je Nutzer.",
          "headings": [
            {
              "depth": 2,
              "text": "Produkt-Bearer-Tokens und Aufruferbudgets",
              "anchor": "produkt-bearer-tokens-und-aufruferbudgets"
            },
            {
              "depth": 3,
              "text": "Anbieter und Produkt konfigurieren",
              "anchor": "anbieter-und-produkt-konfigurieren"
            },
            {
              "depth": 3,
              "text": "Wie SubKit das Token prüft",
              "anchor": "wie-subkit-das-token-prüft"
            },
            {
              "depth": 3,
              "text": "Was ein Produkt-Aufrufer darf",
              "anchor": "was-ein-produkt-aufrufer-darf"
            },
            {
              "depth": 3,
              "text": "Tageskontingent je Aufrufer",
              "anchor": "tageskontingent-je-aufrufer"
            },
            {
              "depth": 3,
              "text": "Abrechnen und erstatten",
              "anchor": "abrechnen-und-erstatten"
            },
            {
              "depth": 3,
              "text": "Endpunkte für Produkt-Clients",
              "anchor": "endpunkte-für-produkt-clients"
            },
            {
              "depth": 3,
              "text": "Aufrufer nach Erfolg löschen",
              "anchor": "aufrufer-nach-erfolg-löschen"
            },
            {
              "depth": 3,
              "text": "Zugangsdaten des eigenen Konnektors",
              "anchor": "zugangsdaten-des-eigenen-konnektors"
            }
          ],
          "images": [],
          "sha256": "f8d78045972d1a46cac2fa16e7092d727cb565ecb388f2841d386800406ff3c5",
          "body": "## Produkt-Bearer-Tokens und Aufruferbudgets\n\nDeine App kann SubKit mit der Anmeldung ihrer eigenen Nutzer aufrufen, statt einen SubKit-Schlüssel mitzuliefern. Du brauchst das, wenn eine native App oder ein Portal Workflows für angemeldete Kunden startet. Danach prüft SubKit jedes Token selbst und legt je Nutzer ein eng begrenztes Konto an; je Workflow kannst du zusätzlich ein Tageskontingent pro Nutzer festlegen.\n\nEin Bearer-Token ist ein Zugangsnachweis, den die App im Header `Authorization: Bearer …` mitschickt. Hier ist es ein JWT (JSON Web Token): ein signiertes Datenpaket, dessen Aussteller und Inhalt SubKit prüfen kann. OIDC (OpenID Connect) ist der Standard, über den SubKit die Schlüssel und Angaben des Ausstellers findet.\n\n### Anbieter und Produkt konfigurieren\n\nTrage in der Laufzeitkonfiguration einen Anbieter mit `oidc_bearer` und einen Eintrag unter `products` ein. Die Hosts im Beispiel sind Platzhalter. `audience` und `required_claims` haben keine Standardwerte; du gibst beide für deinen Aussteller an. Die vollständige Checkliste steht im Kapitel „Eine App anbinden“.\n\n```json\n{\n  \"auth\": {\n    \"providers\": [\n      { \"protocol\": \"api_key\", \"id\": \"api-key\", \"label\": \"SubKit API key\" },\n      {\n        \"protocol\": \"oidc_bearer\",\n        \"id\": \"app-accounts\",\n        \"label\": \"App account\",\n        \"issuer_url\": \"https://idp.example.test\",\n        \"audience\": \"app-audience\",\n        \"algorithms\": [\"ES256\"],\n        \"product_id\": \"app\",\n        \"tenant_slug\": \"default\",\n        \"required_claims\": [\n          { \"path\": \"idp\", \"equals\": \"primary\" },\n          { \"path\": \"claims.tier\", \"equals\": \"member\" }\n        ],\n        \"reject_anonymous\": true,\n        \"clock_tolerance_s\": 30\n      }\n    ]\n  },\n  \"products\": {\n    \"app\": {\n      \"execution_environment\": \"prod\",\n      \"assistant_workflow_id\": \"00000000-0000-4000-8000-000000000001\",\n      \"budget_bucket\": \"assistant\"\n    }\n  }\n}\n```\n\n`label` ist nur der Anzeigename des Anbieters, im Beispiel das App-Konto („App account“). Ein Claim ist ein Feld im Token. `reject_anonymous` lehnt Tokens ab, deren Claim `is_anonymous` wahr ist.\n\n### Wie SubKit das Token prüft\n\nDie App schickt `Authorization: Bearer <access token>`. SubKit liest nur diesen Header, nie einen Query-Parameter `token`. SubKit übernimmt ein Token nur, wenn es ein kompaktes JWS ist, also ein signiertes JWT in der üblichen Punkt-getrennten Form, und sein `iss` einem konfigurierten `issuer_url` entspricht. SubKit-Schlüssel, Portal-Tokens (kurzlebige SubKit-Tokens für eingebettete Läufe von Endnutzern), MCP-Tokens und getauschte Tokens übernimmt dieser Anbieter nie.\n\nDann prüft SubKit:\n\n- die Signatur gegen das JWKS des Ausstellers, also seine veröffentlichten Schlüssel; es kommt aus `jwks_uri` oder der OIDC-Discovery, wird je Anbieter zwischengespeichert und bei einem unbekannten Schlüssel einmal neu geladen,\n- die Audience und die Liste der erlaubten Algorithmen,\n- `exp`, `iat` und ein `sub` im UUID-Format,\n- jeden Eintrag in `required_claims`, wobei `path` ein Punktpfad in die geprüfte Nutzlast ist,\n- anonyme Subjects, wenn `reject_anonymous` wahr ist.\n\nScheitert eine Prüfung, antwortet SubKit mit `401 {\"code\":\"unauthorized\",\"error\":\"unauthorized\",\"message\":\"invalid bearer token\"}`. Für diese Anfrage versucht SubKit dann keinen anderen Anbieter, kein Cookie und keinen Schlüssel.\n\n### Was ein Produkt-Aufrufer darf\n\nBeim ersten geprüften Token eines Subjects legt SubKit einen Produktbenutzer an. Er bekommt die eingebaute Mitgliedsrolle, eine Platzhalter-Adresse und eine Identitätsbindung an Anbieter, Aussteller und Produkt; E-Mail-Adressen werden nie verknüpft. Die Obergrenze des Produkts lässt diesem Principal, also der angemeldeten Identität, nur `workflow:run`, `execution:read` und `execution:abort`. Diese Rechte gelten für gespeicherte Workflows mit derselben `product_id` und für seine eigenen Ausführungen.\n\nDazu kommen diese Grenzen:\n\n- Keine MCP-Oberfläche: `/mcp` antwortet mit `403 product_caller_forbidden`, und der Tool-Dispatcher lehnt jedes Tool außerhalb der drei Rechte mit `policy_denied` ab.\n- `oidc_bearer`-Anbieter stellen nie API-Schlüssel oder Browsersitzungen aus und erscheinen nicht bei der Browser-Anmeldung.\n- Läufe nutzen immer die `execution_environment` des Produkts; einen Header `x-subkit-environment` ignoriert SubKit dabei.\n- Läufe eines über `oidc_bearer` geprüften Produkt-Principals sind immer live. Fehlt eine Live-Freigabe, eine aktive Version oder ein nutzbares vorbereitetes Zugangsdatum, antwortet SubKit mit 403 und dem Ablehnungscode.\n- Der Lauf startet dann nicht als zurückgehaltene Vorbereitung, also als Vorschau mit angehaltenen Schreibschritten. `hold_writes: true` antwortet mit `403 product_preparation_forbidden`.\n\n### Tageskontingent je Aufrufer\n\nEin sensibler Produkt-Workflow mit `required_caller_kind: \"user\"` kann zwei Schutzregeln deklarieren:\n\n- `execution_guards.caller_daily_limit` begrenzt die Nutzung je Aufrufer und Tag. Felder: `bucket`, `limit`, IANA-`tz`, `unit` als `$input`-Pfad, `lease_ms`, `billable_steps`, optional `meter` (JSONata), `max_metered`, `commit_when` (JSONata über die Lauf-Ausgabe) und `attach_usage_as`.\n- `execution_guards.input_bytes` begrenzt die UTF-8-Bytes je `$input`-Pfad. Eine Zeichenkette zählt sich selbst, andere Werte zählen ihren JSON-Text.\n\nGezählt wird in Einheiten; welcher Eingabewert eine Einheit bestimmt, legt `unit` fest. Bei der Zulassung prüft SubKit zuerst die Größen. Dann reserviert es eine Einheit je Aufrufer und lokalem Tag, in derselben Transaktion, die die Ausführung anlegt, und erst nach der Prüfung auf eine Idempotenz-Wiederholung. Eine Wiederholung kostet deshalb nie etwas.\n\nWeitere Aufrufe einer reservierten oder festgeschriebenen Einheit sind kostenlos, bis `max_metered` Aufrufe verbraucht sind. Eine Einheit führt immer nur einen Aufruf gleichzeitig aus. Ein Aufruf, dessen Abbruch angefordert ist, zählt nicht mehr als laufend. Ablehnungen legen keine Ausführung an:\n\n- `429 {\"error\":\"rate-limited\",\"code\":\"rate_limited\",\"message\":\"…\",\"usage\":{\"usedToday\":50,\"dailyLimit\":50}}`, wenn der Tag aufgebraucht ist,\n- `409 {\"error\":\"turn-busy\",\"code\":\"turn_busy\"}`, solange ein anderer Lauf der Einheit eingereiht ist oder läuft; dieser Lauf läuft weiter, und dieselbe Anfrage mit demselben `idempotency_key` wiederholt ihn (`idempotent_replay: true`, 202 solange er läuft), statt erneut zu reservieren,\n- `429 {\"error\":\"turn-limit\",\"code\":\"turn_limit\"}`, sobald `max_metered` Aufrufe verbraucht sind (jede Anfrage, die ein abrechenbarer Schritt sendet, zählt beim Senden),\n- `400 {\"error\":\"invalid\",\"code\":\"invalid\"}` für einen Eingabeteil über seiner Byte-Grenze.\n\n### Abrechnen und erstatten\n\nWenn ein Lauf endet, gilt:\n\n- Bei Erfolg schreibt SubKit die Einheit fest, wenn `commit_when` wahr ist. Sonst bleibt sie für den nächsten Aufruf reserviert.\n- Sobald ein abrechenbarer Schritt seine Anfrage sendet, gilt die Einheit als abrechenbar. Das geschieht nach der Prüfung der Freigabe. Fehler, Abbruch oder Zeitüberschreitung danach bleiben berechnet.\n- Ein fehlgeschlagener, abgebrochener oder abgelaufener Lauf bekommt die Einheit nur unter drei Bedingungen erstattet: Keine abrechenbare Anfrage wurde gesendet, kein abrechenbarer Schritt war erfolgreich, und kein anderer Lauf der Einheit ist aktiv.\n- Reservierungen, deren Lease abläuft, rechnet SubKit beim nächsten Lesen ab: Abrechenbare Einheiten werden festgeschrieben, die übrigen erstattet.\n\nDas sensible Ergebnis eines erfolgreichen Laufs enthält `usage: {usedToday, dailyLimit}`.\n\n### Endpunkte für Produkt-Clients\n\n- `GET /v1/budget` liefert `{usedToday, dailyLimit, day, resetsAt}` für den Assistenten-Workflow des Produkts.\n- `GET /v1/health` liefert `{ok, version, model, key}`. `ok` setzt den aktiven Workflow, eine Live-Freigabe für die Produktumgebung und ein nutzbares Zugangsdatum an jedem verwendeten Konnektor voraus; ein Secret wird dabei nicht gelesen.\n- Beide antworten Principals ohne Produkt mit 404.\n- `POST /v1/executions` mit `workflow_id` und ohne `source` führt diesen gespeicherten Workflow aus. Ein Produkt-Client sendet also nur `{workflow_id, idempotency_key, async, input}`.\n- `GET /v1/executions/{id}` liefert bei fehlgeschlagenen oder abgelaufenen Läufen zusätzlich `execution_id` und `error: {code}`.\n\nEin Admin kann einen Workflow unter einer festen `id` anlegen, damit eine App ihn ohne Konfiguration ansprechen kann. Die ID darf noch nicht vergeben sein.\n\n### Aufrufer nach Erfolg löschen\n\n`caller_erasure: \"on_success\"` an einem solchen Workflow löscht den Aufrufer, sobald der Lauf erfolgreich ist:\n\n- Budgetzeilen und Identitätsbindungen werden gelöscht.\n- Sitzungen und Schlüssel werden widerrufen.\n- Der Benutzer wird deaktiviert und anonymisiert.\n- Das Subject wird aus dem Aufrufer-Kontext seiner Ausführungen entfernt.\n- Ein Löschvermerk (Tombstone) mit nur dem SHA-256 des Subjects lehnt Tokens ab, die vor der Löschung ausgestellt wurden.\n\nRequest-Schritte können den eigenen Datensatz des Aufrufers mit `${caller.subject}` und der Grenzregel `{caller_bound: true}` ansprechen. Die Regel wird auch bei einem DELETE akzeptiert.\n\n### Zugangsdaten des eigenen Konnektors\n\nEin Request-Schritt eines gespeicherten Workflows darf das Zugangsdatum seines eigenen Konnektors als `${cred.<own-slug>.<field>}` lesen, ohne `connector:read`. Das gilt nur unter einer Live-Freigabe und nicht in einer zurückgehaltenen Vorbereitung. Der Verweis muss innerhalb der freigegebenen Reichweite bleiben. Entwurfs- und Schrittläufe, zurückgehaltene Vorbereitungen und gespeicherte Läufe ohne Freigabe brauchen weiter `connector:read` für diesen Konnektor.\n\nDie eigentliche Grenze: Das Zugangsdatum geht nur an den Origin dieses Konnektors und nie mit einer Weiterleitung. Zusätzlich schwärzt SubKit den Wert in roher, URL-kodierter, formularkodierter und JSON-maskierter Form in Schrittausgaben, Fehlern, Audit und Logs. Das ist nur eine Hilfe nach bestem Bemühen. Gibt ein Upstream den Wert in einer anderen Kodierung zurück oder speichert ihn und liefert ihn später aus, greift sie nicht."
        }
      }
    },
    {
      "slug": "supabase-backed-product-workflows",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 7,
      "generated": false,
      "locales": {
        "en": {
          "title": "Supabase-backed product workflows",
          "summary": "Use your Supabase project's data in product workflows without exposing keys.",
          "headings": [
            {
              "depth": 2,
              "text": "Supabase-backed product workflows",
              "anchor": "supabase-backed-product-workflows"
            },
            {
              "depth": 3,
              "text": "Credentials on the connector",
              "anchor": "credentials-on-the-connector"
            },
            {
              "depth": 3,
              "text": "Data of individual users",
              "anchor": "data-of-individual-users"
            }
          ],
          "images": [],
          "sha256": "c34c4ee0872d728252eaf853d1d71c78b75f7234f8876729ca4c36e419bdefa9",
          "body": "## Supabase-backed product workflows\n\nWith the `supabase` connector your product workflows reach your Supabase project without direct PostgreSQL access and without SQL steps. You need this when an app should read or change its users' data through SubKit. Afterwards every key sits encrypted on the connector, and you reach user-owned data through the verified caller instead of a user token passed along.\n\nThis section covers the `supabase` connector only. It does not matter which identity provider signs the app's users in. You author workflows as usual.\n\n### Credentials on the connector\n\nStore the required gateway headers as encrypted connector credentials:\n\n- `apikey` is the public project key.\n- `Authorization` carries the JWT (a signed token) for the intended database role.\n- `x-subkit-token` may additionally be required by a protected server-to-server RPC. It is stored only on the connector and identifies SubKit to your product backend. It is not the end user's identity and never replaces the workflow's immutable `$caller`.\n\nDo not use `service_role` for access on behalf of a caller: this role bypasses RLS, the database's row-level access rules. Never put credentials in app code, workflow inputs or steps, client context, generated workflow source, or logs.\n\n### Data of individual users\n\nA connector credential applies to the whole tenant and cannot represent separate mobile users. Never pass an app user's JWT as workflow input for that reason. When a workflow needs user-owned data, use an RPC, meaning a database function behind an endpoint, that derives the owner from the immutable `$caller`.\n\nBind product workflows to their product and the required caller kind. Derive owner identifiers from `$caller`. If an atomic authorization or quota reservation does not explicitly permit the next step, the workflow must fail closed instead of continuing."
        },
        "de": {
          "title": "Produkt-Workflows mit Supabase",
          "summary": "Nutze Daten deines Supabase-Projekts in Produkt-Workflows, ohne Schlüssel preiszugeben.",
          "headings": [
            {
              "depth": 2,
              "text": "Produkt-Workflows mit Supabase",
              "anchor": "produkt-workflows-mit-supabase"
            },
            {
              "depth": 3,
              "text": "Zugangsdaten am Konnektor",
              "anchor": "zugangsdaten-am-konnektor"
            },
            {
              "depth": 3,
              "text": "Daten einzelner Nutzer",
              "anchor": "daten-einzelner-nutzer"
            }
          ],
          "images": [],
          "sha256": "47099ce76267132c5b566feb6aacfbd4305aeadafb2579ac0cba903d511ab9c7",
          "body": "## Produkt-Workflows mit Supabase\n\nMit dem `supabase`-Konnektor greifen deine Produkt-Workflows auf dein Supabase-Projekt zu, ohne direkten PostgreSQL-Zugang und ohne SQL-Schritte. Du brauchst das, wenn eine App über SubKit Daten ihrer Nutzer lesen oder ändern soll. Danach liegen alle Schlüssel verschlüsselt am Konnektor, und nutzereigene Daten erreichst du über den geprüften Aufrufer statt über ein mitgeschicktes Nutzer-Token.\n\nDieser Abschnitt behandelt nur den `supabase`-Konnektor. Welcher Identitätsanbieter die Nutzer der App anmeldet, spielt dafür keine Rolle. Workflows baust du wie gewohnt.\n\n### Zugangsdaten am Konnektor\n\nSpeichere die nötigen Gateway-Header als verschlüsselte Zugangsdaten am Konnektor:\n\n- `apikey` ist der öffentliche Projektschlüssel.\n- `Authorization` trägt das JWT (ein signiertes Token) für die vorgesehene Datenbankrolle.\n- `x-subkit-token` kann eine geschützte Server-zu-Server-RPC zusätzlich verlangen. Es liegt nur am Konnektor und weist SubKit gegenüber deinem Produkt-Backend aus. Es ist nicht die Identität des Endnutzers und ersetzt nie das unveränderliche `$caller` des Workflows.\n\nVerwende `service_role` nicht für Zugriffe im Namen eines Aufrufers: Diese Rolle umgeht RLS, die zeilenweisen Zugriffsregeln der Datenbank. Zugangsdaten gehören nie in App-Code, Workflow-Eingaben oder -Schritte, Client-Kontext, generierten Workflow-Quelltext oder Logs.\n\n### Daten einzelner Nutzer\n\nEin Zugangsdatum am Konnektor gilt für den ganzen Mandanten (im Cockpit: Arbeitsbereich) und kann keine einzelnen mobilen Nutzer abbilden. Übergib das JWT eines App-Nutzers deshalb nie als Workflow-Eingabe. Braucht ein Workflow nutzereigene Daten, nimm eine RPC, also eine Datenbankfunktion hinter einem Endpunkt, die den Eigentümer aus dem unveränderlichen `$caller` ableitet.\n\nBinde Produkt-Workflows an ihr Produkt und die erforderliche Aufruferart. Leite Eigentümerkennungen aus `$caller` ab. Erlaubt eine atomare Rechteprüfung oder Kontingent-Reservierung den nächsten Schritt nicht ausdrücklich, muss der Workflow mit einem Fehler abbrechen, statt weiterzulaufen."
        }
      }
    },
    {
      "slug": "external-mcp-oauth-credentials",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 8,
      "generated": false,
      "locales": {
        "en": {
          "title": "External MCP OAuth credentials",
          "summary": "Connect external MCP servers over OAuth without secrets being redirected.",
          "headings": [
            {
              "depth": 2,
              "text": "External MCP OAuth credentials",
              "anchor": "external-mcp-oauth-credentials"
            },
            {
              "depth": 3,
              "text": "Sign-in with client credentials",
              "anchor": "sign-in-with-client-credentials"
            },
            {
              "depth": 3,
              "text": "Interactive sign-in",
              "anchor": "interactive-sign-in"
            },
            {
              "depth": 3,
              "text": "Older credentials without dynamic registration",
              "anchor": "older-credentials-without-dynamic-registration"
            }
          ],
          "images": [],
          "sha256": "559b3def1ef4203ea15d76b81ad7f78d1b80fefd37d3ceac14fb2f93c6bfc66b",
          "body": "## External MCP OAuth credentials\n\nSome external MCP servers require an OAuth sign-in before SubKit may use their tools. You need this chapter when you set up such a server as a connector or want to keep using older saved sign-ins. Afterwards every sign-in is bound to a fixed authorization server, and client secrets go only there.\n\nOAuth is the common method by which one service grants another access. The authorization server issues the tokens for it.\n\n### Sign-in with client credentials\n\nFor connectors using `oauth2_client_credentials` or `oauth2_private_key_jwt`, enter the trusted authorization server URL as `config.mcp.auth.issuer` before connecting. Without that binding SubKit does not use the credentials. Discovery, the automatic lookup of server addresses, then cannot redirect a client secret or signed assertion to another authorization server.\n\n### Interactive sign-in\n\nWith interactive MCP OAuth, SubKit stores the authorization-server issuer together with the encrypted client information and tokens. SubKit does not reuse older saved credentials without an issuer. For providers with dynamic client registration, you start a new sign-in through the connector's OAuth setup.\n\n### Older credentials without dynamic registration\n\nWhether older confidential clients at providers without dynamic registration can be recovered through the public setup APIs is not verified yet. Do not assume that entering an issuer afterwards restores those credentials. Put such connections into service only once their recovery has been verified. Do not edit stored credentials to bypass this check.\n\nChanged discovery metadata does not migrate existing credentials. A new sign-in never inherits a refresh token issued by a different server. Review a provider change before you authorize it: the binding says nothing about whether a newly selected provider is trustworthy."
        },
        "de": {
          "title": "OAuth-Zugangsdaten für externe MCP-Server",
          "summary": "Binde externe MCP-Server über OAuth an, ohne dass Geheimnisse umgeleitet werden.",
          "headings": [
            {
              "depth": 2,
              "text": "OAuth-Zugangsdaten für externe MCP-Server",
              "anchor": "oauth-zugangsdaten-für-externe-mcp-server"
            },
            {
              "depth": 3,
              "text": "Anmeldung mit Client-Zugangsdaten",
              "anchor": "anmeldung-mit-client-zugangsdaten"
            },
            {
              "depth": 3,
              "text": "Interaktive Anmeldung",
              "anchor": "interaktive-anmeldung"
            },
            {
              "depth": 3,
              "text": "Ältere Zugangsdaten ohne dynamische Registrierung",
              "anchor": "ältere-zugangsdaten-ohne-dynamische-registrierung"
            }
          ],
          "images": [],
          "sha256": "3f6fc6c96c8918506651c53523ac68b81735ca677c088bb3effe5c517fdfef5b",
          "body": "## OAuth-Zugangsdaten für externe MCP-Server\n\nManche externen MCP-Server verlangen eine OAuth-Anmeldung, bevor SubKit ihre Tools nutzen darf. Du brauchst dieses Kapitel, wenn du einen solchen Server als Konnektor einrichtest oder ältere gespeicherte Anmeldungen weiterverwenden willst. Danach ist jede Anmeldung an einen festen Autorisierungsserver gebunden, und Client-Secrets gehen nur dorthin.\n\nOAuth ist das übliche Verfahren, mit dem ein Dienst einem anderen Zugriff gewährt. Der Autorisierungsserver stellt dafür die Tokens aus.\n\n### Anmeldung mit Client-Zugangsdaten\n\nFür Konnektoren mit `oauth2_client_credentials` oder `oauth2_private_key_jwt` trägst du vor dem Verbinden die vertrauenswürdige Adresse des Autorisierungsservers als `config.mcp.auth.issuer` ein. Ohne diese Bindung verwendet SubKit die Zugangsdaten nicht. Die Discovery, das automatische Nachschlagen der Server-Adressen, kann ein Client-Secret oder eine signierte Assertion dann nicht an einen anderen Autorisierungsserver umleiten.\n\n### Interaktive Anmeldung\n\nBei interaktivem MCP-OAuth speichert SubKit den Aussteller des Autorisierungsservers zusammen mit den verschlüsselten Client-Daten und Tokens. Ältere gespeicherte Zugangsdaten ohne Aussteller verwendet SubKit nicht weiter. Bei Anbietern mit dynamischer Client-Registrierung startest du über das OAuth-Setup des Konnektors eine neue Anmeldung.\n\n### Ältere Zugangsdaten ohne dynamische Registrierung\n\nOb sich ältere vertrauliche Clients bei Anbietern ohne dynamische Registrierung über die öffentlichen Setup-APIs wiederherstellen lassen, ist noch nicht geprüft. Geh nicht davon aus, dass ein nachgetragener Aussteller diese Zugangsdaten wiederherstellt. Nimm solche Verbindungen erst in Betrieb, wenn ihre Wiederherstellung geprüft ist. Bearbeite gespeicherte Zugangsdaten nicht, um diese Prüfung zu umgehen.\n\nGeänderte Discovery-Metadaten übertragen bestehende Zugangsdaten nicht. Eine neue Anmeldung übernimmt nie ein Refresh-Token, das ein anderer Server ausgestellt hat. Prüfe einen Anbieterwechsel, bevor du ihn autorisierst: Die Bindung sagt nichts darüber, ob ein neu gewählter Anbieter vertrauenswürdig ist."
        }
      }
    },
    {
      "slug": "direct-signed-jwt-connector-credentials",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 9,
      "generated": false,
      "locales": {
        "en": {
          "title": "Direct signed-JWT connector credentials",
          "summary": "Connect APIs like App Store Connect that accept a signed JWT directly.",
          "headings": [
            {
              "depth": 2,
              "text": "Direct signed-JWT connector credentials",
              "anchor": "direct-signed-jwt-connector-credentials"
            },
            {
              "depth": 3,
              "text": "Set up a signed-JWT connector",
              "anchor": "set-up-a-signed-jwt-connector"
            },
            {
              "depth": 3,
              "text": "Rules for agents with signed JWTs",
              "anchor": "rules-for-agents-with-signed-jwts"
            }
          ],
          "images": [],
          "sha256": "9048314e4c121d498b970db668a100c751e8267c15bdce6aab926fa7de7dd636",
          "body": "## Direct signed-JWT connector credentials\n\nSome APIs, such as App Store Connect, expect a JWT signed with your private key instead of a password or OAuth token. You need this chapter when you set up such a service as a connector. Afterwards SubKit creates a fresh token for every request, and your private key sits only encrypted on the connector.\n\nA JWT (JSON Web Token) is a short, signed data package; the recipient verifies it with your public key. Here SubKit sends it directly to the resource API in the `Authorization: Bearer` header. This differs from OAuth `private_key_jwt`: a direct signed JWT never goes to a token endpoint. SubKit creates it for the outbound request, retains it only in memory, and does not place it in a workflow, audit entry, or log.\n\nThe connector configuration holds the public signing policy: algorithm (`ES256` or `RS256`), audience, optional issuer, subject and key id. It also holds literal custom claims (fields in the token) and a 60–3600 second lifetime. The connector credential holds only the encrypted private key. SubKit supplies `iat` and `exp`; they cannot be set as custom claims. To rotate a key, replace the credential through the connector's normal credential screen, then verify it with the connector's authenticated test.\n\nThe built-in **App Store Connect** template is a direct signed-JWT connector for\n`https://api.appstoreconnect.apple.com`. Its policy is fixed to `ES256`, audience\n`appstoreconnect-v1`, and a five-minute lifetime.\n\nAdd the private `.p8` key as\nthe credential and configure the public Key ID. For a team key set the App Store\nConnect Issuer ID as `issuer`; for an individual key omit `issuer` and set\n`subject` to `user`. The first probe is `GET /v1/apps`. Do not configure OAuth,\na token endpoint, or an OAuth client assertion for this connector.\n\nThe template discovers endpoints from Apple's official OpenAPI ZIP download.\nDiscovery accepts a single JSON or YAML specification in an archive, limits\ncompressed and extracted content to 16 MiB, and rejects ambiguous archives.\nThe resulting endpoint catalog is available to agents; connector documentation\ncan also be imported with `POST /v1/connectors/{id}/docs/ingest` using\n`source_type: \"openapi\"` and the extracted specification as `content`.\n\n### Set up a signed-JWT connector\n\nIn Cockpit, under **Connectors**, choose **Add connector → From a template → App Store Connect**, then open the\nconnector's existing edit dialog. Enter the public Key ID and either the Issuer\nID (team key) or Subject `user` (individual key). Paste the private key into the\nprivate-key field, save, and run the connector test. A saved key does not prove\nthat the provider accepts it; only a successful authenticated test does.\n\nUse an App Store Connect API key that can read the intended apps and TestFlight\nresources. A Sign in with Apple key is a different credential. The template\ncreates no testers, sends no invitations, and cannot bypass Apple's beta review.\nIt remains unverified in the catalogue until a real provider test has succeeded.\n\nFor other providers, the same HTTP or GraphQL connector mode accepts this public\nconfiguration, without an Apple-specific transport or token exchange:\n\n```json\n{\n  \"auth_type\": \"signed_jwt\",\n  \"config\": {\n    \"signed_jwt\": {\n      \"algorithm\": \"RS256\",\n      \"audience\": \"https://api.example.com\",\n      \"issuer\": \"service-account\",\n      \"subject\": \"integration\",\n      \"key_id\": \"provider-key-id\",\n      \"ttl_seconds\": 300,\n      \"claims\": { \"role\": \"reader\" }\n    }\n  }\n}\n```\n\nThis is the auth part of a connector definition, not a complete create\nrequest. Set the connector name, driver, environment and base URL as usual.\nFor GraphQL, set its endpoint through the existing GraphQL configuration. Public\nclaims must match the provider's documented requirements.\n\nThe App Store template fixes algorithm, audience, custom claims and lifetime. To change\nthem, you must explicitly clear or replace the template binding. SubKit checks public identity or key changes\nagainst existing execution authorities.\n\nAttach or replace the key to an already configured connector through the CLI:\n\n```sh\nsk credentials set <connector-id> --mode signed_jwt --private-key-file ./provider-key.p8 --json\n```\n\nThe CLI reads the file locally and sends its contents only to the authenticated\ncredential endpoint. The JSON result includes the probe outcome; a failed probe\nexits unsuccessfully. `--skip-checks` skips the test and makes no connectivity claim.\nNever paste a key into a command argument, connector config, workflow, or chat.\nThe credential API accepts `{ \"mode\": \"signed_jwt\", \"private_key\": \"<PEM>\" }`\nand returns the credential ID, never the key or a generated token.\n\nKeys must be unencrypted PKCS#8 PEM: P-256 for ES256, or RSA 2048–4096 bits for\nRS256. SubKit encrypts stored keys, generates a fresh token for each actual\nrequest attempt, and regenerates tokens after restart without a refresh job.\nWhen setting up a draft, SubKit holds the submitted key only transiently in the protected\ncredential flow until it is saved; it never ends up in chat messages.\nRequests cannot redirect to a different resource, and connector hooks do not see\nthe generated token. Reflected tokens are removed from provider results.\n\n| Problem | Next action |\n| --- | --- |\n| Private key is invalid or has the wrong algorithm | Use the matching provider-issued PKCS#8 key. Do not submit a certificate, public key, JWK or generated JWT. |\n| Provider returns 401 | Check Key ID, issuer/subject, audience, revoked keys and the engine's clock. Replacing a key does not fix an incorrect identity. |\n| Provider returns 403 | Check the API key's provider role and access to the intended resource. |\n| Provider redirects or target origin differs | Use the final documented API origin in the connector. Signed requests do not follow redirects. |\n| Provider is unavailable | Retry the read-only test after recovery; do not replace a valid key solely for a temporary outage. |\n| Key rotation | Update the public identity fields if needed, replace the private-key credential, then rerun the read-only test. Never reuse a previously generated JWT. |\n\n### Rules for agents with signed JWTs\n\nDiscover the template before authoring a connector. Configure only public fields\nunder `config.signed_jwt`. Request the private key through SubKit's existing\nsensitive credential form or browser setup handoff. Never request it in free-text\nchat, and do not generate, print or store JWTs yourself. The secure form field is\n`private_key`; `token` and OAuth `client_secret` are not substitutes.\n\nAfter saving, read the authenticated probe result and report provider failures\nwithout claiming connectivity. Check fresh build/review state before saying an\ninvitation can be used. An invitation or any other provider mutation requires its\nown authorized workflow; the connector setup test performs only a read.\n\nUse the generated OpenAPI schemas as the machine-readable specification and the template-bound\n`app-store-connect-basics` skill for vendor guidance. The generated `/llms/setup.md`,\n`/llms/connectors.md`, `/llms/cli.md` and `/llms-full.txt` ship with the engine and\nare regenerated from these sources; do not maintain a second auth specification."
        },
        "de": {
          "title": "Direkte signierte JWT-Konnektor-Zugangsdaten",
          "summary": "Verbinde APIs wie App Store Connect, die ein signiertes JWT direkt akzeptieren.",
          "headings": [
            {
              "depth": 2,
              "text": "Direkte signierte JWT-Konnektor-Zugangsdaten",
              "anchor": "direkte-signierte-jwt-konnektor-zugangsdaten"
            },
            {
              "depth": 3,
              "text": "Einen Konnektor mit signiertem JWT einrichten",
              "anchor": "einen-konnektor-mit-signiertem-jwt-einrichten"
            },
            {
              "depth": 3,
              "text": "Regeln für Agenten bei signierten JWTs",
              "anchor": "regeln-für-agenten-bei-signierten-jwts"
            }
          ],
          "images": [],
          "sha256": "55c3c376bfa5ab8f4b544d8e85b7dfef130563260bf3b7e63f009fb5ce8a5321",
          "body": "## Direkte signierte JWT-Konnektor-Zugangsdaten\n\nManche APIs, etwa App Store Connect, erwarten statt eines Passworts oder OAuth-Tokens ein JWT, das mit deinem privaten Schlüssel signiert ist. Du brauchst dieses Kapitel, wenn du einen solchen Dienst als Konnektor einrichtest. Danach erzeugt SubKit für jede Anfrage ein frisches Token, und dein privater Schlüssel liegt nur verschlüsselt am Konnektor.\n\nEin JWT (JSON Web Token) ist ein kurzes, signiertes Datenpaket; der Empfänger prüft es mit deinem öffentlichen Schlüssel. Hier schickt SubKit es direkt im Header `Authorization: Bearer` an die Ressourcen-API. Das unterscheidet sich von OAuth `private_key_jwt`: Ein direktes signiertes JWT geht nie an einen Token-Endpunkt. SubKit erzeugt es für die ausgehende Anfrage, hält es nur im Speicher und legt es weder in einem Workflow noch in einem Audit-Eintrag oder Log ab.\n\nDie Konnektorkonfiguration enthält die öffentliche Signaturrichtlinie: Algorithmus (`ES256` oder `RS256`), Audience, optionaler Aussteller, Subject und Schlüssel-ID. Dazu kommen wörtliche eigene Claims (Felder im Token) und eine Lebensdauer von 60–3600 Sekunden. Die Konnektor-Zugangsdaten enthalten nur den verschlüsselten privaten Schlüssel. SubKit setzt `iat` und `exp`; als eigene Claims lassen sie sich nicht setzen. Um einen Schlüssel zu rotieren, ersetze die Zugangsdaten über die normale Zugangsdaten-Maske des Konnektors und prüfe ihn dann mit dem authentifizierten Test des Konnektors.\n\nDie eingebaute Vorlage **App Store Connect** ist ein Konnektor mit direktem signiertem JWT für\n`https://api.appstoreconnect.apple.com`. Die Richtlinie der Vorlage ist fest auf `ES256`, die Audience\n`appstoreconnect-v1` und eine Lebensdauer von fünf Minuten gesetzt.\n\nFüge den privaten `.p8`-Schlüssel als\nZugangsdatum hinzu und konfiguriere die öffentliche Key ID. Setze bei einem Team-Schlüssel die App-Store-Connect-Issuer-ID\nals `issuer`; lass bei einem individuellen Schlüssel `issuer` weg und setze\n`subject` auf `user`. Die erste Probe ist `GET /v1/apps`. Konfiguriere für diesen Konnektor weder OAuth,\nnoch einen Token-Endpunkt, noch eine OAuth-Client-Assertion.\n\nDie Vorlage ermittelt Endpunkte aus dem offiziellen OpenAPI-ZIP-Download von Apple.\nDie Discovery akzeptiert eine einzelne JSON- oder YAML-Spezifikation in einem Archiv, begrenzt\nkomprimierte und extrahierte Inhalte auf 16 MiB und lehnt mehrdeutige Archive ab.\nDer entstehende Endpunktkatalog steht Agenten zur Verfügung; die Konnektor-Dokumentation\nkann außerdem mit `POST /v1/connectors/{id}/docs/ingest` importiert werden, mit\n`source_type: \"openapi\"` und der extrahierten Spezifikation als `content`.\n\n### Einen Konnektor mit signiertem JWT einrichten\n\nWähle im Cockpit unter **Konnektoren** **Konnektor hinzufügen → Aus Vorlage → App Store Connect** und öffne dann den\nvorhandenen Bearbeitungsdialog des Konnektors. Gib die öffentliche Key ID und entweder die Issuer-ID\n(Team-Schlüssel) oder das Subject `user` (individueller Schlüssel) ein. Füge den privaten Schlüssel in das\nFeld für den privaten Schlüssel ein, speichere und führe den Konnektortest aus. Dass ein Schlüssel gespeichert ist,\nbelegt nicht, dass der Anbieter ihn akzeptiert; das belegt erst ein erfolgreicher authentifizierter Test.\n\nVerwende einen App-Store-Connect-API-Schlüssel, der die vorgesehenen Apps und TestFlight-Ressourcen lesen kann.\nEin Sign-in-with-Apple-Schlüssel ist ein anderes Zugangsdatum. Die Vorlage\nlegt keine Tester an, sendet keine Einladungen und kann die Beta-Prüfung von Apple nicht umgehen.\nSie bleibt im Katalog unverifiziert, bis ein echter Anbietertest erfolgreich war.\n\nFür andere Anbieter akzeptiert derselbe HTTP- oder GraphQL-Konnektormodus diese öffentliche\nKonfiguration, ohne Apple-spezifischen Transport oder Token-Austausch:\n\n```json\n{\n  \"auth_type\": \"signed_jwt\",\n  \"config\": {\n    \"signed_jwt\": {\n      \"algorithm\": \"RS256\",\n      \"audience\": \"https://api.example.com\",\n      \"issuer\": \"service-account\",\n      \"subject\": \"integration\",\n      \"key_id\": \"provider-key-id\",\n      \"ttl_seconds\": 300,\n      \"claims\": { \"role\": \"reader\" }\n    }\n  }\n}\n```\n\nDas ist der Auth-Teil einer Konnektordefinition, keine vollständige Anlege-Anfrage.\nKonnektorname, Treiber, Umgebung und Basis-URL setzt du wie üblich.\nBei GraphQL setzt du den Endpunkt über die bestehende GraphQL-Konfiguration. Öffentliche\nClaims müssen den dokumentierten Vorgaben des Anbieters entsprechen.\n\nDie App-Store-Vorlage legt Algorithmus, Audience, eigene Claims und Lebensdauer fest. Willst du sie ändern, musst du die\nVorlagenbindung ausdrücklich löschen oder ersetzen. Änderungen an öffentlicher Identität oder Schlüssel prüft SubKit\ngegen bestehende Freigaben.\n\nHänge den Schlüssel über die CLI an einen bereits konfigurierten Konnektor an oder ersetze ihn:\n\n```sh\nsk credentials set <connector-id> --mode signed_jwt --private-key-file ./provider-key.p8 --json\n```\n\nDie CLI liest die Datei lokal und sendet ihren Inhalt nur an den authentifizierten\nZugangsdaten-Endpunkt. Das JSON-Ergebnis enthält das Ergebnis der Probe; eine fehlgeschlagene Probe\nbeendet mit Fehlerstatus. `--skip-checks` überspringt den Test und macht keine Aussage zur Konnektivität.\nFüge einen Schlüssel nie in ein Befehlsargument, eine Konnektorkonfiguration, einen Workflow oder einen Chat ein.\nDie Zugangsdaten-API akzeptiert `{ \"mode\": \"signed_jwt\", \"private_key\": \"<PEM>\" }`\nund liefert die Zugangsdaten-ID zurück, nie den Schlüssel oder ein erzeugtes Token.\n\nSchlüssel müssen unverschlüsseltes PKCS#8-PEM sein: P-256 für ES256 oder RSA mit 2048–4096 Bit für\nRS256. SubKit verschlüsselt gespeicherte Schlüssel, erzeugt für jeden tatsächlichen\nAnfrageversuch ein frisches Token und erzeugt Tokens nach einem Neustart ohne Refresh-Job neu.\nBeim Einrichten eines Entwurfs hält SubKit den übermittelten Schlüssel nur vorübergehend im geschützten\nZugangsdaten-Weg, bis er gespeichert ist; in Chat-Nachrichten landet er nicht.\nAnfragen können nicht auf eine andere Ressource umleiten, und Konnektor-Hooks sehen das\nerzeugte Token nicht. Gespiegelte Tokens werden aus Anbieterergebnissen entfernt.\n\n| Problem | Nächste Maßnahme |\n| --- | --- |\n| Der private Schlüssel ist ungültig oder hat den falschen Algorithmus | Verwende den passenden vom Anbieter ausgestellten PKCS#8-Schlüssel. Übermittle kein Zertifikat, keinen öffentlichen Schlüssel, kein JWK und kein erzeugtes JWT. |\n| Der Anbieter liefert 401 | Prüfe Key ID, Aussteller/Subject, Audience, widerrufene Schlüssel und die Uhr der Engine. Das Ersetzen eines Schlüssels behebt keine falsche Identität. |\n| Der Anbieter liefert 403 | Prüfe die Anbieterrolle des API-Schlüssels und den Zugriff auf die vorgesehene Ressource. |\n| Der Anbieter leitet um oder der Ziel-Origin weicht ab | Verwende im Konnektor den endgültigen dokumentierten API-Origin. Signierte Anfragen folgen keinen Weiterleitungen. |\n| Der Anbieter ist nicht verfügbar | Wiederhole den schreibgeschützten Test nach der Wiederherstellung; ersetze einen gültigen Schlüssel nicht allein wegen eines vorübergehenden Ausfalls. |\n| Schlüsselrotation | Aktualisiere bei Bedarf die öffentlichen Identitätsfelder, ersetze das Zugangsdatum mit dem privaten Schlüssel und führe dann den schreibgeschützten Test erneut aus. Verwende nie ein zuvor erzeugtes JWT wieder. |\n\n### Regeln für Agenten bei signierten JWTs\n\nErmittle die Vorlage, bevor du einen Konnektor erstellst. Konfiguriere nur öffentliche Felder\nunter `config.signed_jwt`. Fordere den privaten Schlüssel über das bestehende sensible\nZugangsdatenformular von SubKit oder die Übergabe an die Browser-Einrichtung an. Fordere ihn nie im Freitext-Chat an,\nund erzeuge, drucke oder speichere JWTs nicht selbst. Das sichere Formularfeld ist\n`private_key`; `token` und OAuth-`client_secret` sind kein Ersatz.\n\nLies nach dem Speichern das Ergebnis der authentifizierten Probe und melde Anbieterfehler,\nohne Konnektivität zu behaupten. Prüfe den aktuellen Build-/Prüfstatus, bevor du sagst, dass eine\nEinladung verwendet werden kann. Eine Einladung oder jede andere Anbieter-Mutation erfordert einen eigenen\nautorisierten Workflow; der Einrichtungstest des Konnektors führt nur einen Lesezugriff aus.\n\nVerwende die generierten OpenAPI-Schemas als maschinenlesbare Beschreibung und den an die Vorlage gebundenen\nSkill `app-store-connect-basics` für Anbieterhinweise. Die generierten `/llms/setup.md`,\n`/llms/connectors.md`, `/llms/cli.md` und `/llms-full.txt` werden mit der Engine ausgeliefert und\naus diesen Quellen neu generiert; pflege keine zweite Auth-Spezifikation."
        }
      }
    },
    {
      "slug": "sandbox-data-tools",
      "llms_path": "setup.md",
      "audience": "operator",
      "section": "operate",
      "order": 10,
      "generated": false,
      "locales": {
        "en": {
          "title": "Sandbox data tools",
          "summary": "Calculate, parse and validate data in JavaScript transforms with built-in helpers.",
          "headings": [
            {
              "depth": 2,
              "text": "Sandbox data tools",
              "anchor": "sandbox-data-tools"
            },
            {
              "depth": 3,
              "text": "Limits and operation",
              "anchor": "limits-and-operation"
            }
          ],
          "images": [],
          "sha256": "c0151efdb861163772ffd2437c8b9bf3af359fe1ebc82d9850b23bbca20ba401",
          "body": "## Sandbox data tools\n\nIn a JavaScript transform step you calculate, parse and validate data with the built-in `sk` helpers. You need them when a workflow calculates amounts, reads CSV or XML, converts times across time zones or validates input. Afterwards you know what each helper does and where its limits are.\n\nThe helpers run synchronously and bounded inside the sandbox, the isolated runtime of the step. They never access the network, filesystem or credentials. Their namespaces are immutable. Promises and unseeded randomness are unsupported; for repeatable values use the execution clock and `sk.uuid()`.\n\n| Task | Helpers | Rules |\n| --- | --- | --- |\n| Decimal amounts | `sk.money.add/sub/mul/div/round/compare` | Decimal strings; `div` and `round` require scale and `down`, `halfUp`, `halfEven` or `up`. No currency conversion. |\n| CSV | `sk.csv.parse/stringify` | Explicit delimiter/header options; export escapes spreadsheet formulas by default. Up to 10,000 rows. |\n| Dates | `sk.date.parse/format/add/startOf/convertZone` | Date-only values stay dates. Local datetimes require an IANA zone; ambiguous or missing DST times require explicit `earlier`/`later`. |\n| Validation | `sk.schema.validate/assert`, `sk.assert` | Local schema references only; no remote resolution or asynchronous validators. |\n| URLs | `sk.url.parse/build/query/encode/decode` | WHATWG parsing, repeated query entries, UTF-8 percent encoding. No requests. |\n| XML | `sk.xml.parse/build` | Ordered `{name, attributes, children}` trees retain mixed text; no DTD or custom entities. |\n| Text and records | `sk.template.render`, `sk.diff.records` | Escaped HTML by default, explicit text mode; bounded list sections. Record diff requires a unique key. |\n\n```javascript\nreturn {\n  total: sk.money.add(\"19.90\", \"4.95\"),\n  csv: sk.csv.stringify([{ name: \"Ada\", amount: \"24.85\" }]),\n  tomorrow: sk.date.add(\"2024-02-28\", 1, \"days\"),\n  greeting: sk.template.render(\"Hello {{name}}\", { name: \"Ada\" })\n};\n```\n\n### Limits and operation\n\nText inputs and outputs are limited to 1 MiB, structures to 100,000 nodes and\n64 levels. Existing sandbox memory, execution and output budgets still apply.\nEach helper is embedded and loaded only on first access in each sandbox.\nPackage versions and timezone data are pinned for each release. The helpers do not\nbring document rendering, OCR or a browser.\n\nJavaScript transforms, JSONata and binary parsing run in bounded worker processes.\nThe default lane runs up to two workers in parallel; hooks have a separate lane.\nPer engine process, global and per-tenant queue limits apply across both lanes.\nOn Linux an RSS watchdog polls memory use regularly.\nIt is not a kernel-enforced memory ceiling."
        },
        "de": {
          "title": "Sandbox-Datenwerkzeuge",
          "summary": "Rechne, zerlege und prüfe Daten in JavaScript-Umformungen mit eingebauten Helfern.",
          "headings": [
            {
              "depth": 2,
              "text": "Sandbox-Datenwerkzeuge",
              "anchor": "sandbox-datenwerkzeuge"
            },
            {
              "depth": 3,
              "text": "Grenzen und Betrieb",
              "anchor": "grenzen-und-betrieb"
            }
          ],
          "images": [],
          "sha256": "4e4cc28853eac185b5150ae0ce0e51b81397b8e4f65ade452d92b9a6ef2b6f5d",
          "body": "## Sandbox-Datenwerkzeuge\n\nIn einem Umformungs-Schritt mit JavaScript rechnest, zerlegst und prüfst du Daten mit den eingebauten `sk`-Helfern. Du brauchst sie, wenn ein Workflow Beträge rechnet, CSV oder XML liest, Zeiten über Zeitzonen umrechnet oder Eingaben prüft. Danach weißt du, was jeder Helfer kann und wo seine Grenzen liegen.\n\nDie Helfer laufen synchron und begrenzt in der Sandbox, der abgeschotteten Laufzeit des Schritts. Sie greifen nie auf Netzwerk, Dateisystem oder Zugangsdaten zu. Die Namensräume der Helfer sind unveränderlich. Promises und Zufallswerte ohne festen Startwert werden nicht unterstützt; für wiederholbare Werte nimmst du die Ausführungsuhr und `sk.uuid()`.\n\n| Aufgabe | Helfer | Regeln |\n| --- | --- | --- |\n| Dezimalbeträge | `sk.money.add/sub/mul/div/round/compare` | Dezimalzeichenketten; `div` und `round` erfordern Skalierung und `down`, `halfUp`, `halfEven` oder `up`. Keine Währungsumrechnung. |\n| CSV | `sk.csv.parse/stringify` | Explizite Trennzeichen-/Header-Optionen; der Export maskiert Tabellenkalkulationsformeln standardmäßig. Bis zu 10.000 Zeilen. |\n| Datum | `sk.date.parse/format/add/startOf/convertZone` | Reine Datumswerte bleiben Daten. Lokale Zeitangaben erfordern eine IANA-Zone; mehrdeutige oder fehlende Sommerzeit-Zeiten erfordern ausdrücklich `earlier`/`later`. |\n| Validierung | `sk.schema.validate/assert`, `sk.assert` | Nur lokale Schema-Verweise; keine Auflösung aus der Ferne und keine asynchronen Validatoren. |\n| URLs | `sk.url.parse/build/query/encode/decode` | WHATWG-Parsing, wiederholte Query-Einträge, UTF-8-Prozentkodierung. Keine Anfragen. |\n| XML | `sk.xml.parse/build` | Geordnete `{name, attributes, children}`-Bäume behalten gemischten Text; kein DTD und keine eigenen Entitäten. |\n| Text und Datensätze | `sk.template.render`, `sk.diff.records` | Standardmäßig maskiertes HTML, expliziter Textmodus; begrenzte Listenabschnitte. Der Datensatzvergleich erfordert einen eindeutigen Schlüssel. |\n\n```javascript\nreturn {\n  total: sk.money.add(\"19.90\", \"4.95\"),\n  csv: sk.csv.stringify([{ name: \"Ada\", amount: \"24.85\" }]),\n  tomorrow: sk.date.add(\"2024-02-28\", 1, \"days\"),\n  greeting: sk.template.render(\"Hello {{name}}\", { name: \"Ada\" })\n};\n```\n\n### Grenzen und Betrieb\n\nText-Ein- und -Ausgaben sind auf 1 MiB begrenzt, Strukturen auf 100.000 Knoten und 64 Ebenen.\nDie bestehenden Sandbox-Budgets für Speicher, Ausführung und Ausgabe gelten weiterhin. Jeder\nHelfer ist eingebettet und wird in jeder Sandbox erst beim ersten Zugriff geladen.\nPaketversionen und Zeitzonendaten sind je Release festgeschrieben. Dokumenten-Rendering, OCR\noder einen Browser bringen die Helfer nicht mit.\n\nJavaScript-Umformungen, JSONata und Binär-Parsing laufen in begrenzten Worker-Prozessen. Die\nStandardspur führt bis zu zwei Worker parallel aus; Hooks haben eine eigene Spur.\nJe Engine-Prozess gelten globale Grenzen und Grenzen je Mandant (im Cockpit: Arbeitsbereich) für die Warteschlange, über beide\nSpuren hinweg. Unter Linux gibt es einen RSS-Watchdog, der den Speicherverbrauch regelmäßig abfragt.\nEr ist keine vom Kernel durchgesetzte Speicherobergrenze."
        }
      }
    },
    {
      "slug": "cli",
      "llms_path": "cli.md",
      "audience": "public",
      "section": "reference",
      "order": 1,
      "generated": true,
      "locales": {
        "en": {
          "title": "sk CLI reference",
          "summary": "Look up every sk command and argument here.",
          "headings": [
            {
              "depth": 1,
              "text": "sk CLI reference",
              "anchor": "sk-cli-reference"
            },
            {
              "depth": 2,
              "text": "Commands and arguments",
              "anchor": "commands-and-arguments"
            },
            {
              "depth": 3,
              "text": "`sk agent`",
              "anchor": "sk-agent"
            },
            {
              "depth": 4,
              "text": "`sk agent briefing`",
              "anchor": "sk-agent-briefing"
            },
            {
              "depth": 4,
              "text": "`sk agent capture`",
              "anchor": "sk-agent-capture"
            },
            {
              "depth": 4,
              "text": "`sk agent init`",
              "anchor": "sk-agent-init"
            },
            {
              "depth": 3,
              "text": "`sk apikeys`",
              "anchor": "sk-apikeys"
            },
            {
              "depth": 4,
              "text": "`sk apikeys create`",
              "anchor": "sk-apikeys-create"
            },
            {
              "depth": 4,
              "text": "`sk apikeys list`",
              "anchor": "sk-apikeys-list"
            },
            {
              "depth": 4,
              "text": "`sk apikeys revoke`",
              "anchor": "sk-apikeys-revoke"
            },
            {
              "depth": 4,
              "text": "`sk apikeys rotate`",
              "anchor": "sk-apikeys-rotate"
            },
            {
              "depth": 3,
              "text": "`sk apps`",
              "anchor": "sk-apps"
            },
            {
              "depth": 4,
              "text": "`sk apps erase-user`",
              "anchor": "sk-apps-erase-user"
            },
            {
              "depth": 4,
              "text": "`sk apps list`",
              "anchor": "sk-apps-list"
            },
            {
              "depth": 4,
              "text": "`sk apps show`",
              "anchor": "sk-apps-show"
            },
            {
              "depth": 3,
              "text": "`sk attach`",
              "anchor": "sk-attach"
            },
            {
              "depth": 3,
              "text": "`sk audit`",
              "anchor": "sk-audit"
            },
            {
              "depth": 4,
              "text": "`sk audit export`",
              "anchor": "sk-audit-export"
            },
            {
              "depth": 4,
              "text": "`sk audit query`",
              "anchor": "sk-audit-query"
            },
            {
              "depth": 4,
              "text": "`sk audit show`",
              "anchor": "sk-audit-show"
            },
            {
              "depth": 3,
              "text": "`sk auth`",
              "anchor": "sk-auth"
            },
            {
              "depth": 3,
              "text": "`sk branding`",
              "anchor": "sk-branding"
            },
            {
              "depth": 4,
              "text": "`sk branding get`",
              "anchor": "sk-branding-get"
            },
            {
              "depth": 4,
              "text": "`sk branding logo`",
              "anchor": "sk-branding-logo"
            },
            {
              "depth": 4,
              "text": "`sk branding reset`",
              "anchor": "sk-branding-reset"
            },
            {
              "depth": 4,
              "text": "`sk branding update`",
              "anchor": "sk-branding-update"
            },
            {
              "depth": 3,
              "text": "`sk categories`",
              "anchor": "sk-categories"
            },
            {
              "depth": 4,
              "text": "`sk categories list`",
              "anchor": "sk-categories-list"
            },
            {
              "depth": 4,
              "text": "`sk categories rename`",
              "anchor": "sk-categories-rename"
            },
            {
              "depth": 3,
              "text": "`sk chat`",
              "anchor": "sk-chat"
            },
            {
              "depth": 4,
              "text": "`sk chat install-space`",
              "anchor": "sk-chat-install-space"
            },
            {
              "depth": 4,
              "text": "`sk chat remove-space`",
              "anchor": "sk-chat-remove-space"
            },
            {
              "depth": 4,
              "text": "`sk chat spaces`",
              "anchor": "sk-chat-spaces"
            },
            {
              "depth": 3,
              "text": "`sk clipper`",
              "anchor": "sk-clipper"
            },
            {
              "depth": 4,
              "text": "`sk clipper install`",
              "anchor": "sk-clipper-install"
            },
            {
              "depth": 3,
              "text": "`sk connector-templates`",
              "anchor": "sk-connector-templates"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates create`",
              "anchor": "sk-connector-templates-create"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates delete`",
              "anchor": "sk-connector-templates-delete"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates list`",
              "anchor": "sk-connector-templates-list"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates recipe`",
              "anchor": "sk-connector-templates-recipe"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates recipe-pack`",
              "anchor": "sk-connector-templates-recipe-pack"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates recipes`",
              "anchor": "sk-connector-templates-recipes"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates search`",
              "anchor": "sk-connector-templates-search"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates set-oauth`",
              "anchor": "sk-connector-templates-set-oauth"
            },
            {
              "depth": 3,
              "text": "`sk connectors`",
              "anchor": "sk-connectors"
            },
            {
              "depth": 4,
              "text": "`sk connectors create`",
              "anchor": "sk-connectors-create"
            },
            {
              "depth": 4,
              "text": "`sk connectors delete`",
              "anchor": "sk-connectors-delete"
            },
            {
              "depth": 4,
              "text": "`sk connectors disable`",
              "anchor": "sk-connectors-disable"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-delete`",
              "anchor": "sk-connectors-docs-delete"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-ingest`",
              "anchor": "sk-connectors-docs-ingest"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-list`",
              "anchor": "sk-connectors-docs-list"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-search`",
              "anchor": "sk-connectors-docs-search"
            },
            {
              "depth": 4,
              "text": "`sk connectors enable`",
              "anchor": "sk-connectors-enable"
            },
            {
              "depth": 4,
              "text": "`sk connectors get`",
              "anchor": "sk-connectors-get"
            },
            {
              "depth": 4,
              "text": "`sk connectors import`",
              "anchor": "sk-connectors-import"
            },
            {
              "depth": 4,
              "text": "`sk connectors inspect`",
              "anchor": "sk-connectors-inspect"
            },
            {
              "depth": 4,
              "text": "`sk connectors list`",
              "anchor": "sk-connectors-list"
            },
            {
              "depth": 4,
              "text": "`sk connectors mcp-authorize`",
              "anchor": "sk-connectors-mcp-authorize"
            },
            {
              "depth": 4,
              "text": "`sk connectors mcp-inspect`",
              "anchor": "sk-connectors-mcp-inspect"
            },
            {
              "depth": 4,
              "text": "`sk connectors patch`",
              "anchor": "sk-connectors-patch"
            },
            {
              "depth": 4,
              "text": "`sk connectors probe`",
              "anchor": "sk-connectors-probe"
            },
            {
              "depth": 4,
              "text": "`sk connectors promote`",
              "anchor": "sk-connectors-promote"
            },
            {
              "depth": 4,
              "text": "`sk connectors test`",
              "anchor": "sk-connectors-test"
            },
            {
              "depth": 4,
              "text": "`sk connectors validate`",
              "anchor": "sk-connectors-validate"
            },
            {
              "depth": 3,
              "text": "`sk credentials`",
              "anchor": "sk-credentials"
            },
            {
              "depth": 4,
              "text": "`sk credentials delete`",
              "anchor": "sk-credentials-delete"
            },
            {
              "depth": 4,
              "text": "`sk credentials list`",
              "anchor": "sk-credentials-list"
            },
            {
              "depth": 4,
              "text": "`sk credentials rotate`",
              "anchor": "sk-credentials-rotate"
            },
            {
              "depth": 4,
              "text": "`sk credentials set`",
              "anchor": "sk-credentials-set"
            },
            {
              "depth": 3,
              "text": "`sk diagnostics`",
              "anchor": "sk-diagnostics"
            },
            {
              "depth": 4,
              "text": "`sk diagnostics errors`",
              "anchor": "sk-diagnostics-errors"
            },
            {
              "depth": 4,
              "text": "`sk diagnostics llm`",
              "anchor": "sk-diagnostics-llm"
            },
            {
              "depth": 4,
              "text": "`sk diagnostics setup`",
              "anchor": "sk-diagnostics-setup"
            },
            {
              "depth": 3,
              "text": "`sk discovery`",
              "anchor": "sk-discovery"
            },
            {
              "depth": 4,
              "text": "`sk discovery approve`",
              "anchor": "sk-discovery-approve"
            },
            {
              "depth": 4,
              "text": "`sk discovery artifacts`",
              "anchor": "sk-discovery-artifacts"
            },
            {
              "depth": 4,
              "text": "`sk discovery create`",
              "anchor": "sk-discovery-create"
            },
            {
              "depth": 4,
              "text": "`sk discovery get`",
              "anchor": "sk-discovery-get"
            },
            {
              "depth": 4,
              "text": "`sk discovery list`",
              "anchor": "sk-discovery-list"
            },
            {
              "depth": 4,
              "text": "`sk discovery reject`",
              "anchor": "sk-discovery-reject"
            },
            {
              "depth": 3,
              "text": "`sk doctor`",
              "anchor": "sk-doctor"
            },
            {
              "depth": 3,
              "text": "`sk events`",
              "anchor": "sk-events"
            },
            {
              "depth": 4,
              "text": "`sk events get`",
              "anchor": "sk-events-get"
            },
            {
              "depth": 4,
              "text": "`sk events list`",
              "anchor": "sk-events-list"
            },
            {
              "depth": 3,
              "text": "`sk executions`",
              "anchor": "sk-executions"
            },
            {
              "depth": 4,
              "text": "`sk executions abort`",
              "anchor": "sk-executions-abort"
            },
            {
              "depth": 4,
              "text": "`sk executions get`",
              "anchor": "sk-executions-get"
            },
            {
              "depth": 4,
              "text": "`sk executions list`",
              "anchor": "sk-executions-list"
            },
            {
              "depth": 4,
              "text": "`sk executions rerun`",
              "anchor": "sk-executions-rerun"
            },
            {
              "depth": 4,
              "text": "`sk executions result`",
              "anchor": "sk-executions-result"
            },
            {
              "depth": 4,
              "text": "`sk executions steps`",
              "anchor": "sk-executions-steps"
            },
            {
              "depth": 4,
              "text": "`sk executions tail`",
              "anchor": "sk-executions-tail"
            },
            {
              "depth": 3,
              "text": "`sk extract`",
              "anchor": "sk-extract"
            },
            {
              "depth": 3,
              "text": "`sk files`",
              "anchor": "sk-files"
            },
            {
              "depth": 4,
              "text": "`sk files delete`",
              "anchor": "sk-files-delete"
            },
            {
              "depth": 4,
              "text": "`sk files download`",
              "anchor": "sk-files-download"
            },
            {
              "depth": 4,
              "text": "`sk files get`",
              "anchor": "sk-files-get"
            },
            {
              "depth": 4,
              "text": "`sk files link`",
              "anchor": "sk-files-link"
            },
            {
              "depth": 4,
              "text": "`sk files list`",
              "anchor": "sk-files-list"
            },
            {
              "depth": 4,
              "text": "`sk files patch`",
              "anchor": "sk-files-patch"
            },
            {
              "depth": 4,
              "text": "`sk files replace`",
              "anchor": "sk-files-replace"
            },
            {
              "depth": 4,
              "text": "`sk files restore`",
              "anchor": "sk-files-restore"
            },
            {
              "depth": 4,
              "text": "`sk files stats`",
              "anchor": "sk-files-stats"
            },
            {
              "depth": 4,
              "text": "`sk files upload`",
              "anchor": "sk-files-upload"
            },
            {
              "depth": 4,
              "text": "`sk files versions`",
              "anchor": "sk-files-versions"
            },
            {
              "depth": 3,
              "text": "`sk health`",
              "anchor": "sk-health"
            },
            {
              "depth": 3,
              "text": "`sk hooks`",
              "anchor": "sk-hooks"
            },
            {
              "depth": 4,
              "text": "`sk hooks create`",
              "anchor": "sk-hooks-create"
            },
            {
              "depth": 4,
              "text": "`sk hooks delete`",
              "anchor": "sk-hooks-delete"
            },
            {
              "depth": 4,
              "text": "`sk hooks get`",
              "anchor": "sk-hooks-get"
            },
            {
              "depth": 4,
              "text": "`sk hooks list`",
              "anchor": "sk-hooks-list"
            },
            {
              "depth": 3,
              "text": "`sk init`",
              "anchor": "sk-init"
            },
            {
              "depth": 3,
              "text": "`sk install`",
              "anchor": "sk-install"
            },
            {
              "depth": 4,
              "text": "`sk install github`",
              "anchor": "sk-install-github"
            },
            {
              "depth": 4,
              "text": "`sk install google-workspace`",
              "anchor": "sk-install-google-workspace"
            },
            {
              "depth": 4,
              "text": "`sk install hubspot`",
              "anchor": "sk-install-hubspot"
            },
            {
              "depth": 4,
              "text": "`sk install jira`",
              "anchor": "sk-install-jira"
            },
            {
              "depth": 4,
              "text": "`sk install salesforce`",
              "anchor": "sk-install-salesforce"
            },
            {
              "depth": 4,
              "text": "`sk install slack`",
              "anchor": "sk-install-slack"
            },
            {
              "depth": 4,
              "text": "`sk install teams`",
              "anchor": "sk-install-teams"
            },
            {
              "depth": 3,
              "text": "`sk intake`",
              "anchor": "sk-intake"
            },
            {
              "depth": 4,
              "text": "`sk intake default`",
              "anchor": "sk-intake-default"
            },
            {
              "depth": 4,
              "text": "`sk intake discard`",
              "anchor": "sk-intake-discard"
            },
            {
              "depth": 4,
              "text": "`sk intake list`",
              "anchor": "sk-intake-list"
            },
            {
              "depth": 4,
              "text": "`sk intake move`",
              "anchor": "sk-intake-move"
            },
            {
              "depth": 4,
              "text": "`sk intake restore`",
              "anchor": "sk-intake-restore"
            },
            {
              "depth": 4,
              "text": "`sk intake review`",
              "anchor": "sk-intake-review"
            },
            {
              "depth": 3,
              "text": "`sk invites`",
              "anchor": "sk-invites"
            },
            {
              "depth": 4,
              "text": "`sk invites list`",
              "anchor": "sk-invites-list"
            },
            {
              "depth": 4,
              "text": "`sk invites revoke`",
              "anchor": "sk-invites-revoke"
            },
            {
              "depth": 3,
              "text": "`sk join`",
              "anchor": "sk-join"
            },
            {
              "depth": 3,
              "text": "`sk knowledge-sources`",
              "anchor": "sk-knowledge-sources"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources analyze`",
              "anchor": "sk-knowledge-sources-analyze"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources create`",
              "anchor": "sk-knowledge-sources-create"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources delete`",
              "anchor": "sk-knowledge-sources-delete"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources get`",
              "anchor": "sk-knowledge-sources-get"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources history`",
              "anchor": "sk-knowledge-sources-history"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources import`",
              "anchor": "sk-knowledge-sources-import"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources list`",
              "anchor": "sk-knowledge-sources-list"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources patch`",
              "anchor": "sk-knowledge-sources-patch"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources restore`",
              "anchor": "sk-knowledge-sources-restore"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources search`",
              "anchor": "sk-knowledge-sources-search"
            },
            {
              "depth": 3,
              "text": "`sk login`",
              "anchor": "sk-login"
            },
            {
              "depth": 3,
              "text": "`sk logout`",
              "anchor": "sk-logout"
            },
            {
              "depth": 3,
              "text": "`sk logs`",
              "anchor": "sk-logs"
            },
            {
              "depth": 3,
              "text": "`sk ls`",
              "anchor": "sk-ls"
            },
            {
              "depth": 3,
              "text": "`sk mcp`",
              "anchor": "sk-mcp"
            },
            {
              "depth": 3,
              "text": "`sk notifications`",
              "anchor": "sk-notifications"
            },
            {
              "depth": 4,
              "text": "`sk notifications channels`",
              "anchor": "sk-notifications-channels"
            },
            {
              "depth": 4,
              "text": "`sk notifications deliveries`",
              "anchor": "sk-notifications-deliveries"
            },
            {
              "depth": 4,
              "text": "`sk notifications inbox`",
              "anchor": "sk-notifications-inbox"
            },
            {
              "depth": 4,
              "text": "`sk notifications rules`",
              "anchor": "sk-notifications-rules"
            },
            {
              "depth": 3,
              "text": "`sk packages`",
              "anchor": "sk-packages"
            },
            {
              "depth": 4,
              "text": "`sk packages export`",
              "anchor": "sk-packages-export"
            },
            {
              "depth": 4,
              "text": "`sk packages import`",
              "anchor": "sk-packages-import"
            },
            {
              "depth": 4,
              "text": "`sk packages installs`",
              "anchor": "sk-packages-installs"
            },
            {
              "depth": 3,
              "text": "`sk patch-candidates`",
              "anchor": "sk-patch-candidates"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates approve`",
              "anchor": "sk-patch-candidates-approve"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates get`",
              "anchor": "sk-patch-candidates-get"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates list`",
              "anchor": "sk-patch-candidates-list"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates preview`",
              "anchor": "sk-patch-candidates-preview"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates reject`",
              "anchor": "sk-patch-candidates-reject"
            },
            {
              "depth": 3,
              "text": "`sk portal-tokens`",
              "anchor": "sk-portal-tokens"
            },
            {
              "depth": 4,
              "text": "`sk portal-tokens create`",
              "anchor": "sk-portal-tokens-create"
            },
            {
              "depth": 4,
              "text": "`sk portal-tokens list`",
              "anchor": "sk-portal-tokens-list"
            },
            {
              "depth": 4,
              "text": "`sk portal-tokens revoke`",
              "anchor": "sk-portal-tokens-revoke"
            },
            {
              "depth": 3,
              "text": "`sk profile`",
              "anchor": "sk-profile"
            },
            {
              "depth": 4,
              "text": "`sk profile add`",
              "anchor": "sk-profile-add"
            },
            {
              "depth": 4,
              "text": "`sk profile delete`",
              "anchor": "sk-profile-delete"
            },
            {
              "depth": 4,
              "text": "`sk profile list`",
              "anchor": "sk-profile-list"
            },
            {
              "depth": 4,
              "text": "`sk profile show`",
              "anchor": "sk-profile-show"
            },
            {
              "depth": 4,
              "text": "`sk profile use`",
              "anchor": "sk-profile-use"
            },
            {
              "depth": 3,
              "text": "`sk rbac`",
              "anchor": "sk-rbac"
            },
            {
              "depth": 4,
              "text": "`sk rbac can`",
              "anchor": "sk-rbac-can"
            },
            {
              "depth": 4,
              "text": "`sk rbac grants`",
              "anchor": "sk-rbac-grants"
            },
            {
              "depth": 4,
              "text": "`sk rbac groups`",
              "anchor": "sk-rbac-groups"
            },
            {
              "depth": 4,
              "text": "`sk rbac permissions`",
              "anchor": "sk-rbac-permissions"
            },
            {
              "depth": 4,
              "text": "`sk rbac request-hooks`",
              "anchor": "sk-rbac-request-hooks"
            },
            {
              "depth": 4,
              "text": "`sk rbac roles`",
              "anchor": "sk-rbac-roles"
            },
            {
              "depth": 4,
              "text": "`sk rbac users`",
              "anchor": "sk-rbac-users"
            },
            {
              "depth": 4,
              "text": "`sk rbac whatcan`",
              "anchor": "sk-rbac-whatcan"
            },
            {
              "depth": 3,
              "text": "`sk rename`",
              "anchor": "sk-rename"
            },
            {
              "depth": 3,
              "text": "`sk review`",
              "anchor": "sk-review"
            },
            {
              "depth": 3,
              "text": "`sk rm`",
              "anchor": "sk-rm"
            },
            {
              "depth": 3,
              "text": "`sk schedules`",
              "anchor": "sk-schedules"
            },
            {
              "depth": 4,
              "text": "`sk schedules create`",
              "anchor": "sk-schedules-create"
            },
            {
              "depth": 4,
              "text": "`sk schedules delete`",
              "anchor": "sk-schedules-delete"
            },
            {
              "depth": 4,
              "text": "`sk schedules list`",
              "anchor": "sk-schedules-list"
            },
            {
              "depth": 4,
              "text": "`sk schedules pause`",
              "anchor": "sk-schedules-pause"
            },
            {
              "depth": 4,
              "text": "`sk schedules resume`",
              "anchor": "sk-schedules-resume"
            },
            {
              "depth": 4,
              "text": "`sk schedules update`",
              "anchor": "sk-schedules-update"
            },
            {
              "depth": 3,
              "text": "`sk self-healing`",
              "anchor": "sk-self-healing"
            },
            {
              "depth": 4,
              "text": "`sk self-healing list`",
              "anchor": "sk-self-healing-list"
            },
            {
              "depth": 4,
              "text": "`sk self-healing scan`",
              "anchor": "sk-self-healing-scan"
            },
            {
              "depth": 4,
              "text": "`sk self-healing show`",
              "anchor": "sk-self-healing-show"
            },
            {
              "depth": 3,
              "text": "`sk sessions`",
              "anchor": "sk-sessions"
            },
            {
              "depth": 4,
              "text": "`sk sessions ls`",
              "anchor": "sk-sessions-ls"
            },
            {
              "depth": 4,
              "text": "`sk sessions rename`",
              "anchor": "sk-sessions-rename"
            },
            {
              "depth": 4,
              "text": "`sk sessions rm`",
              "anchor": "sk-sessions-rm"
            },
            {
              "depth": 4,
              "text": "`sk sessions search`",
              "anchor": "sk-sessions-search"
            },
            {
              "depth": 4,
              "text": "`sk sessions show`",
              "anchor": "sk-sessions-show"
            },
            {
              "depth": 3,
              "text": "`sk settings`",
              "anchor": "sk-settings"
            },
            {
              "depth": 4,
              "text": "`sk settings configure`",
              "anchor": "sk-settings-configure"
            },
            {
              "depth": 4,
              "text": "`sk settings get`",
              "anchor": "sk-settings-get"
            },
            {
              "depth": 4,
              "text": "`sk settings list`",
              "anchor": "sk-settings-list"
            },
            {
              "depth": 4,
              "text": "`sk settings set`",
              "anchor": "sk-settings-set"
            },
            {
              "depth": 3,
              "text": "`sk show`",
              "anchor": "sk-show"
            },
            {
              "depth": 3,
              "text": "`sk skill-candidates`",
              "anchor": "sk-skill-candidates"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates approve`",
              "anchor": "sk-skill-candidates-approve"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates get`",
              "anchor": "sk-skill-candidates-get"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates list`",
              "anchor": "sk-skill-candidates-list"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates reject`",
              "anchor": "sk-skill-candidates-reject"
            },
            {
              "depth": 3,
              "text": "`sk skills`",
              "anchor": "sk-skills"
            },
            {
              "depth": 4,
              "text": "`sk skills activate`",
              "anchor": "sk-skills-activate"
            },
            {
              "depth": 4,
              "text": "`sk skills archive`",
              "anchor": "sk-skills-archive"
            },
            {
              "depth": 4,
              "text": "`sk skills create`",
              "anchor": "sk-skills-create"
            },
            {
              "depth": 4,
              "text": "`sk skills delete`",
              "anchor": "sk-skills-delete"
            },
            {
              "depth": 4,
              "text": "`sk skills edit`",
              "anchor": "sk-skills-edit"
            },
            {
              "depth": 4,
              "text": "`sk skills get`",
              "anchor": "sk-skills-get"
            },
            {
              "depth": 4,
              "text": "`sk skills history`",
              "anchor": "sk-skills-history"
            },
            {
              "depth": 4,
              "text": "`sk skills list`",
              "anchor": "sk-skills-list"
            },
            {
              "depth": 4,
              "text": "`sk skills patch`",
              "anchor": "sk-skills-patch"
            },
            {
              "depth": 4,
              "text": "`sk skills restore`",
              "anchor": "sk-skills-restore"
            },
            {
              "depth": 4,
              "text": "`sk skills sync`",
              "anchor": "sk-skills-sync"
            },
            {
              "depth": 3,
              "text": "`sk stats`",
              "anchor": "sk-stats"
            },
            {
              "depth": 4,
              "text": "`sk stats chat`",
              "anchor": "sk-stats-chat"
            },
            {
              "depth": 4,
              "text": "`sk stats connectors`",
              "anchor": "sk-stats-connectors"
            },
            {
              "depth": 4,
              "text": "`sk stats conversations`",
              "anchor": "sk-stats-conversations"
            },
            {
              "depth": 4,
              "text": "`sk stats events`",
              "anchor": "sk-stats-events"
            },
            {
              "depth": 4,
              "text": "`sk stats executions`",
              "anchor": "sk-stats-executions"
            },
            {
              "depth": 4,
              "text": "`sk stats http`",
              "anchor": "sk-stats-http"
            },
            {
              "depth": 4,
              "text": "`sk stats llm`",
              "anchor": "sk-stats-llm"
            },
            {
              "depth": 4,
              "text": "`sk stats mcp`",
              "anchor": "sk-stats-mcp"
            },
            {
              "depth": 4,
              "text": "`sk stats operations`",
              "anchor": "sk-stats-operations"
            },
            {
              "depth": 3,
              "text": "`sk status`",
              "anchor": "sk-status"
            },
            {
              "depth": 3,
              "text": "`sk subscriptions`",
              "anchor": "sk-subscriptions"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions create`",
              "anchor": "sk-subscriptions-create"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions delete`",
              "anchor": "sk-subscriptions-delete"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions deliveries`",
              "anchor": "sk-subscriptions-deliveries"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions get`",
              "anchor": "sk-subscriptions-get"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions list`",
              "anchor": "sk-subscriptions-list"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions patch`",
              "anchor": "sk-subscriptions-patch"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions replay`",
              "anchor": "sk-subscriptions-replay"
            },
            {
              "depth": 3,
              "text": "`sk system`",
              "anchor": "sk-system"
            },
            {
              "depth": 4,
              "text": "`sk system restart`",
              "anchor": "sk-system-restart"
            },
            {
              "depth": 3,
              "text": "`sk system-accounts`",
              "anchor": "sk-system-accounts"
            },
            {
              "depth": 4,
              "text": "`sk system-accounts create`",
              "anchor": "sk-system-accounts-create"
            },
            {
              "depth": 4,
              "text": "`sk system-accounts delete`",
              "anchor": "sk-system-accounts-delete"
            },
            {
              "depth": 4,
              "text": "`sk system-accounts list`",
              "anchor": "sk-system-accounts-list"
            },
            {
              "depth": 3,
              "text": "`sk tenants`",
              "anchor": "sk-tenants"
            },
            {
              "depth": 3,
              "text": "`sk update`",
              "anchor": "sk-update"
            },
            {
              "depth": 3,
              "text": "`sk users`",
              "anchor": "sk-users"
            },
            {
              "depth": 4,
              "text": "`sk users create`",
              "anchor": "sk-users-create"
            },
            {
              "depth": 4,
              "text": "`sk users delete`",
              "anchor": "sk-users-delete"
            },
            {
              "depth": 4,
              "text": "`sk users get`",
              "anchor": "sk-users-get"
            },
            {
              "depth": 4,
              "text": "`sk users invite`",
              "anchor": "sk-users-invite"
            },
            {
              "depth": 4,
              "text": "`sk users list`",
              "anchor": "sk-users-list"
            },
            {
              "depth": 4,
              "text": "`sk users patch`",
              "anchor": "sk-users-patch"
            },
            {
              "depth": 3,
              "text": "`sk workflows`",
              "anchor": "sk-workflows"
            },
            {
              "depth": 4,
              "text": "`sk workflows create`",
              "anchor": "sk-workflows-create"
            },
            {
              "depth": 4,
              "text": "`sk workflows delete`",
              "anchor": "sk-workflows-delete"
            },
            {
              "depth": 4,
              "text": "`sk workflows dry-run`",
              "anchor": "sk-workflows-dry-run"
            },
            {
              "depth": 4,
              "text": "`sk workflows get`",
              "anchor": "sk-workflows-get"
            },
            {
              "depth": 4,
              "text": "`sk workflows history`",
              "anchor": "sk-workflows-history"
            },
            {
              "depth": 4,
              "text": "`sk workflows invoke-snippet`",
              "anchor": "sk-workflows-invoke-snippet"
            },
            {
              "depth": 4,
              "text": "`sk workflows list`",
              "anchor": "sk-workflows-list"
            },
            {
              "depth": 4,
              "text": "`sk workflows patch`",
              "anchor": "sk-workflows-patch"
            },
            {
              "depth": 4,
              "text": "`sk workflows preview`",
              "anchor": "sk-workflows-preview"
            },
            {
              "depth": 4,
              "text": "`sk workflows restore`",
              "anchor": "sk-workflows-restore"
            },
            {
              "depth": 4,
              "text": "`sk workflows run`",
              "anchor": "sk-workflows-run"
            },
            {
              "depth": 4,
              "text": "`sk workflows update`",
              "anchor": "sk-workflows-update"
            },
            {
              "depth": 4,
              "text": "`sk workflows validate`",
              "anchor": "sk-workflows-validate"
            }
          ],
          "images": [],
          "sha256": "74191ca8000f7755d96426ffafc68de428c4b2c482dbc0e74a467d3da13b0089",
          "body": "# sk CLI reference\n\nLook up every `sk` command and argument here. Creating or changing a\nworkflow, connector, knowledge source or skill also runs through `sk`:\nthe change is a file you can read and a command you can re-run.\n\nBare `sk` opens an interactive prompt. Every command below also runs in\nscripts and prints to stdout. `create --file`, `update --file`, `validate`,\n`preview` and `probe` check a definition *before* it is saved. A mistake\nthen costs an error message, not a half-built connector someone has to\nclean up.\n\nThe `requires` column names the permission that shows a command in\n`--help`. The engine checks permissions again on every API call.\n\n| command | requires | description | subcommands |\n| ------- | -------- | ----------- | ----------- |\n| `sk agent` | `skill:read` | Coding-agent integration: session briefings and hook setup | `briefing`, `capture`, `init` |\n| `sk apikeys` | `api_key:read` | Manage API keys | `create`, `list`, `revoke`, `rotate` |\n| `sk apps` | `settings:read` | The apps that sign their users in and call SubKit (products settings, sign-in providers, workflows, users, budget); erase-user removes one app user's SubKit data | `erase-user`, `list`, `show` |\n| `sk attach` | `file:write` | Upload a file and link it to a conversation (shortcut) | — |\n| `sk audit` | `audit:read` | Query the append-only audit log | `export`, `query`, `show` |\n| `sk auth` | `connector:write` | Start a connector's browser sign-in and print the URL to open. Works for every connector that signs in with an account — a web service or an MCP server; the engine names the route. | — |\n| `sk branding` | — | Read, update, reset, or download tenant branding | `get`, `logo`, `reset`, `update` |\n| `sk categories` | `workflow:read` | Show and rename the catalog categories shared by every kind | `list`, `rename` |\n| `sk chat` | `chat_workspace:read` | Manage external chat spaces (Google Chat / Slack) | `install-space`, `remove-space`, `spaces` |\n| `sk clipper` | — | Install the Chrome clipping extension | `install` |\n| `sk connector-templates` | `connector:read` | Manage connector templates | `create`, `delete`, `list`, `recipe`, `recipe-pack`, `recipes`, `search`, `set-oauth` |\n| `sk connectors` | `connector:read` | Manage connectors | `create`, `delete`, `disable`, `docs-delete`, `docs-ingest`, `docs-list`, `docs-search`, `enable`, `get`, `import`, `inspect`, `list`, `mcp-authorize`, `mcp-inspect`, `patch`, `probe`, `promote`, `test`, `validate` |\n| `sk credentials` | `credential:read` | Manage connector credentials | `delete`, `list`, `rotate`, `set` |\n| `sk diagnostics` | `audit:read` | Engine diagnostics: errors, LLM status, setup validation | `errors`, `llm`, `setup` |\n| `sk discovery` | `discovery:read` | Manage discovery runs and artifacts | `approve`, `artifacts`, `create`, `get`, `list`, `reject` |\n| `sk doctor` | — | Diagnose engine connectivity, authentication, and setup. Exits 0 (ok or warn) or 2 (blocked). | — |\n| `sk events` | `audit:read` | Query audit events | `get`, `list` |\n| `sk executions` | `execution:read` | Manage workflow executions | `abort`, `get`, `list`, `rerun`, `result`, `steps`, `tail` |\n| `sk extract` | `conversation:write` | Extract structured data from a file (LLM for text, native parsers for binary) | — |\n| `sk files` | `file:read` | Manage files (upload, download, link, …) | `delete`, `download`, `get`, `link`, `list`, `patch`, `replace`, `restore`, `stats`, `upload`, `versions` |\n| `sk health` | — | Runtime posture: liveness, token budget, failing runs, risk signals, schema drift, and process runtime. Use `sk doctor` for connectivity/setup. | — |\n| `sk hooks` | `inbound_hook:read` | Manage inbound webhook bindings | `create`, `delete`, `get`, `list` |\n| `sk init` | — | Complete first-run engine bootstrap (consumes the token printed at engine boot) | — |\n| `sk install` | `connector:write` | Guided setup for enterprise integrations | `github`, `google-workspace`, `hubspot`, `jira`, `salesforce`, `slack`, `teams` |\n| `sk intake` | `intake:read` | List collected items and start a selected Chat review | `default`, `discard`, `list`, `move`, `restore`, `review` |\n| `sk invites` | `identity:read` | Manage user-provisioning invites | `list`, `revoke` |\n| `sk join` | — | Redeem an invite to provision your personal API key (no login required) | — |\n| `sk knowledge-sources` | `knowledge:read` | Manage knowledge sources | `analyze`, `create`, `delete`, `get`, `history`, `import`, `list`, `patch`, `restore`, `search` |\n| `sk login` | — | Authenticate against a subkit engine | — |\n| `sk logout` | — | Drop the active profile | — |\n| `sk logs` | `audit:read` | Tail the engine's runtime log ring. --follow streams via SSE; --since accepts 5m / 2h / 1d / ISO-8601. | — |\n| `sk ls` | — | List cached conversation sessions for the active profile | — |\n| `sk mcp` | — | Run a stdio MCP server proxied to the engine | — |\n| `sk notifications` | `notification:read` | Manage notification channels, rules, deliveries, and the inbox | `channels`, `deliveries`, `inbox`, `rules` |\n| `sk packages` | `package:import` | Move this workspace to another engine: export a package archive, import one with a reviewed plan, list past imports | `export`, `import`, `installs` |\n| `sk patch-candidates` | `workflow:read` | Manage patch candidates | `approve`, `get`, `list`, `preview`, `reject` |\n| `sk portal-tokens` | `portal_token:read` | Manage portal tokens | `create`, `list`, `revoke` |\n| `sk profile` | — | Manage named profiles (environments) | `add`, `delete`, `list`, `show`, `use` |\n| `sk rbac` | `rbac:read` | Manage RBAC roles, permissions, grants, groups, and hooks | `can`, `grants`, `groups`, `permissions`, `request-hooks`, `roles`, `users`, `whatcan` |\n| `sk rename` | — | Assign or change a short alias for a session (used by `sk -r <alias>`) | — |\n| `sk review` | `workflow:read` | Aggregated approval digest: pending patch candidates, proposed skill candidates, and recent failed executions. | — |\n| `sk rm` | — | Drop a session from the local cache (the server-side conversation row is preserved) | — |\n| `sk schedules` | `workflow:read` | Scheduled workflow runs | `create`, `delete`, `list`, `pause`, `resume`, `update` |\n| `sk self-healing` | `workflow:write` | Trigger and review proactive drift scans (admin) | `list`, `scan`, `show` |\n| `sk sessions` | — | Manage locally-cached conversation sessions | `ls`, `rename`, `rm`, `search`, `show` |\n| `sk settings` | `settings:read` | List, read, write, or interactively configure engine settings (secrets always masked) | `configure`, `get`, `list`, `set` |\n| `sk show` | — | Show cached metadata for a session by id or alias | — |\n| `sk skill-candidates` | `skill:read` | Manage skill candidates | `approve`, `get`, `list`, `reject` |\n| `sk skills` | `skill:read` | Manage skills | `activate`, `archive`, `create`, `delete`, `edit`, `get`, `history`, `list`, `patch`, `restore`, `sync` |\n| `sk stats` | `stats:read` | Tenant-scoped runtime statistics (needs stats:read) | `chat`, `connectors`, `conversations`, `events`, `executions`, `http`, `llm`, `mcp`, `operations` |\n| `sk status` | — | Print the active profile + engine reachability | — |\n| `sk subscriptions` | `subscription:read` | Manage event subscriptions | `create`, `delete`, `deliveries`, `get`, `list`, `patch`, `replay` |\n| `sk system` | `system:restart` | Engine process operations (restart) | `restart` |\n| `sk system-accounts` | `identity:read` | Manage system accounts | `create`, `delete`, `list` |\n| `sk tenants` | — | List tenants you belong to or switch the active one | — |\n| `sk update` | — | Update sk CLI to the latest version from your engine, falling back to GitHub releases | — |\n| `sk users` | `identity:read` | Manage identity users | `create`, `delete`, `get`, `invite`, `list`, `patch` |\n| `sk workflows` | `workflow:read` | Manage workflows | `create`, `delete`, `dry-run`, `get`, `history`, `invoke-snippet`, `list`, `patch`, `preview`, `restore`, `run`, `update`, `validate` |\n\n## Commands and arguments\n\nEvery argument of every command. `<name>` is positional; `--name` is a flag.\n\n### `sk agent`\n\nCoding-agent integration: session briefings and hook setup\n\n#### `sk agent briefing`\n\nPrint or verify the domain-scoped session briefing for coding agents\n\n- `--domains` (string) — Comma-separated domain slugs (default: .sk/agent.json of the repo; without hooks, else the known domains the repository name names)\n- `--budget` (string) — Token budget for the briefing\n- `--hook` (default: false) — Hook mode for Codex and Claude Code: inject a repository briefing and show a non-blocking status or warning\n- `--json` (default: false) — JSON output\n\n#### `sk agent capture`\n\nSend a session transcript to the engine to collect learnings for review\n\n- `--transcript` (string) — Path to the transcript file (JSONL or text)\n- `--domains` (string) — Comma-separated domain slugs (default: .sk/agent.json of the repo)\n- `--agent` (string, default: claude-code) — Producing agent name\n- `--session-id` (string) — Session id for evidence attribution\n- `--hook` (default: false) — SessionEnd/Stop-hook mode: read hook JSON from stdin, never fail\n- `--detach` (default: false) — Process the hook payload in a detached process\n- `--json` (default: false) — JSON output\n\n#### `sk agent init`\n\nSet up automatic SubKit briefings for this repository in Claude Code and Codex\n\n- `--domains` (string, required) — Comma-separated domains for this repository (e.g. accounting, blog-de)\n- `--budget` (string) — Optional token budget for each briefing\n- `--skip-claude` (default: false) — Do not touch ~/.claude/settings.json\n- `--skip-codex` (default: false) — Do not touch ~/.codex/hooks.json\n\n\n### `sk apikeys`\n\nManage API keys\n\n#### `sk apikeys create`\n\nIssue a new API key (shown once)\n\n- `--name` (string) — Friendly key name (label)\n- `--expires` (string) — Expiry — ISO-8601 timestamp\n- `--scopes` (string) — Comma-separated scope strings (e.g. \"workflow:read,workflow:run\"). Defaults to your own credential's scopes; [\"*\"] (full role-derived access, and read-and-execute over MCP) only when your credential has no scope limits. Add \"mcp:authoring\" for a key that may also author definitions over MCP (a coding agent); leave it off for a key going into a browser client.\n- `--allowed-workflows` (string) — Comma-separated workflow ids/slugs. Use \"*\" for explicit \"all\".\n- `--allowed-connectors` (string) — Comma-separated connector ids/slugs. Use \"*\" for explicit \"all\".\n\n#### `sk apikeys list`\n\nList API keys\n\n- `--json` — JSON output\n\n#### `sk apikeys revoke`\n\nRevoke an API key\n\n- `<id>` (positional, required) — Key id\n\n#### `sk apikeys rotate`\n\nRotate an API key (new key shown once)\n\n- `<id>` (positional, required) — Key id\n\n\n### `sk apps`\n\nThe apps that sign their users in and call SubKit (products settings, sign-in providers, workflows, users, budget); erase-user removes one app user's SubKit data\n\n#### `sk apps erase-user`\n\nErase an app user: removes SubKit's own data about that person for this app; the account at the sign-in provider stays. Irreversible\n\n- `<app>` (positional, required) — App id (the product_id)\n- `<user>` (positional, required) — User id (listed by sk apps show <app>)\n- `--yes` (default: false) — Confirm the erasure without asking\n- `--json` (default: false) — JSON output\n\n#### `sk apps list`\n\nList the apps of this workspace with environment, users, budget today and readiness\n\n- `--json` (default: false) — JSON output\n\n#### `sk apps show`\n\nShow one app: settings, sign-in, workflows, users, today's budget and readiness with the next action\n\n- `<id>` (positional, required) — App id (the product_id)\n- `--json` (default: false) — JSON output\n\n\n### `sk attach`\n\nUpload a file and link it to a conversation (shortcut)\n\n- `<conversation-id>` (positional, required) — Conversation id (UUID)\n- `<path>` (positional, required) — Path to file\n- `--content-type` (string) — Override detected MIME type\n- `--slug` (string) — Optional slug for the link\n- `--role` (string) — Optional role for the link\n- `--quiet` (default: false) — Suppress progress output\n- `--json` (default: false) — JSON output\n\n\n### `sk audit`\n\nQuery the append-only audit log\n\n#### `sk audit export`\n\nStream audit log as NDJSON to stdout or a file\n\n- `--since` (string) — Lower bound — ISO-8601 timestamp\n- `--to` (string) — Exclusive UTC upper bound (ISO-8601)\n- `--action` (string) — Action name filter\n- `--actor` (string) — Actor id filter\n- `--actor-type` (string) — Actor kind\n- `--api-key-id` (string) — Recorded API key id\n- `--session-id` (string) — Recorded session id\n- `--access-type` (string) — Verified access type\n- `--oauth-client-id` (string) — Verified OAuth client id\n- `--request-source` (string) — Legacy recorded source (not verified)\n- `--origin-source` (string) — Verified initiating source\n- `--execution-source` (string) — Immediate server execution step\n- `--correlation-id` (string) — Trusted audit correlation id\n- `--resource-type` (string) — Resource type\n- `--resource-types` (string) — Comma-separated resource types\n- `--resource-id` (string) — Resource id\n- `--result` (string) — success, denied or error\n- `--trace-id` (string) — Trace id\n- `--execution-id` (string) — Recorded execution id\n- `--conversation-id` (string) — Recorded conversation id\n- `--workflow-id` (string) — Recorded workflow id\n- `--output` (string) — Output file path (default: stdout)\n\n#### `sk audit query`\n\nFilter the audit log\n\n- `--limit` (string) — Max rows\n- `--since` (string) — Lower bound — ISO-8601 timestamp or relative (e.g. 10m, 1h, 7d)\n- `--action` (string) — Action name filter\n- `--actor` (string) — Actor id filter\n- `--actor-type` (string) — Actor kind\n- `--api-key-id` (string) — Recorded API key id\n- `--session-id` (string) — Recorded session id\n- `--access-type` (string) — Verified access type\n- `--oauth-client-id` (string) — Verified OAuth client id\n- `--request-source` (string) — Legacy recorded source (not verified)\n- `--origin-source` (string) — Verified initiating source\n- `--execution-source` (string) — Immediate server execution step\n- `--correlation-id` (string) — Trusted audit correlation id\n- `--resource-type` (string) — Resource type\n- `--resource-types` (string) — Comma-separated resource types\n- `--resource-id` (string) — Filter by resource id\n- `--result` (string) — success, denied or error\n- `--trace-id` (string) — Trace id\n- `--execution-id` (string) — Recorded execution id\n- `--conversation-id` (string) — Recorded conversation id\n- `--workflow-id` (string) — Recorded workflow id\n- `--to` (string) — Exclusive UTC upper bound (ISO-8601)\n- `--cursor` (string) — Continue after a previous page (its next_cursor)\n- `--json` — JSON output\n\n#### `sk audit show`\n\nFetch one audit event by id\n\n- `<id>` (positional, required) — Audit event id\n\n\n### `sk auth`\n\nStart a connector's browser sign-in and print the URL to open. Works for every connector that signs in with an account — a web service or an MCP server; the engine names the route.\n\n- `--connector-id` (string, required) — Connector to reauthenticate\n- `--json` — Emit the full response as JSON\n\n\n### `sk branding`\n\nRead, update, reset, or download tenant branding\n\n#### `sk branding get`\n\nRead tenant branding\n\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n#### `sk branding logo`\n\nDownload normalized branding logo PNG\n\n- `<theme>` (positional, required) — light or dark\n- `--output` (string) — Output file, defaults to stdout\n- `--revision` (string)\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n#### `sk branding reset`\n\nReset branding at an expected revision\n\n- `<revision>` (positional, required)\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n#### `sk branding update`\n\nReplace branding from canonical JSON body (file or - for stdin)\n\n- `<input>` (positional, required) — JSON file or -\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n\n### `sk categories`\n\nShow and rename the catalog categories shared by every kind\n\n#### `sk categories list`\n\nList the catalog categories with how many workflows, connectors, knowledge sources, skills and files use each\n\n- `--json` — JSON output\n\n#### `sk categories rename`\n\nRename across all kinds with revision checks; preserve purpose ownership and merge into an existing target\n\n- `<from>` (positional, required) — Current category\n- `<to>` (positional, required) — New category\n- `--json` — JSON output\n\n\n### `sk chat`\n\nManage external chat spaces (Google Chat / Slack)\n\n#### `sk chat install-space`\n\nRegister a chat space with the engine (Google Chat / Slack)\n\n- `<platform>` (positional) — google_chat | slack\n- `<workspace_id>` (positional) — Native space id, e.g. spaces/<id> (Slack: team id T…)\n- `--bot-token` (string) — Slack bot token (xoxb-…) — required for slack\n- `--default-channel` (string) — Optional default channel\n- `--as` (string) — Installer platform user id (auto-filled from a pending space when omitted)\n- `--json` — JSON output\n\n#### `sk chat remove-space`\n\nRemove a chat-space install\n\n- `<id>` (positional) — Chat workspace row id\n- `--yes` — Skip confirmation\n- `--json` — JSON output\n\n#### `sk chat spaces`\n\nList chat spaces installed in this tenant\n\n- `--json` — JSON output\n\n\n### `sk clipper`\n\nInstall the Chrome clipping extension\n\n#### `sk clipper install`\n\nInstall the local Chrome clipping extension\n\n- `--dir` (string) — Installation directory\n- `--engine-url` (string) — Engine address (default: active profile)\n- `--open` (default: true) — Open Chrome extensions after installing\n\n\n### `sk connector-templates`\n\nManage connector templates\n\n#### `sk connector-templates create`\n\nCreate a connector template\n\n- `--file` (string) — Path to a full template JSON file\n- `--slug` (string) — Template slug (short-form convenience mode)\n- `--name` (string) — Template name (short-form convenience mode)\n- `--driver` (string) — Driver identifier (short-form convenience mode)\n\n#### `sk connector-templates delete`\n\nDelete a connector template\n\n- `<id>` (positional, required) — Template id\n\n#### `sk connector-templates list`\n\nList connector templates\n\n- `--json` — JSON output\n\n#### `sk connector-templates recipe`\n\nShow one recipe by slug (template slug + recipe slug)\n\n- `<slug>` (positional) — Template slug (e.g. stripe)\n- `<recipe>` (positional) — Recipe slug (e.g. list-customers)\n- `--json` — JSON output\n\n#### `sk connector-templates recipe-pack`\n\nShow the recipes in a vertical pack\n\n- `<vertical>` (positional) — Vertical (revops | customer-success | finance | data | devops | security | marketing | hr | solutions)\n- `--json` — JSON output\n\n#### `sk connector-templates recipes`\n\nList recipes shipped with a connector template\n\n- `<slug>` (positional) — Template slug (e.g. stripe, github)\n- `--json` — JSON output\n\n#### `sk connector-templates search`\n\nFuzzy-search connector templates by name/alias/keyword\n\n- `<query>` (positional, required) — Search text (e.g. 'hub')\n- `--limit` (string, default: 10) — Max results\n- `--json` — JSON output\n\n#### `sk connector-templates set-oauth`\n\nStore tenant-scoped OAuth client credentials for a connector template\n\n- `--slug` (string, required) — Template slug\n- `--client-id` (string, required) — OAuth client id\n- `--client-secret` (string, required) — OAuth client secret\n\n\n### `sk connectors`\n\nManage connectors\n\n#### `sk connectors create`\n\nCreate a connector from a template slug (--template) or a definition file (--file). --file runs validate and probe against the unsaved definition first, so a broken connector is never created; pass --skip-checks to bypass.\n\n- `--template` (string) — Template slug\n- `--file` (string) — Path to a connector definition JSON file\n- `--credential` (string) — Path to a credential JSON file used to sign the pre-save probe. Never stored — attach the credential with `sk credentials set` after create.\n- `--name` (string) — Override connector name (--template only)\n- `--skip-checks` — Skip the checks (NOT recommended).\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk connectors delete`\n\nDelete a connector\n\n- `<id>` (positional) — Connector id\n- `--yes` — Skip confirmation\n\n#### `sk connectors disable`\n\nDisable a connector. It keeps its configuration and credentials and stops being offered for use.\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors docs-delete`\n\nDelete a connector doc\n\n- `<id>` (positional, required) — Connector id\n- `<doc-id>` (positional, required) — Doc id\n\n#### `sk connectors docs-ingest`\n\nIngest docs from a URL into a connector\n\n- `<id>` (positional, required) — Connector id\n- `--url` (string, required) — URL to ingest\n\n#### `sk connectors docs-list`\n\nList ingested docs for a connector\n\n- `<id>` (positional, required) — Connector id\n- `--json` — JSON output\n\n#### `sk connectors docs-search`\n\nRanked search over connector docs\n\n- `<id>` (positional, required) — Connector id\n- `<query>` (positional, required) — Search query\n- `--limit` (string, default: 10) — Max results\n\n#### `sk connectors enable`\n\nEnable a connector (operator on switch)\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors get`\n\nGet a connector by id\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors import`\n\nTurn an API specification into a connector. Parses the spec, shows the draft it produced, then creates it after confirmation (--yes to skip). Nothing is saved until you agree.\n\n- `--spec` (string, required) — Path to the specification file, or a URL / curl command (see --source)\n- `--source` (string, required) — openapi | google_discovery | postman | har | graphql | graphql_introspection | curl\n- `--name` (string) — Override the connector name\n- `--environment` (string) — dev (default) or prod\n- `--yes` — Create without asking (for non-interactive use)\n- `--dry-run` — Print the draft and stop. Nothing is created.\n- `--json` — JSON-only output\n\n#### `sk connectors inspect`\n\nInspect a connector resource (alias of `get`).\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors list`\n\nList connectors, grouped into catalog blocks\n\n- `--limit` (string, default: 50) — Max rows\n- `--category` (string) — Only this catalog block\n- `--driver` (string) — Only this driver: http, graphql, postgres, s3, mcp\n- `--flat` — One flat table instead of grouped blocks\n- `--json` — JSON output\n\n#### `sk connectors mcp-authorize`\n\nmcp driver: begin the interactive OAuth 2.1 flow and print the URL to open in a browser.\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors mcp-inspect`\n\nmcp driver: force one handshake and list the tools, capabilities and instructions the remote actually serves.\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors patch`\n\nUpdate a connector, from --file (a partial definition: only the fields it names change) or from --name, --description and --category. --file runs validate first.\n\n- `<id>` (positional, required) — Connector id\n- `--file` (string) — Path to a partial definition JSON file\n- `--name` (string) — New name\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--skip-checks` — Skip validation (NOT recommended).\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk connectors probe`\n\nProbe a connector's upstream boundary. With an id, probes the saved connector (alias of `test`); with --file, probes an unsaved definition and saves nothing.\n\n- `<id>` (positional) — Connector id\n- `--file` (string) — Path to a connector definition JSON file — probes it without saving it\n- `--credential` (string) — Path to a credential JSON file. Signs this probe only; never stored. Required when the definition's auth_type is not 'none'.\n- `--json` — JSON-only output\n\n#### `sk connectors promote`\n\nPromote a connector and its credentials from DEV to PROD\n\n- `<id>` (positional) — DEV connector id\n- `--to` (string, default: prod) — Target environment (prod only)\n- `--strategy` (string, default: copy) — Promotion strategy: copy or move\n- `--idempotency-key` (string) — Stable retry key; generated when omitted\n- `--yes` — Confirm a move without prompting\n- `--json` — JSON output\n\n#### `sk connectors test`\n\nTest a connector connection (alias of `probe`). Exits non-zero when the probe fails.\n\n- `<id>` (positional) — Connector id\n- `--json` — JSON-only output\n\n#### `sk connectors validate`\n\nCheck a connector definition file against its driver's config schema. Saves nothing, reaches no upstream.\n\n- `<file>` (positional, required) — Path to a definition JSON file\n- `--json` — JSON-only output\n\n\n### `sk credentials`\n\nManage connector credentials\n\n#### `sk credentials delete`\n\nDelete a credential\n\n- `<credential-id>` (positional, required) — Credential id\n\n#### `sk credentials list`\n\nList credentials for a connector\n\n- `<connector-id>` (positional, required) — Connector id\n- `--json` — JSON output\n\n#### `sk credentials rotate`\n\nRotate a credential\n\n- `<credential-id>` (positional, required) — Credential id\n\n#### `sk credentials set`\n\nAttach a credential to a connector (scriptable; no conversation needed). Modes: bearer | header | query | basic | aws_sigv4 | signed_jwt | none.\n\n- `<connector-id>` (positional, required) — Connector id\n- `--mode` (string, required) — bearer | header | query | basic | aws_sigv4 | signed_jwt | none\n- `--private-key-file` (string) — signed_jwt: local PKCS#8 PEM file; contents are sent only to the credential endpoint\n- `--token` (string) — Secret token (bearer mode)\n- `--header` (string) — header mode: \"Name=Value\" (comma-separate multiple)\n- `--query` (string) — query mode: \"key=Value\" (comma-separate multiple)\n- `--username` (string) — basic mode username\n- `--password` (string) — basic mode password\n- `--access-key-id` (string) — aws_sigv4 access key id\n- `--secret-access-key` (string) — aws_sigv4 secret access key\n- `--session-token` (string) — aws_sigv4 optional STS session token\n- `--skip-checks` — Skip the post-set connectivity probe\n- `--json` — JSON-only output\n\n\n### `sk diagnostics`\n\nEngine diagnostics: errors, LLM status, setup validation\n\n#### `sk diagnostics errors`\n\nShow recent engine errors\n\n- `--limit` (string, default: 20) — Max rows\n- `--since` (string) — ISO timestamp lower bound\n- `--trace-id` (string) — Filter by trace id\n- `--tail` — Keep reading (not applicable — uses snapshot endpoint)\n- `--json` — JSON output\n\n#### `sk diagnostics llm`\n\nShow LLM diagnostics\n\n_No arguments._\n\n#### `sk diagnostics setup`\n\nValidate engine setup\n\n- `--json` — JSON output\n\n\n### `sk discovery`\n\nManage discovery runs and artifacts\n\n#### `sk discovery approve`\n\nApprove a discovery artifact\n\n- `<artifact-id>` (positional, required) — Artifact id\n\n#### `sk discovery artifacts`\n\nList artifacts for a discovery run\n\n- `<run-id>` (positional, required) — Run id\n- `--json` (default: false) — JSON output\n\n#### `sk discovery create`\n\nStart a discovery run from one or more files\n\n- `--file` (string, required) — File path(s), comma-separated\n- `--label` (string) — Optional label for the run\n\n#### `sk discovery get`\n\nGet a discovery run\n\n- `<run-id>` (positional, required) — Run id\n\n#### `sk discovery list`\n\nList discovery runs\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk discovery reject`\n\nReject a discovery artifact\n\n- `<artifact-id>` (positional, required) — Artifact id\n- `--reason` (string) — Rejection reason\n\n\n### `sk doctor`\n\nDiagnose engine connectivity, authentication, and setup. Exits 0 (ok or warn) or 2 (blocked).\n\n- `--engine-url` (string) — Override the resolved engine URL\n- `--api-key` (string) — Override the resolved API key\n- `--profile` (string) — Use a named profile\n- `--json` — Emit one JSON object instead of human output\n\n\n### `sk events`\n\nQuery audit events\n\n#### `sk events get`\n\nGet an audit event by id\n\n- `<id>` (positional, required) — Event id\n\n#### `sk events list`\n\nList audit events\n\n- `--limit` (string, default: 50) — Max rows\n- `--since` (string) — ISO timestamp lower bound\n- `--action` (string) — Filter by action\n- `--json` — JSON output\n\n\n### `sk executions`\n\nManage workflow executions\n\n#### `sk executions abort`\n\nAbort a running execution\n\n- `<id>` (positional) — Execution id\n\n#### `sk executions get`\n\nGet an execution by id\n\n- `<id>` (positional) — Execution id\n- `--json` (default: false) — JSON-only (skip Output files line)\n\n#### `sk executions list`\n\nList executions\n\n- `--limit` (string, default: 20) — Max rows\n- `--status` (string) — Filter by status\n- `--source` (string) — Filter by request source (e.g. scheduler, cli, api, mcp, chat)\n- `--parent` (string) — Lineage filter: list the reruns spawned from this execution id\n- `--from` (string) — Only runs that started at or after this instant (ISO-8601 or now-24h, now-7d, startOfMonth)\n- `--to` (string) — Only runs that started before this instant (exclusive; default: open)\n- `--cursor` (string) — Continue after a previous page (the next_cursor it printed)\n- `--json` (default: false) — JSON output\n\n#### `sk executions rerun`\n\nRe-run a previous execution against the workflow + input it carried. Useful after diagnose/repair.\n\n- `<id>` (positional) — Execution id to rerun\n- `--input` (string) — Override the original input (JSON string). Omit to reuse it verbatim.\n- `--follow` — Queue the rerun and stream its progress live (step-by-step JSON lines).\n\n#### `sk executions result`\n\nPrint the final output a workflow execution produced\n\n- `<id>` (positional) — Execution id\n- `--json` (default: false) — JSON-only output\n\n#### `sk executions steps`\n\nList steps for an execution\n\n- `<id>` (positional) — Execution id\n- `--json` (default: false) — JSON output\n\n#### `sk executions tail`\n\nStream live output from an execution\n\n- `<id>` (positional) — Execution id\n\n\n### `sk extract`\n\nExtract structured data from a file (LLM for text, native parsers for binary)\n\n- `<file>` (positional, required) — Path to sample file\n- `--hint` (string) — Hint to the LLM extractor (text inputs only)\n\n\n### `sk files`\n\nManage files (upload, download, link, …)\n\n#### `sk files delete`\n\nSoft-delete a file\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--force` (default: false) — Skip confirmation prompt\n\n#### `sk files download`\n\nDownload a file by id\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--output` (string) — Output path (default: ./<filename>, '-' for stdout)\n- `--quiet` (default: false) — Suppress progress output\n\n#### `sk files get`\n\nShow file metadata\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--json` (default: false) — JSON output\n\n#### `sk files link`\n\nAttach a file to an owning resource (conversation, knowledge_source, …)\n\n- `<fid>` (positional, required) — File id (fid_…)\n- `--to` (string, required) — Owning resource as <resource_type>:<id>\n- `--slug` (string) — Optional slug for the link\n- `--role` (string) — Optional role for the link\n\n#### `sk files list`\n\nList files\n\n- `--status` (string) — Filter by status (pending|ready|failed|…)\n- `--linked-to` (string) — Filter to files linked to <type>:<id> (e.g. conversation:abc-…)\n- `--cursor` (string) — Pagination cursor\n- `--limit` (string, default: 20) — Max rows (1-100)\n- `--json` (default: false) — JSON output\n\n#### `sk files patch`\n\nRename a file or change its description or category\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--filename` (string) — New filename\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--json` — JSON-only output\n\n#### `sk files replace`\n\nReplace a file's content (up to 5 MB); the id, reference and earlier versions stay\n\n- `<id>` (positional, required) — File id (fid_…)\n- `<path>` (positional, required) — Path to the new content\n- `--content-type` (string) — Override detected MIME type\n- `--json` (default: false) — JSON output\n\n#### `sk files restore`\n\nMake an earlier content version current again as a new version\n\n- `<id>` (positional, required) — File id (fid_…)\n- `<version>` (positional, required) — Version number to restore\n- `--json` (default: false) — JSON output\n\n#### `sk files stats`\n\nAggregate file counters for this tenant\n\n- `--by` (string) — Group by: status|scanner_verdict (default: status)\n- `--json` (default: false) — JSON output\n\n#### `sk files upload`\n\nUpload a file (inline ≤5 MB, authenticated streaming above)\n\n- `<path>` (positional, required) — Path to file\n- `--content-type` (string) — Override detected MIME type\n- `--no-dedup` (default: false) — Skip the client-side sha256 dedup probe (forces an upload)\n- `--link-to` (string) — After upload, link the file to <resource_type>:<id>\n- `--slug` (string) — Optional slug for the link\n- `--role` (string) — Optional role for the link\n- `--label` (string) — Reserved for future labels (no-op today)\n- `--quiet` (default: false) — Suppress progress output\n- `--json` (default: false) — JSON output (also silences progress)\n\n#### `sk files versions`\n\nList a file's current and earlier content versions\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--json` (default: false) — JSON output\n\n\n### `sk health`\n\nRuntime posture: liveness, token budget, failing runs, risk signals, schema drift, and process runtime. Use `sk doctor` for connectivity/setup.\n\n- `--engine-url` (string) — Engine base URL\n- `--window-hours` (string) — Lookback window for failing runs (default 24)\n- `--json` — JSON output (composite object)\n\n\n### `sk hooks`\n\nManage inbound webhook bindings\n\n#### `sk hooks create`\n\nCreate an inbound webhook binding. The signing secret is read from a file (or - for stdin), never from an argument.\n\n- `--slug` (string, required) — Public path: POST /v1/hooks/<slug>\n- `--workflow-id` (string, required) — Workflow id to bind\n- `--verifier` (string, default: standard) — Signature scheme: standard | github | stripe | hmac\n- `--secret-file` (string, required) — File holding the shared signing secret (- reads stdin)\n- `--config-file` (string) — JSON file for native_verifier_config, e.g. {\"hmac\": {...}} for the hmac verifier\n\n#### `sk hooks delete`\n\nDelete an inbound webhook binding\n\n- `<id>` (positional, required) — Hook id\n\n#### `sk hooks get`\n\nGet an inbound webhook binding\n\n- `<id>` (positional, required) — Hook id\n\n#### `sk hooks list`\n\nList inbound webhook bindings\n\n- `--json` — JSON output\n\n\n### `sk init`\n\nComplete first-run engine bootstrap (consumes the token printed at engine boot)\n\n- `--token` (string) — One-time bootstrap token printed by the engine on first boot\n- `--engine-url` (string) — Engine base URL (defaults to http://localhost:3000)\n- `--profile` (string) — Profile to write the new admin key into (default: default)\n- `--admin-email` (string) — Admin user email (skip prompt)\n- `--tenant-name` (string) — Tenant display name (skip prompt)\n- `--llm-provider` (string) — LLM provider: mock|anthropic|openai|gemini|azure|bedrock|vertex (skip prompt)\n- `--llm-api-key` (string) — LLM API key (skip prompt)\n- `--llm-model` (string) — Model id the key is checked with and saved as llm.model (Azure: deployment name; needed for azure and bedrock)\n- `--defaults` — Never prompt: fill anything still missing with local defaults (mock LLM provider, tenant 'Local', admin email from git config)\n\n\n### `sk install`\n\nGuided setup for enterprise integrations\n\n#### `sk install github`\n\nInstall GitHub connector\n\n_No arguments._\n\n#### `sk install google-workspace`\n\nInstall Google Workspace connector\n\n_No arguments._\n\n#### `sk install hubspot`\n\nInstall HubSpot connector\n\n_No arguments._\n\n#### `sk install jira`\n\nInstall Jira connector\n\n_No arguments._\n\n#### `sk install salesforce`\n\nInstall Salesforce connector\n\n_No arguments._\n\n#### `sk install slack`\n\nInstall Slack notifications\n\n_No arguments._\n\n#### `sk install teams`\n\nInstall Microsoft Teams notifications\n\n_No arguments._\n\n\n### `sk intake`\n\nList collected items and start a selected Chat review\n\n#### `sk intake default`\n\nSet your personal default intake category\n\n- `--category` (string, required) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake discard`\n\nDiscard an intake item\n\n- `--item` (string, required) — Intake item UUID\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake list`\n\nList collected intake items in one shared category\n\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake move`\n\nMove an intake item to a shared category\n\n- `--item` (string, required) — Intake item UUID\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake restore`\n\nRestore a discarded intake item\n\n- `--item` (string, required) — Intake item UUID\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake review`\n\nStart a selected intake review in authenticated Cockpit chat\n\n- `--category` (string) — Shared category name\n- `--items` (string) — Comma-separated item UUIDs\n- `--lang` (string) — Language of the review: de or en\n- `--json` — JSON output\n\n\n### `sk invites`\n\nManage user-provisioning invites\n\n#### `sk invites list`\n\nList provisioning invites\n\n- `--status` (string) — Filter by status: pending|redeemed|revoked|expired\n- `--json` — JSON output\n\n#### `sk invites revoke`\n\nRevoke an un-redeemed invite\n\n- `<id>` (positional, required) — Invite id\n\n\n### `sk join`\n\nRedeem an invite to provision your personal API key (no login required)\n\n- `--invite` (string, required) — Single-use invite token from your admin\n- `--engine-url` (string) — Engine base URL (defaults to http://localhost:3000)\n- `--profile` (string) — Profile to write the new key into (default: default)\n\n\n### `sk knowledge-sources`\n\nManage knowledge sources\n\n#### `sk knowledge-sources analyze`\n\nGenerate a description + tags for a knowledge source via the engine LLM\n\n- `<id>` (positional, required) — Knowledge source id\n- `--force` (default: false) — Overwrite an existing description\n\n#### `sk knowledge-sources create`\n\nUpload a file as a knowledge source\n\n- `--file` (string, required) — Path to file\n- `--name` (string) — Source name (defaults to the filename)\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--tags` (string) — Comma-separated tags. When set, they are authoritative (no AI auto-tagging). Omit --description and --category to let the engine describe the source.\n- `--scope` (string) — Scope: global | workflow\n- `--workflow-id` (string) — Workflow id (required when scope=workflow)\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk knowledge-sources delete`\n\nDelete a knowledge source\n\n- `<id>` (positional, required) — Knowledge source id\n\n#### `sk knowledge-sources get`\n\nGet a knowledge source by id\n\n- `<id>` (positional, required) — Knowledge source id\n\n#### `sk knowledge-sources history`\n\nShow a knowledge source's content versions (newest first)\n\n- `<id>` (positional, required) — Knowledge source id\n- `--limit` (string) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources import`\n\nImport a directory of markdown files as one knowledge source (upsert by slug; OKF-compatible frontmatter is read tolerantly)\n\n- `<dir>` (positional, required) — Directory to import\n- `--name` (string) — Source name (defaults to root index.md H1 or dirname)\n- `--slug` (string) — Stable slug (defaults to slugified name)\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--tags` (string) — Comma-separated extra tags (frontmatter tags merge in)\n- `--scope` (string) — Scope: global | workflow\n- `--workflow-id` (string) — Workflow id (required when scope=workflow)\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources list`\n\nList knowledge sources\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources patch`\n\nUpdate a knowledge source\n\n- `<id>` (positional, required) — Knowledge source id\n- `--name` (string) — New name\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--tags` (string) — Comma-separated tags (replaces existing)\n- `--status` (string) — Status: active | inactive\n\n#### `sk knowledge-sources restore`\n\nRestore an earlier content version; the result is a new version\n\n- `<id>` (positional, required) — Knowledge source id\n- `--to` (string, required) — Version number from `sk knowledge-sources history`\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources search`\n\nSemantic search across knowledge sources\n\n- `<query>` (positional, required) — Search query\n- `--tags` (string) — Comma-separated tags to narrow results\n- `--limit` (string, default: 10) — Max results\n- `--json` (default: false) — JSON output\n\n\n### `sk login`\n\nAuthenticate against a subkit engine\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — Scripted API-key login (skips device flow)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n- `--portal-token` (string) — Authenticate as a portal-token principal\n\n\n### `sk logout`\n\nDrop the active profile\n\n- `--profile` (string) — Profile name to clear (default: active)\n\n\n### `sk logs`\n\nTail the engine's runtime log ring. --follow streams via SSE; --since accepts 5m / 2h / 1d / ISO-8601.\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (audit:read required)\n- `--profile` (string) — Use a named profile\n- `--follow` (alias -f) — Live SSE tail (Ctrl-C to stop)\n- `--since` (string) — Start time — relative (5m, 2h, 1d), ISO-8601, or unix-ms\n- `--limit` (string) — Max entries when not following (default 200)\n- `--module` (string) — Filter by module name (e.g. migrate, scheduler)\n- `--action` (string) — Filter by action (e.g. drift_detected)\n- `--level` (string) — Minimum level (trace|debug|info|warn|error|fatal)\n- `--json` — Emit raw NDJSON for piping to jq, instead of pretty-printing\n\n\n### `sk ls`\n\nList cached conversation sessions for the active profile\n\n- `--limit` (string, default: 20) — Max rows\n- `--search` (string) — Filter by substring in title / alias\n- `--all` — Show every profile, not just the active one\n\n\n### `sk mcp`\n\nRun a stdio MCP server proxied to the engine\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (Bearer)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n\n\n### `sk notifications`\n\nManage notification channels, rules, deliveries, and the inbox\n\n#### `sk notifications channels`\n\nManage notification channels\n\n_No arguments._\n\n#### `sk notifications deliveries`\n\nNotification deliveries\n\n_No arguments._\n\n#### `sk notifications inbox`\n\nRead and acknowledge queued notifications\n\n- `--all` — Show everything queued, ignoring the stored cursor\n- `--unread` — Only tasks you have not marked read\n- `--actionable` — Only tasks that need someone to act\n- `--limit` (string) — Max rows (<=500)\n- `--json` — JSON output\n\n#### `sk notifications rules`\n\nManage notification rules\n\n_No arguments._\n\n\n### `sk packages`\n\nMove this workspace to another engine: export a package archive, import one with a reviewed plan, list past imports\n\n#### `sk packages export`\n\nExport this workspace as a package archive (workflows, connectors without credentials, templates, skills, schedules, knowledge, files)\n\n- `--out` (string, required) — Path of the archive to write\n- `--only` (string) — Comma-separated kinds to export (connector_template, connector, file, skill, workflow, schedule, knowledge)\n- `--category` (string) — Comma-separated catalog categories to export, one area per package\n- `--json` — JSON output\n- `--profile` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n#### `sk packages import`\n\nImport a package archive: shows the plan, asks for confirmation (--yes to skip), then applies exactly that plan\n\n- `<file>` (positional, required) — Package archive (.zip)\n- `--yes` — Apply without asking\n- `--json` — JSON output\n- `--profile` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n#### `sk packages installs`\n\nList past package imports, or show one with its items\n\n- `<id>` (positional) — Install id\n- `--json` — JSON output\n- `--profile` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n\n### `sk patch-candidates`\n\nManage patch candidates\n\n#### `sk patch-candidates approve`\n\nApprove a patch candidate\n\n- `<id>` (positional, required) — Patch candidate id\n- `--review-digest` (string, required) — Digest from the reviewed candidate preview\n\n#### `sk patch-candidates get`\n\nGet a patch candidate by id\n\n- `<id>` (positional, required) — Patch candidate id\n\n#### `sk patch-candidates list`\n\nList patch candidates\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk patch-candidates preview`\n\nReview the exact repair diff and approval digest\n\n- `<id>` (positional, required) — Patch candidate id\n\n#### `sk patch-candidates reject`\n\nReject a patch candidate\n\n- `<id>` (positional, required) — Patch candidate id\n- `--reason` (string) — Rejection reason\n\n\n### `sk portal-tokens`\n\nManage portal tokens\n\n#### `sk portal-tokens create`\n\nIssue a portal token (shown once)\n\n- `--name` (string, required) — Token name\n- `--user-id` (string) — User id to bind the token to\n- `--expires` (string) — Expiry — ISO-8601 timestamp\n\n#### `sk portal-tokens list`\n\nList portal tokens\n\n- `--json` — JSON output\n\n#### `sk portal-tokens revoke`\n\nRevoke a portal token\n\n- `<id>` (positional, required) — Token id\n\n\n### `sk profile`\n\nManage named profiles (environments)\n\n#### `sk profile add`\n\nCreate a new profile (guided setup)\n\n- `--name` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n#### `sk profile delete`\n\nDelete a saved profile\n\n- `<name>` (positional, required) — Profile name to delete\n\n#### `sk profile list`\n\nList all saved profiles\n\n_No arguments._\n\n#### `sk profile show`\n\nShow profile details + health check\n\n- `<name>` (positional) — Profile name (default: active)\n\n#### `sk profile use`\n\nSwitch the active profile\n\n- `<name>` (positional) — Profile name to activate\n\n\n### `sk rbac`\n\nManage RBAC roles, permissions, grants, groups, and hooks\n\n#### `sk rbac can`\n\nCheck whether a principal holds a permission\n\n- `<principal>` (positional, required) — Principal id\n- `<permission>` (positional, required) — Permission name\n- `<resource>` (positional) — Optional resource in <type>:<id> form\n- `--json` — JSON output\n\n#### `sk rbac grants`\n\nManage resource grants\n\n_No arguments._\n\n#### `sk rbac groups`\n\nManage groups\n\n_No arguments._\n\n#### `sk rbac permissions`\n\nBrowse the permission catalog\n\n_No arguments._\n\n#### `sk rbac request-hooks`\n\nManage before-request hooks\n\n_No arguments._\n\n#### `sk rbac roles`\n\nManage RBAC roles\n\n_No arguments._\n\n#### `sk rbac users`\n\nManage user role bindings\n\n_No arguments._\n\n#### `sk rbac whatcan`\n\nShow your effective access level on a connector (none/read-only/read-write)\n\n- `<connector>` (positional, required) — Connector id\n- `--json` — JSON output\n\n\n### `sk rename`\n\nAssign or change a short alias for a session (used by `sk -r <alias>`)\n\n- `<ref>` (positional, required) — Conversation id or existing alias\n- `<alias>` (positional, required) — New alias\n\n\n### `sk review`\n\nAggregated approval digest: pending patch candidates, proposed skill candidates, and recent failed executions.\n\n- `--limit` (string, default: 10) — Max rows per section\n- `--json` (default: false) — JSON output\n\n\n### `sk rm`\n\nDrop a session from the local cache (the server-side conversation row is preserved)\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n\n### `sk schedules`\n\nScheduled workflow runs\n\n#### `sk schedules create`\n\nSchedule a workflow (a workflow carries at most one schedule; re-create updates it)\n\n- `--workflow` (string, required) — Workflow id\n- `--cron` (string, required) — 5-field cron or \"every:<seconds>\" (e.g. \"0 8 * * *\")\n- `--timezone` (string) — IANA timezone (default UTC)\n- `--executionMode` (string, default: prod) — Connector environment: dev or prod (default prod)\n- `--paused` (default: false) — Create in paused state\n- `--input` (string) — JSON input payload passed to every run\n- `--json` (default: false) — JSON output\n\n#### `sk schedules delete`\n\nDelete a schedule\n\n- `<id>` (positional, required) — Schedule id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules list`\n\nList scheduled workflow runs\n\n- `--workflow` (string) — Filter by workflow id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules pause`\n\nPause a schedule (keeps the row)\n\n- `<id>` (positional, required) — Schedule id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules resume`\n\nResume a paused schedule\n\n- `<id>` (positional, required) — Schedule id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules update`\n\nUpdate a schedule's cron, timezone, environment, or input\n\n- `<id>` (positional, required) — Schedule id\n- `--cron` (string) — New cron expression\n- `--timezone` (string) — New IANA timezone\n- `--executionMode` (string) — New connector environment: dev or prod\n- `--input` (string) — New JSON input payload\n- `--json` (default: false) — JSON output\n\n\n### `sk self-healing`\n\nTrigger and review proactive drift scans (admin)\n\n#### `sk self-healing list`\n\nList proactive drift scans\n\n- `--limit` (string, default: 20) — Max rows\n- `--status` (string) — Filter by status (running/succeeded/failed)\n- `--source` (string) — Filter by source (scheduler/admin_http/mcp)\n- `--json` (default: false) — JSON output\n\n#### `sk self-healing scan`\n\nTrigger a proactive self-healing drift scan\n\n- `--workflow` (string) — Scope validation-drift to this workflow id\n- `--connector` (string) — Scope schema-drift to this connector id\n- `--idempotency-key` (string) — Replay-safe key; a second call within 24h with the same key returns the original result\n- `--json` (default: false) — JSON output\n\n#### `sk self-healing show`\n\nShow a proactive drift scan by id\n\n- `<id>` (positional, required) — Scan id\n\n\n### `sk sessions`\n\nManage locally-cached conversation sessions\n\n#### `sk sessions ls`\n\nList cached conversation sessions for the active profile\n\n- `--limit` (string, default: 20) — Max rows\n- `--search` (string) — Filter by substring in title / alias\n- `--all` — Show every profile, not just the active one\n\n#### `sk sessions rename`\n\nAssign or change a short alias for a session (used by `sk -r <alias>`)\n\n- `<ref>` (positional, required) — Conversation id or existing alias\n- `<alias>` (positional, required) — New alias\n\n#### `sk sessions rm`\n\nDrop a session from the local cache (the server-side conversation row is preserved)\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n#### `sk sessions search`\n\nFuzzy-search cached sessions by title / alias / id\n\n- `<query>` (positional, required) — Search text\n- `--limit` (string, default: 20) — Max rows\n- `--all` — Search every profile, not just the active one\n\n#### `sk sessions show`\n\nShow cached metadata for a session by id or alias\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n\n### `sk settings`\n\nList, read, write, or interactively configure engine settings (secrets always masked)\n\n#### `sk settings configure`\n\nInteractive Ink palette for inspecting settings (← / → cycles tabs, type to filter in Config, Enter to edit, Esc to exit). In non-TTY environments use --non-interactive to print the JSON contract instead.\n\n- `--tab` (string) — Open directly on a tab: Status | Config | Usage | Skills | Knowledge\n- `--non-interactive` — Skip the Ink renderer; print the GET /v1/settings response as JSON. Auto-detected when stdin is not a TTY.\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n#### `sk settings get`\n\nRead one leaf by dotted path\n\n- `<path>` (positional, required) — Setting path (e.g. llm.api_key)\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n#### `sk settings list`\n\nList every leaf with its resolved value\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n#### `sk settings set`\n\nWrite one leaf. <value> must be valid JSON ('\"abc\"', 42, true, null).\n\n- `<path>` (positional, required) — Setting path\n- `<value>` (positional, required) — Value as JSON\n- `--force` — Bypass requiresRestart guard in production\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n\n### `sk show`\n\nShow cached metadata for a session by id or alias\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n\n### `sk skill-candidates`\n\nManage skill candidates\n\n#### `sk skill-candidates approve`\n\nApprove a skill candidate\n\n- `<id>` (positional, required) — Candidate id\n\n#### `sk skill-candidates get`\n\nGet a skill candidate by id\n\n- `<id>` (positional, required) — Candidate id\n\n#### `sk skill-candidates list`\n\nList skill candidates\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk skill-candidates reject`\n\nReject a skill candidate\n\n- `<id>` (positional, required) — Candidate id\n- `--reason` (string) — Rejection reason\n\n\n### `sk skills`\n\nManage skills\n\n#### `sk skills activate`\n\nActivate a skill\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills archive`\n\nArchive a skill\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills create`\n\nCreate a skill from a JSON file\n\n- `--file` (string, required) — Path to SkillDef JSON\n\n#### `sk skills delete`\n\nDelete a skill\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills edit`\n\nUpdate a skill\n\n- `<id>` (positional, required) — Skill id\n- `--file` (string) — Path to JSON patch file\n- `--title` (string) — New title\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n\n#### `sk skills get`\n\nGet a skill by id\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills history`\n\nShow a skill's version history (newest first)\n\n- `<id>` (positional, required) — Skill id\n- `--json` (default: false) — JSON output\n\n#### `sk skills list`\n\nList skills\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk skills patch`\n\nUpdate a skill\n\n- `<id>` (positional, required) — Skill id\n- `--file` (string) — Path to JSON patch file\n- `--title` (string) — New title\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n\n#### `sk skills restore`\n\nRestore a skill to a prior audited snapshot\n\n- `<id>` (positional, required) — Skill id\n- `--to` (string, required) — audit_entry_id from `sk skills history`\n\n#### `sk skills sync`\n\nMaterialize domain skills as SKILL.md for Claude Code and Codex\n\n- `--domains` (string) — Comma-separated domain slugs (default: .sk/agent.json of the repo)\n- `--json` (default: false) — JSON output\n\n\n### `sk stats`\n\nTenant-scoped runtime statistics (needs stats:read)\n\n#### `sk stats chat`\n\nChat turns, modes, deduplication, and outcomes\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats connectors`\n\nConnector-call volume + latency + outcome. Example: sk stats connectors --bucket hour --from now-24h\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--connector-id` (string) — Filter by connector id\n- `--connector-slug` (string) — Filter by connector slug\n- `--driver` (string) — Filter by driver (comma-separated)\n- `--method` (string) — Filter by method (comma-separated)\n- `--outcome` (string) — Filter by outcome (success,denied,error)\n- `--status-class` (string) — 2xx,3xx,4xx_other,4xx_auth,4xx_rate_limited,5xx,network_error,no_status\n- `--include-endpoint` — Add normalized endpoint-path axis\n\n#### `sk stats conversations`\n\nConversation calls, streams, disconnects, and outcomes\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats events`\n\nAudit-event volume by class (webhook_outbound, webhook_inbound, chat, notification, schedule, self_healing, discovery, execution_lifecycle, policy, external_write). Example: sk stats events --class self_healing --bucket day --from now-7d\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--class` (string, required) — One of: webhook_outbound, webhook_inbound, chat, notification, schedule, self_healing, discovery, execution_lifecycle, policy, external_write\n- `--outcome` (string) — Filter by outcome (success,denied,error)\n\n#### `sk stats executions`\n\nWorkflow run volume + duration distribution. Example: sk stats executions --bucket hour --from now-24h\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--workflow-id` (string) — Filter by workflow id\n- `--status` (string) — Filter by status (comma-separated: succeeded,failed,…)\n- `--request-source` (string) — Filter by request source (open set, e.g. api,scheduler,wait_reaper)\n- `--execution-mode` (string) — dev|prod\n\n#### `sk stats http`\n\nHTTP route volume, latency, bytes, and errors\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats llm`\n\nLLM token usage + cache-hit + latency. Example: sk stats llm --bucket day --from startOfMonth\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--model` (string) — Filter by model (comma-separated)\n- `--flow` (string) — Filter by flow (comma-separated)\n- `--user-id` (string) — Scope to one user (another user needs stats:read:all)\n- `--mine` — Scope to your own usage (resolves your user id automatically)\n\n#### `sk stats mcp`\n\nMCP JSON-RPC, sessions, capacity, tasks, and SSE\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats operations`\n\nThe Übersicht's operations figures: runs, success rate, healthy connectors (now), applied repairs. Example: sk stats operations --window 7d\n\n- `--window` (string) — 24h (default), 7d or 30d\n- `--from` (string) — Window start (ISO-8601 or now-24h, startOfMonth)\n- `--to` (string) — Window end (default: now)\n- `--json` — Emit the raw engine response\n\n\n### `sk status`\n\nPrint the active profile + engine reachability\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (Bearer)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n\n\n### `sk subscriptions`\n\nManage event subscriptions\n\n#### `sk subscriptions create`\n\nCreate a subscription\n\n- `--event` (string, required) — Event type\n- `--workflow-id` (string, required) — Workflow id\n\n#### `sk subscriptions delete`\n\nDelete a subscription\n\n- `<id>` (positional, required) — Subscription id\n\n#### `sk subscriptions deliveries`\n\nShow deliveries for a subscription\n\n- `<id>` (positional, required) — Subscription id\n\n#### `sk subscriptions get`\n\nGet a subscription\n\n- `<id>` (positional, required) — Subscription id\n\n#### `sk subscriptions list`\n\nList subscriptions\n\n- `--json` — JSON output\n\n#### `sk subscriptions patch`\n\nUpdate a subscription\n\n- `<id>` (positional, required) — Subscription id\n- `--active` (string, required) — Set active state (true|false)\n\n#### `sk subscriptions replay`\n\nReplay a subscription delivery\n\n- `<sub-id>` (positional, required) — Subscription id\n- `<delivery-id>` (positional, required) — Delivery id\n\n\n### `sk system`\n\nEngine process operations (restart)\n\n#### `sk system restart`\n\nRestart the engine so a saved restart-sensitive setting takes effect (needs a supervisor)\n\n- `--wait` — Wait (up to 240 s) until the restarted engine runs the saved settings\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--json` — JSON output\n\n\n### `sk system-accounts`\n\nManage system accounts\n\n#### `sk system-accounts create`\n\nCreate a system account\n\n- `--name` (string, required) — Account name\n\n#### `sk system-accounts delete`\n\nDelete a system account\n\n- `<id>` (positional, required) — Account id\n\n#### `sk system-accounts list`\n\nList system accounts\n\n- `--json` — JSON output\n\n\n### `sk tenants`\n\nList tenants you belong to or switch the active one\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (Bearer)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n- `<use>` (positional) — Tenant id to switch to\n\n\n### `sk update`\n\nUpdate sk CLI to the latest version from your engine, falling back to GitHub releases\n\n- `--force` (default: false) — Force re-download even if already up to date\n- `--check` (default: false) — Check for updates without installing\n- `--channel` (string, default: stable) — Release channel: stable | beta\n- `--rollback` (default: false) — Restore the most recent retained sk binary\n- `--to` (string) — With --rollback, the explicit version to restore (default: most recent retained)\n\n\n### `sk users`\n\nManage identity users\n\n#### `sk users create`\n\nCreate a user in the caller's tenant\n\n- `--email` (string, required) — User email\n- `--role` (string) — Role: admin|member|enduser (default member)\n- `--json` — JSON output\n\n#### `sk users delete`\n\nDelete a user\n\n- `<id>` (positional, required) — User id\n\n#### `sk users get`\n\nFetch a user by id\n\n- `<id>` (positional, required) — User id\n\n#### `sk users invite`\n\nIssue a single-use provisioning invite for a user (token shown once)\n\n- `<id>` (positional, required) — User id to invite\n- `--scopes` (string) — Comma-separated scope strings (default: your own credential's scopes; [\"*\"] only when your credential has no scope limits)\n- `--allowed-workflows` (string) — Comma-separated workflow ids/slugs\n- `--allowed-connectors` (string) — Comma-separated connector ids/slugs\n- `--ttl` (string) — Invite lifetime in minutes\n- `--json` — JSON output\n\n#### `sk users list`\n\nList identity users\n\n- `--limit` (string) — Max rows\n- `--app` (string) — Only users who signed in to this app (product_id, see sk apps list)\n- `--json` — JSON output\n\n#### `sk users patch`\n\nUpdate a user's role (admin only)\n\n- `<id>` (positional, required) — User id\n- `--role` (string, required) — New role: admin|member|enduser\n\n\n### `sk workflows`\n\nManage workflows\n\n#### `sk workflows create`\n\nCreate a workflow from a JSON file (--file) or a solution recipe (--from-recipe <slug>, see `sk connector-templates recipe-pack solutions`). Runs `validate` and `preview` by default; pass --skip-checks to bypass.\n\n- `--file` (string) — Path to WorkflowDef JSON\n- `--from-recipe` (string) — Slug of a solution recipe; its connectors are bound to the ones you already have\n- `--bind` (string) — With --from-recipe: bind connectors yourself, as <template or placeholder>=<connector id or slug>[,…]; needed for templates without a fixed address such as http\n- `--environment` (string, default: dev) — Where the pre-flight preview runs: dev (default) or prod. Use the environment the workflow's schedule or webhook runs in; writes stay held either way.\n- `--skip-checks` — Skip the validate+preview pre-flight entirely (NOT recommended). Preview warnings never block; only validation errors and preview failures do.\n- `--input` (string) — Input JSON string passed to the preview dry-run. With --from-recipe it defaults to the recipe's sample input.\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk workflows delete`\n\nDelete a workflow\n\n- `<id>` (positional) — Workflow id\n\n#### `sk workflows dry-run`\n\nPreview a draft WorkflowDef by dry-running it via runExecution (source=draft). No persistence. Alias: dry-run.\n\n- `<file>` (positional, required) — Path to WorkflowDef JSON\n- `--input` (string) — Input JSON string\n- `--name` (string) — Optional label (goes to executions.source_ref)\n- `--environment` (string, default: dev) — Where the run executes: dev (default) or prod. Sent as the x-subkit-environment header; write steps need a connector bound to this environment.\n\n#### `sk workflows get`\n\nGet a workflow by id\n\n- `<id>` (positional) — Workflow id\n\n#### `sk workflows history`\n\nList committed versions of a workflow\n\n- `<id>` (positional, required) — Workflow id\n- `--json` — JSON output\n\n#### `sk workflows invoke-snippet`\n\nEmit a ready-to-paste, authenticated snippet to run a saved workflow from your own app or CI (curl/node/python).\n\n- `<id>` (positional, required) — Workflow id\n- `--lang` (string, default: curl) — Snippet language: curl (default), node, or python\n- `--environment` (string, default: prod) — Where the call runs: prod (default) or dev. Printed as the x-subkit-environment header.\n- `--json` — JSON output\n\n#### `sk workflows list`\n\nList workflows, grouped into catalog blocks\n\n- `--limit` (string, default: 50) — Max rows\n- `--category` (string) — Only this catalog block\n- `--connector` (string) — Only workflows using this connector (id or slug)\n- `--flat` — One flat table instead of grouped blocks\n- `--json` — JSON output\n\n#### `sk workflows patch`\n\nChange a workflow's name, description or category without saving a new version (the slug and its wf_<slug> tool stay as they are).\n\n- `<workflow>` (positional, required) — Workflow id or slug\n- `--name` (string) — New display name\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk workflows preview`\n\nPreview a draft WorkflowDef by dry-running it via runExecution (source=draft). No persistence. Alias: dry-run.\n\n- `<file>` (positional, required) — Path to WorkflowDef JSON\n- `--input` (string) — Input JSON string\n- `--name` (string) — Optional label (goes to executions.source_ref)\n- `--environment` (string, default: dev) — Where the run executes: dev (default) or prod. Sent as the x-subkit-environment header; write steps need a connector bound to this environment.\n\n#### `sk workflows restore`\n\nRestore a prior workflow version\n\n- `<id>` (positional, required) — Workflow id\n- `<version>` (positional, required) — Version number\n\n#### `sk workflows run`\n\nRun a saved workflow, an inline draft definition, or a single step\n\n- `<id>` (positional) — Workflow id or slug (omit when using --draft or --step)\n- `--input` (string) — Input JSON string. Prefix with `@` to read from a file (e.g. `--input @./payload.json`).\n- `--input-file` (string) — Upload a file and substitute its ref into --input at key K. Format: K=<path>. Repeatable.\n- `--draft` (string) — Path to a draft WorkflowDef JSON file (no commit)\n- `--step` (string) — Path to a single StepDef JSON file (no workflow persistence)\n- `--name` (string) — Optional label for --draft runs (goes to executions.source_ref)\n- `--slug` (string) — Optional workflow_slug for --step runs (cosmetic)\n- `--follow` — Queue the run and stream its progress live (step-by-step JSON lines). Saved workflows only.\n- `--idempotency-key` (string) — Make this trigger safe to repeat: a second run with the same key is not started, the first run's id comes back instead. Saved workflows only.\n- `--environment` (string, default: dev) — Where the run executes: dev (default) or prod. Sent as the x-subkit-environment header; write steps need a connector bound to this environment.\n\n#### `sk workflows update`\n\nUpdate a workflow from a JSON file (PUT the full definition). Runs `validate` and `preview` by default; pass --skip-checks to bypass. An unchanged definition does not rotate a version.\n\n- `<id>` (positional, required) — Workflow id\n- `--file` (string, required) — Path to WorkflowDef JSON\n- `--environment` (string, default: dev) — Where the pre-flight preview runs: dev (default) or prod. Use the environment the workflow's schedule or webhook runs in; writes stay held either way.\n- `--skip-checks` — Skip the validate+preview pre-flight entirely (NOT recommended). Preview warnings never block; only validation errors and preview failures do.\n- `--input` (string) — Input JSON string passed to the preview dry-run.\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk workflows validate`\n\nValidate a draft WorkflowDef JSON file (structural + step schema checks). No execution, no persistence.\n\n- `<file>` (positional, required) — Path to WorkflowDef JSON"
        },
        "de": {
          "title": "sk-CLI-Referenz",
          "summary": "Schlag jeden sk-Befehl mit seinen Argumenten nach.",
          "headings": [
            {
              "depth": 1,
              "text": "sk CLI reference",
              "anchor": "sk-cli-reference"
            },
            {
              "depth": 2,
              "text": "Commands and arguments",
              "anchor": "commands-and-arguments"
            },
            {
              "depth": 3,
              "text": "`sk agent`",
              "anchor": "sk-agent"
            },
            {
              "depth": 4,
              "text": "`sk agent briefing`",
              "anchor": "sk-agent-briefing"
            },
            {
              "depth": 4,
              "text": "`sk agent capture`",
              "anchor": "sk-agent-capture"
            },
            {
              "depth": 4,
              "text": "`sk agent init`",
              "anchor": "sk-agent-init"
            },
            {
              "depth": 3,
              "text": "`sk apikeys`",
              "anchor": "sk-apikeys"
            },
            {
              "depth": 4,
              "text": "`sk apikeys create`",
              "anchor": "sk-apikeys-create"
            },
            {
              "depth": 4,
              "text": "`sk apikeys list`",
              "anchor": "sk-apikeys-list"
            },
            {
              "depth": 4,
              "text": "`sk apikeys revoke`",
              "anchor": "sk-apikeys-revoke"
            },
            {
              "depth": 4,
              "text": "`sk apikeys rotate`",
              "anchor": "sk-apikeys-rotate"
            },
            {
              "depth": 3,
              "text": "`sk apps`",
              "anchor": "sk-apps"
            },
            {
              "depth": 4,
              "text": "`sk apps erase-user`",
              "anchor": "sk-apps-erase-user"
            },
            {
              "depth": 4,
              "text": "`sk apps list`",
              "anchor": "sk-apps-list"
            },
            {
              "depth": 4,
              "text": "`sk apps show`",
              "anchor": "sk-apps-show"
            },
            {
              "depth": 3,
              "text": "`sk attach`",
              "anchor": "sk-attach"
            },
            {
              "depth": 3,
              "text": "`sk audit`",
              "anchor": "sk-audit"
            },
            {
              "depth": 4,
              "text": "`sk audit export`",
              "anchor": "sk-audit-export"
            },
            {
              "depth": 4,
              "text": "`sk audit query`",
              "anchor": "sk-audit-query"
            },
            {
              "depth": 4,
              "text": "`sk audit show`",
              "anchor": "sk-audit-show"
            },
            {
              "depth": 3,
              "text": "`sk auth`",
              "anchor": "sk-auth"
            },
            {
              "depth": 3,
              "text": "`sk branding`",
              "anchor": "sk-branding"
            },
            {
              "depth": 4,
              "text": "`sk branding get`",
              "anchor": "sk-branding-get"
            },
            {
              "depth": 4,
              "text": "`sk branding logo`",
              "anchor": "sk-branding-logo"
            },
            {
              "depth": 4,
              "text": "`sk branding reset`",
              "anchor": "sk-branding-reset"
            },
            {
              "depth": 4,
              "text": "`sk branding update`",
              "anchor": "sk-branding-update"
            },
            {
              "depth": 3,
              "text": "`sk categories`",
              "anchor": "sk-categories"
            },
            {
              "depth": 4,
              "text": "`sk categories list`",
              "anchor": "sk-categories-list"
            },
            {
              "depth": 4,
              "text": "`sk categories rename`",
              "anchor": "sk-categories-rename"
            },
            {
              "depth": 3,
              "text": "`sk chat`",
              "anchor": "sk-chat"
            },
            {
              "depth": 4,
              "text": "`sk chat install-space`",
              "anchor": "sk-chat-install-space"
            },
            {
              "depth": 4,
              "text": "`sk chat remove-space`",
              "anchor": "sk-chat-remove-space"
            },
            {
              "depth": 4,
              "text": "`sk chat spaces`",
              "anchor": "sk-chat-spaces"
            },
            {
              "depth": 3,
              "text": "`sk clipper`",
              "anchor": "sk-clipper"
            },
            {
              "depth": 4,
              "text": "`sk clipper install`",
              "anchor": "sk-clipper-install"
            },
            {
              "depth": 3,
              "text": "`sk connector-templates`",
              "anchor": "sk-connector-templates"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates create`",
              "anchor": "sk-connector-templates-create"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates delete`",
              "anchor": "sk-connector-templates-delete"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates list`",
              "anchor": "sk-connector-templates-list"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates recipe`",
              "anchor": "sk-connector-templates-recipe"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates recipe-pack`",
              "anchor": "sk-connector-templates-recipe-pack"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates recipes`",
              "anchor": "sk-connector-templates-recipes"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates search`",
              "anchor": "sk-connector-templates-search"
            },
            {
              "depth": 4,
              "text": "`sk connector-templates set-oauth`",
              "anchor": "sk-connector-templates-set-oauth"
            },
            {
              "depth": 3,
              "text": "`sk connectors`",
              "anchor": "sk-connectors"
            },
            {
              "depth": 4,
              "text": "`sk connectors create`",
              "anchor": "sk-connectors-create"
            },
            {
              "depth": 4,
              "text": "`sk connectors delete`",
              "anchor": "sk-connectors-delete"
            },
            {
              "depth": 4,
              "text": "`sk connectors disable`",
              "anchor": "sk-connectors-disable"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-delete`",
              "anchor": "sk-connectors-docs-delete"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-ingest`",
              "anchor": "sk-connectors-docs-ingest"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-list`",
              "anchor": "sk-connectors-docs-list"
            },
            {
              "depth": 4,
              "text": "`sk connectors docs-search`",
              "anchor": "sk-connectors-docs-search"
            },
            {
              "depth": 4,
              "text": "`sk connectors enable`",
              "anchor": "sk-connectors-enable"
            },
            {
              "depth": 4,
              "text": "`sk connectors get`",
              "anchor": "sk-connectors-get"
            },
            {
              "depth": 4,
              "text": "`sk connectors import`",
              "anchor": "sk-connectors-import"
            },
            {
              "depth": 4,
              "text": "`sk connectors inspect`",
              "anchor": "sk-connectors-inspect"
            },
            {
              "depth": 4,
              "text": "`sk connectors list`",
              "anchor": "sk-connectors-list"
            },
            {
              "depth": 4,
              "text": "`sk connectors mcp-authorize`",
              "anchor": "sk-connectors-mcp-authorize"
            },
            {
              "depth": 4,
              "text": "`sk connectors mcp-inspect`",
              "anchor": "sk-connectors-mcp-inspect"
            },
            {
              "depth": 4,
              "text": "`sk connectors patch`",
              "anchor": "sk-connectors-patch"
            },
            {
              "depth": 4,
              "text": "`sk connectors probe`",
              "anchor": "sk-connectors-probe"
            },
            {
              "depth": 4,
              "text": "`sk connectors promote`",
              "anchor": "sk-connectors-promote"
            },
            {
              "depth": 4,
              "text": "`sk connectors test`",
              "anchor": "sk-connectors-test"
            },
            {
              "depth": 4,
              "text": "`sk connectors validate`",
              "anchor": "sk-connectors-validate"
            },
            {
              "depth": 3,
              "text": "`sk credentials`",
              "anchor": "sk-credentials"
            },
            {
              "depth": 4,
              "text": "`sk credentials delete`",
              "anchor": "sk-credentials-delete"
            },
            {
              "depth": 4,
              "text": "`sk credentials list`",
              "anchor": "sk-credentials-list"
            },
            {
              "depth": 4,
              "text": "`sk credentials rotate`",
              "anchor": "sk-credentials-rotate"
            },
            {
              "depth": 4,
              "text": "`sk credentials set`",
              "anchor": "sk-credentials-set"
            },
            {
              "depth": 3,
              "text": "`sk diagnostics`",
              "anchor": "sk-diagnostics"
            },
            {
              "depth": 4,
              "text": "`sk diagnostics errors`",
              "anchor": "sk-diagnostics-errors"
            },
            {
              "depth": 4,
              "text": "`sk diagnostics llm`",
              "anchor": "sk-diagnostics-llm"
            },
            {
              "depth": 4,
              "text": "`sk diagnostics setup`",
              "anchor": "sk-diagnostics-setup"
            },
            {
              "depth": 3,
              "text": "`sk discovery`",
              "anchor": "sk-discovery"
            },
            {
              "depth": 4,
              "text": "`sk discovery approve`",
              "anchor": "sk-discovery-approve"
            },
            {
              "depth": 4,
              "text": "`sk discovery artifacts`",
              "anchor": "sk-discovery-artifacts"
            },
            {
              "depth": 4,
              "text": "`sk discovery create`",
              "anchor": "sk-discovery-create"
            },
            {
              "depth": 4,
              "text": "`sk discovery get`",
              "anchor": "sk-discovery-get"
            },
            {
              "depth": 4,
              "text": "`sk discovery list`",
              "anchor": "sk-discovery-list"
            },
            {
              "depth": 4,
              "text": "`sk discovery reject`",
              "anchor": "sk-discovery-reject"
            },
            {
              "depth": 3,
              "text": "`sk doctor`",
              "anchor": "sk-doctor"
            },
            {
              "depth": 3,
              "text": "`sk events`",
              "anchor": "sk-events"
            },
            {
              "depth": 4,
              "text": "`sk events get`",
              "anchor": "sk-events-get"
            },
            {
              "depth": 4,
              "text": "`sk events list`",
              "anchor": "sk-events-list"
            },
            {
              "depth": 3,
              "text": "`sk executions`",
              "anchor": "sk-executions"
            },
            {
              "depth": 4,
              "text": "`sk executions abort`",
              "anchor": "sk-executions-abort"
            },
            {
              "depth": 4,
              "text": "`sk executions get`",
              "anchor": "sk-executions-get"
            },
            {
              "depth": 4,
              "text": "`sk executions list`",
              "anchor": "sk-executions-list"
            },
            {
              "depth": 4,
              "text": "`sk executions rerun`",
              "anchor": "sk-executions-rerun"
            },
            {
              "depth": 4,
              "text": "`sk executions result`",
              "anchor": "sk-executions-result"
            },
            {
              "depth": 4,
              "text": "`sk executions steps`",
              "anchor": "sk-executions-steps"
            },
            {
              "depth": 4,
              "text": "`sk executions tail`",
              "anchor": "sk-executions-tail"
            },
            {
              "depth": 3,
              "text": "`sk extract`",
              "anchor": "sk-extract"
            },
            {
              "depth": 3,
              "text": "`sk files`",
              "anchor": "sk-files"
            },
            {
              "depth": 4,
              "text": "`sk files delete`",
              "anchor": "sk-files-delete"
            },
            {
              "depth": 4,
              "text": "`sk files download`",
              "anchor": "sk-files-download"
            },
            {
              "depth": 4,
              "text": "`sk files get`",
              "anchor": "sk-files-get"
            },
            {
              "depth": 4,
              "text": "`sk files link`",
              "anchor": "sk-files-link"
            },
            {
              "depth": 4,
              "text": "`sk files list`",
              "anchor": "sk-files-list"
            },
            {
              "depth": 4,
              "text": "`sk files patch`",
              "anchor": "sk-files-patch"
            },
            {
              "depth": 4,
              "text": "`sk files replace`",
              "anchor": "sk-files-replace"
            },
            {
              "depth": 4,
              "text": "`sk files restore`",
              "anchor": "sk-files-restore"
            },
            {
              "depth": 4,
              "text": "`sk files stats`",
              "anchor": "sk-files-stats"
            },
            {
              "depth": 4,
              "text": "`sk files upload`",
              "anchor": "sk-files-upload"
            },
            {
              "depth": 4,
              "text": "`sk files versions`",
              "anchor": "sk-files-versions"
            },
            {
              "depth": 3,
              "text": "`sk health`",
              "anchor": "sk-health"
            },
            {
              "depth": 3,
              "text": "`sk hooks`",
              "anchor": "sk-hooks"
            },
            {
              "depth": 4,
              "text": "`sk hooks create`",
              "anchor": "sk-hooks-create"
            },
            {
              "depth": 4,
              "text": "`sk hooks delete`",
              "anchor": "sk-hooks-delete"
            },
            {
              "depth": 4,
              "text": "`sk hooks get`",
              "anchor": "sk-hooks-get"
            },
            {
              "depth": 4,
              "text": "`sk hooks list`",
              "anchor": "sk-hooks-list"
            },
            {
              "depth": 3,
              "text": "`sk init`",
              "anchor": "sk-init"
            },
            {
              "depth": 3,
              "text": "`sk install`",
              "anchor": "sk-install"
            },
            {
              "depth": 4,
              "text": "`sk install github`",
              "anchor": "sk-install-github"
            },
            {
              "depth": 4,
              "text": "`sk install google-workspace`",
              "anchor": "sk-install-google-workspace"
            },
            {
              "depth": 4,
              "text": "`sk install hubspot`",
              "anchor": "sk-install-hubspot"
            },
            {
              "depth": 4,
              "text": "`sk install jira`",
              "anchor": "sk-install-jira"
            },
            {
              "depth": 4,
              "text": "`sk install salesforce`",
              "anchor": "sk-install-salesforce"
            },
            {
              "depth": 4,
              "text": "`sk install slack`",
              "anchor": "sk-install-slack"
            },
            {
              "depth": 4,
              "text": "`sk install teams`",
              "anchor": "sk-install-teams"
            },
            {
              "depth": 3,
              "text": "`sk intake`",
              "anchor": "sk-intake"
            },
            {
              "depth": 4,
              "text": "`sk intake default`",
              "anchor": "sk-intake-default"
            },
            {
              "depth": 4,
              "text": "`sk intake discard`",
              "anchor": "sk-intake-discard"
            },
            {
              "depth": 4,
              "text": "`sk intake list`",
              "anchor": "sk-intake-list"
            },
            {
              "depth": 4,
              "text": "`sk intake move`",
              "anchor": "sk-intake-move"
            },
            {
              "depth": 4,
              "text": "`sk intake restore`",
              "anchor": "sk-intake-restore"
            },
            {
              "depth": 4,
              "text": "`sk intake review`",
              "anchor": "sk-intake-review"
            },
            {
              "depth": 3,
              "text": "`sk invites`",
              "anchor": "sk-invites"
            },
            {
              "depth": 4,
              "text": "`sk invites list`",
              "anchor": "sk-invites-list"
            },
            {
              "depth": 4,
              "text": "`sk invites revoke`",
              "anchor": "sk-invites-revoke"
            },
            {
              "depth": 3,
              "text": "`sk join`",
              "anchor": "sk-join"
            },
            {
              "depth": 3,
              "text": "`sk knowledge-sources`",
              "anchor": "sk-knowledge-sources"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources analyze`",
              "anchor": "sk-knowledge-sources-analyze"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources create`",
              "anchor": "sk-knowledge-sources-create"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources delete`",
              "anchor": "sk-knowledge-sources-delete"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources get`",
              "anchor": "sk-knowledge-sources-get"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources history`",
              "anchor": "sk-knowledge-sources-history"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources import`",
              "anchor": "sk-knowledge-sources-import"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources list`",
              "anchor": "sk-knowledge-sources-list"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources patch`",
              "anchor": "sk-knowledge-sources-patch"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources restore`",
              "anchor": "sk-knowledge-sources-restore"
            },
            {
              "depth": 4,
              "text": "`sk knowledge-sources search`",
              "anchor": "sk-knowledge-sources-search"
            },
            {
              "depth": 3,
              "text": "`sk login`",
              "anchor": "sk-login"
            },
            {
              "depth": 3,
              "text": "`sk logout`",
              "anchor": "sk-logout"
            },
            {
              "depth": 3,
              "text": "`sk logs`",
              "anchor": "sk-logs"
            },
            {
              "depth": 3,
              "text": "`sk ls`",
              "anchor": "sk-ls"
            },
            {
              "depth": 3,
              "text": "`sk mcp`",
              "anchor": "sk-mcp"
            },
            {
              "depth": 3,
              "text": "`sk notifications`",
              "anchor": "sk-notifications"
            },
            {
              "depth": 4,
              "text": "`sk notifications channels`",
              "anchor": "sk-notifications-channels"
            },
            {
              "depth": 4,
              "text": "`sk notifications deliveries`",
              "anchor": "sk-notifications-deliveries"
            },
            {
              "depth": 4,
              "text": "`sk notifications inbox`",
              "anchor": "sk-notifications-inbox"
            },
            {
              "depth": 4,
              "text": "`sk notifications rules`",
              "anchor": "sk-notifications-rules"
            },
            {
              "depth": 3,
              "text": "`sk packages`",
              "anchor": "sk-packages"
            },
            {
              "depth": 4,
              "text": "`sk packages export`",
              "anchor": "sk-packages-export"
            },
            {
              "depth": 4,
              "text": "`sk packages import`",
              "anchor": "sk-packages-import"
            },
            {
              "depth": 4,
              "text": "`sk packages installs`",
              "anchor": "sk-packages-installs"
            },
            {
              "depth": 3,
              "text": "`sk patch-candidates`",
              "anchor": "sk-patch-candidates"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates approve`",
              "anchor": "sk-patch-candidates-approve"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates get`",
              "anchor": "sk-patch-candidates-get"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates list`",
              "anchor": "sk-patch-candidates-list"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates preview`",
              "anchor": "sk-patch-candidates-preview"
            },
            {
              "depth": 4,
              "text": "`sk patch-candidates reject`",
              "anchor": "sk-patch-candidates-reject"
            },
            {
              "depth": 3,
              "text": "`sk portal-tokens`",
              "anchor": "sk-portal-tokens"
            },
            {
              "depth": 4,
              "text": "`sk portal-tokens create`",
              "anchor": "sk-portal-tokens-create"
            },
            {
              "depth": 4,
              "text": "`sk portal-tokens list`",
              "anchor": "sk-portal-tokens-list"
            },
            {
              "depth": 4,
              "text": "`sk portal-tokens revoke`",
              "anchor": "sk-portal-tokens-revoke"
            },
            {
              "depth": 3,
              "text": "`sk profile`",
              "anchor": "sk-profile"
            },
            {
              "depth": 4,
              "text": "`sk profile add`",
              "anchor": "sk-profile-add"
            },
            {
              "depth": 4,
              "text": "`sk profile delete`",
              "anchor": "sk-profile-delete"
            },
            {
              "depth": 4,
              "text": "`sk profile list`",
              "anchor": "sk-profile-list"
            },
            {
              "depth": 4,
              "text": "`sk profile show`",
              "anchor": "sk-profile-show"
            },
            {
              "depth": 4,
              "text": "`sk profile use`",
              "anchor": "sk-profile-use"
            },
            {
              "depth": 3,
              "text": "`sk rbac`",
              "anchor": "sk-rbac"
            },
            {
              "depth": 4,
              "text": "`sk rbac can`",
              "anchor": "sk-rbac-can"
            },
            {
              "depth": 4,
              "text": "`sk rbac grants`",
              "anchor": "sk-rbac-grants"
            },
            {
              "depth": 4,
              "text": "`sk rbac groups`",
              "anchor": "sk-rbac-groups"
            },
            {
              "depth": 4,
              "text": "`sk rbac permissions`",
              "anchor": "sk-rbac-permissions"
            },
            {
              "depth": 4,
              "text": "`sk rbac request-hooks`",
              "anchor": "sk-rbac-request-hooks"
            },
            {
              "depth": 4,
              "text": "`sk rbac roles`",
              "anchor": "sk-rbac-roles"
            },
            {
              "depth": 4,
              "text": "`sk rbac users`",
              "anchor": "sk-rbac-users"
            },
            {
              "depth": 4,
              "text": "`sk rbac whatcan`",
              "anchor": "sk-rbac-whatcan"
            },
            {
              "depth": 3,
              "text": "`sk rename`",
              "anchor": "sk-rename"
            },
            {
              "depth": 3,
              "text": "`sk review`",
              "anchor": "sk-review"
            },
            {
              "depth": 3,
              "text": "`sk rm`",
              "anchor": "sk-rm"
            },
            {
              "depth": 3,
              "text": "`sk schedules`",
              "anchor": "sk-schedules"
            },
            {
              "depth": 4,
              "text": "`sk schedules create`",
              "anchor": "sk-schedules-create"
            },
            {
              "depth": 4,
              "text": "`sk schedules delete`",
              "anchor": "sk-schedules-delete"
            },
            {
              "depth": 4,
              "text": "`sk schedules list`",
              "anchor": "sk-schedules-list"
            },
            {
              "depth": 4,
              "text": "`sk schedules pause`",
              "anchor": "sk-schedules-pause"
            },
            {
              "depth": 4,
              "text": "`sk schedules resume`",
              "anchor": "sk-schedules-resume"
            },
            {
              "depth": 4,
              "text": "`sk schedules update`",
              "anchor": "sk-schedules-update"
            },
            {
              "depth": 3,
              "text": "`sk self-healing`",
              "anchor": "sk-self-healing"
            },
            {
              "depth": 4,
              "text": "`sk self-healing list`",
              "anchor": "sk-self-healing-list"
            },
            {
              "depth": 4,
              "text": "`sk self-healing scan`",
              "anchor": "sk-self-healing-scan"
            },
            {
              "depth": 4,
              "text": "`sk self-healing show`",
              "anchor": "sk-self-healing-show"
            },
            {
              "depth": 3,
              "text": "`sk sessions`",
              "anchor": "sk-sessions"
            },
            {
              "depth": 4,
              "text": "`sk sessions ls`",
              "anchor": "sk-sessions-ls"
            },
            {
              "depth": 4,
              "text": "`sk sessions rename`",
              "anchor": "sk-sessions-rename"
            },
            {
              "depth": 4,
              "text": "`sk sessions rm`",
              "anchor": "sk-sessions-rm"
            },
            {
              "depth": 4,
              "text": "`sk sessions search`",
              "anchor": "sk-sessions-search"
            },
            {
              "depth": 4,
              "text": "`sk sessions show`",
              "anchor": "sk-sessions-show"
            },
            {
              "depth": 3,
              "text": "`sk settings`",
              "anchor": "sk-settings"
            },
            {
              "depth": 4,
              "text": "`sk settings configure`",
              "anchor": "sk-settings-configure"
            },
            {
              "depth": 4,
              "text": "`sk settings get`",
              "anchor": "sk-settings-get"
            },
            {
              "depth": 4,
              "text": "`sk settings list`",
              "anchor": "sk-settings-list"
            },
            {
              "depth": 4,
              "text": "`sk settings set`",
              "anchor": "sk-settings-set"
            },
            {
              "depth": 3,
              "text": "`sk show`",
              "anchor": "sk-show"
            },
            {
              "depth": 3,
              "text": "`sk skill-candidates`",
              "anchor": "sk-skill-candidates"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates approve`",
              "anchor": "sk-skill-candidates-approve"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates get`",
              "anchor": "sk-skill-candidates-get"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates list`",
              "anchor": "sk-skill-candidates-list"
            },
            {
              "depth": 4,
              "text": "`sk skill-candidates reject`",
              "anchor": "sk-skill-candidates-reject"
            },
            {
              "depth": 3,
              "text": "`sk skills`",
              "anchor": "sk-skills"
            },
            {
              "depth": 4,
              "text": "`sk skills activate`",
              "anchor": "sk-skills-activate"
            },
            {
              "depth": 4,
              "text": "`sk skills archive`",
              "anchor": "sk-skills-archive"
            },
            {
              "depth": 4,
              "text": "`sk skills create`",
              "anchor": "sk-skills-create"
            },
            {
              "depth": 4,
              "text": "`sk skills delete`",
              "anchor": "sk-skills-delete"
            },
            {
              "depth": 4,
              "text": "`sk skills edit`",
              "anchor": "sk-skills-edit"
            },
            {
              "depth": 4,
              "text": "`sk skills get`",
              "anchor": "sk-skills-get"
            },
            {
              "depth": 4,
              "text": "`sk skills history`",
              "anchor": "sk-skills-history"
            },
            {
              "depth": 4,
              "text": "`sk skills list`",
              "anchor": "sk-skills-list"
            },
            {
              "depth": 4,
              "text": "`sk skills patch`",
              "anchor": "sk-skills-patch"
            },
            {
              "depth": 4,
              "text": "`sk skills restore`",
              "anchor": "sk-skills-restore"
            },
            {
              "depth": 4,
              "text": "`sk skills sync`",
              "anchor": "sk-skills-sync"
            },
            {
              "depth": 3,
              "text": "`sk stats`",
              "anchor": "sk-stats"
            },
            {
              "depth": 4,
              "text": "`sk stats chat`",
              "anchor": "sk-stats-chat"
            },
            {
              "depth": 4,
              "text": "`sk stats connectors`",
              "anchor": "sk-stats-connectors"
            },
            {
              "depth": 4,
              "text": "`sk stats conversations`",
              "anchor": "sk-stats-conversations"
            },
            {
              "depth": 4,
              "text": "`sk stats events`",
              "anchor": "sk-stats-events"
            },
            {
              "depth": 4,
              "text": "`sk stats executions`",
              "anchor": "sk-stats-executions"
            },
            {
              "depth": 4,
              "text": "`sk stats http`",
              "anchor": "sk-stats-http"
            },
            {
              "depth": 4,
              "text": "`sk stats llm`",
              "anchor": "sk-stats-llm"
            },
            {
              "depth": 4,
              "text": "`sk stats mcp`",
              "anchor": "sk-stats-mcp"
            },
            {
              "depth": 4,
              "text": "`sk stats operations`",
              "anchor": "sk-stats-operations"
            },
            {
              "depth": 3,
              "text": "`sk status`",
              "anchor": "sk-status"
            },
            {
              "depth": 3,
              "text": "`sk subscriptions`",
              "anchor": "sk-subscriptions"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions create`",
              "anchor": "sk-subscriptions-create"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions delete`",
              "anchor": "sk-subscriptions-delete"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions deliveries`",
              "anchor": "sk-subscriptions-deliveries"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions get`",
              "anchor": "sk-subscriptions-get"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions list`",
              "anchor": "sk-subscriptions-list"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions patch`",
              "anchor": "sk-subscriptions-patch"
            },
            {
              "depth": 4,
              "text": "`sk subscriptions replay`",
              "anchor": "sk-subscriptions-replay"
            },
            {
              "depth": 3,
              "text": "`sk system`",
              "anchor": "sk-system"
            },
            {
              "depth": 4,
              "text": "`sk system restart`",
              "anchor": "sk-system-restart"
            },
            {
              "depth": 3,
              "text": "`sk system-accounts`",
              "anchor": "sk-system-accounts"
            },
            {
              "depth": 4,
              "text": "`sk system-accounts create`",
              "anchor": "sk-system-accounts-create"
            },
            {
              "depth": 4,
              "text": "`sk system-accounts delete`",
              "anchor": "sk-system-accounts-delete"
            },
            {
              "depth": 4,
              "text": "`sk system-accounts list`",
              "anchor": "sk-system-accounts-list"
            },
            {
              "depth": 3,
              "text": "`sk tenants`",
              "anchor": "sk-tenants"
            },
            {
              "depth": 3,
              "text": "`sk update`",
              "anchor": "sk-update"
            },
            {
              "depth": 3,
              "text": "`sk users`",
              "anchor": "sk-users"
            },
            {
              "depth": 4,
              "text": "`sk users create`",
              "anchor": "sk-users-create"
            },
            {
              "depth": 4,
              "text": "`sk users delete`",
              "anchor": "sk-users-delete"
            },
            {
              "depth": 4,
              "text": "`sk users get`",
              "anchor": "sk-users-get"
            },
            {
              "depth": 4,
              "text": "`sk users invite`",
              "anchor": "sk-users-invite"
            },
            {
              "depth": 4,
              "text": "`sk users list`",
              "anchor": "sk-users-list"
            },
            {
              "depth": 4,
              "text": "`sk users patch`",
              "anchor": "sk-users-patch"
            },
            {
              "depth": 3,
              "text": "`sk workflows`",
              "anchor": "sk-workflows"
            },
            {
              "depth": 4,
              "text": "`sk workflows create`",
              "anchor": "sk-workflows-create"
            },
            {
              "depth": 4,
              "text": "`sk workflows delete`",
              "anchor": "sk-workflows-delete"
            },
            {
              "depth": 4,
              "text": "`sk workflows dry-run`",
              "anchor": "sk-workflows-dry-run"
            },
            {
              "depth": 4,
              "text": "`sk workflows get`",
              "anchor": "sk-workflows-get"
            },
            {
              "depth": 4,
              "text": "`sk workflows history`",
              "anchor": "sk-workflows-history"
            },
            {
              "depth": 4,
              "text": "`sk workflows invoke-snippet`",
              "anchor": "sk-workflows-invoke-snippet"
            },
            {
              "depth": 4,
              "text": "`sk workflows list`",
              "anchor": "sk-workflows-list"
            },
            {
              "depth": 4,
              "text": "`sk workflows patch`",
              "anchor": "sk-workflows-patch"
            },
            {
              "depth": 4,
              "text": "`sk workflows preview`",
              "anchor": "sk-workflows-preview"
            },
            {
              "depth": 4,
              "text": "`sk workflows restore`",
              "anchor": "sk-workflows-restore"
            },
            {
              "depth": 4,
              "text": "`sk workflows run`",
              "anchor": "sk-workflows-run"
            },
            {
              "depth": 4,
              "text": "`sk workflows update`",
              "anchor": "sk-workflows-update"
            },
            {
              "depth": 4,
              "text": "`sk workflows validate`",
              "anchor": "sk-workflows-validate"
            }
          ],
          "images": [],
          "sha256": "2038db4ecfa5cb1cc42fa409ff1342b1bd8970d25c0430abacf0fb2307cc76a1",
          "body": "Hier steht jeder Befehl der Kommandozeile `sk` mit allen Argumenten. Die Kommandozeile bekommst du direkt von deiner Engine. Mit ihr entwirfst, änderst und startest du Workflows, Konnektoren, Quellen und Skills als Dateien. Jede Änderung ist eine Datei, die du lesen kannst, und ein Befehl, den du wiederholen kannst.\n\nDie Referenz unten wird aus der CLI erzeugt und ist deshalb auf Englisch.\n\n# sk CLI reference\n\nLook up every `sk` command and argument here. Creating or changing a\nworkflow, connector, knowledge source or skill also runs through `sk`:\nthe change is a file you can read and a command you can re-run.\n\nBare `sk` opens an interactive prompt. Every command below also runs in\nscripts and prints to stdout. `create --file`, `update --file`, `validate`,\n`preview` and `probe` check a definition *before* it is saved. A mistake\nthen costs an error message, not a half-built connector someone has to\nclean up.\n\nThe `requires` column names the permission that shows a command in\n`--help`. The engine checks permissions again on every API call.\n\n| command | requires | description | subcommands |\n| ------- | -------- | ----------- | ----------- |\n| `sk agent` | `skill:read` | Coding-agent integration: session briefings and hook setup | `briefing`, `capture`, `init` |\n| `sk apikeys` | `api_key:read` | Manage API keys | `create`, `list`, `revoke`, `rotate` |\n| `sk apps` | `settings:read` | The apps that sign their users in and call SubKit (products settings, sign-in providers, workflows, users, budget); erase-user removes one app user's SubKit data | `erase-user`, `list`, `show` |\n| `sk attach` | `file:write` | Upload a file and link it to a conversation (shortcut) | — |\n| `sk audit` | `audit:read` | Query the append-only audit log | `export`, `query`, `show` |\n| `sk auth` | `connector:write` | Start a connector's browser sign-in and print the URL to open. Works for every connector that signs in with an account — a web service or an MCP server; the engine names the route. | — |\n| `sk branding` | — | Read, update, reset, or download tenant branding | `get`, `logo`, `reset`, `update` |\n| `sk categories` | `workflow:read` | Show and rename the catalog categories shared by every kind | `list`, `rename` |\n| `sk chat` | `chat_workspace:read` | Manage external chat spaces (Google Chat / Slack) | `install-space`, `remove-space`, `spaces` |\n| `sk clipper` | — | Install the Chrome clipping extension | `install` |\n| `sk connector-templates` | `connector:read` | Manage connector templates | `create`, `delete`, `list`, `recipe`, `recipe-pack`, `recipes`, `search`, `set-oauth` |\n| `sk connectors` | `connector:read` | Manage connectors | `create`, `delete`, `disable`, `docs-delete`, `docs-ingest`, `docs-list`, `docs-search`, `enable`, `get`, `import`, `inspect`, `list`, `mcp-authorize`, `mcp-inspect`, `patch`, `probe`, `promote`, `test`, `validate` |\n| `sk credentials` | `credential:read` | Manage connector credentials | `delete`, `list`, `rotate`, `set` |\n| `sk diagnostics` | `audit:read` | Engine diagnostics: errors, LLM status, setup validation | `errors`, `llm`, `setup` |\n| `sk discovery` | `discovery:read` | Manage discovery runs and artifacts | `approve`, `artifacts`, `create`, `get`, `list`, `reject` |\n| `sk doctor` | — | Diagnose engine connectivity, authentication, and setup. Exits 0 (ok or warn) or 2 (blocked). | — |\n| `sk events` | `audit:read` | Query audit events | `get`, `list` |\n| `sk executions` | `execution:read` | Manage workflow executions | `abort`, `get`, `list`, `rerun`, `result`, `steps`, `tail` |\n| `sk extract` | `conversation:write` | Extract structured data from a file (LLM for text, native parsers for binary) | — |\n| `sk files` | `file:read` | Manage files (upload, download, link, …) | `delete`, `download`, `get`, `link`, `list`, `patch`, `replace`, `restore`, `stats`, `upload`, `versions` |\n| `sk health` | — | Runtime posture: liveness, token budget, failing runs, risk signals, schema drift, and process runtime. Use `sk doctor` for connectivity/setup. | — |\n| `sk hooks` | `inbound_hook:read` | Manage inbound webhook bindings | `create`, `delete`, `get`, `list` |\n| `sk init` | — | Complete first-run engine bootstrap (consumes the token printed at engine boot) | — |\n| `sk install` | `connector:write` | Guided setup for enterprise integrations | `github`, `google-workspace`, `hubspot`, `jira`, `salesforce`, `slack`, `teams` |\n| `sk intake` | `intake:read` | List collected items and start a selected Chat review | `default`, `discard`, `list`, `move`, `restore`, `review` |\n| `sk invites` | `identity:read` | Manage user-provisioning invites | `list`, `revoke` |\n| `sk join` | — | Redeem an invite to provision your personal API key (no login required) | — |\n| `sk knowledge-sources` | `knowledge:read` | Manage knowledge sources | `analyze`, `create`, `delete`, `get`, `history`, `import`, `list`, `patch`, `restore`, `search` |\n| `sk login` | — | Authenticate against a subkit engine | — |\n| `sk logout` | — | Drop the active profile | — |\n| `sk logs` | `audit:read` | Tail the engine's runtime log ring. --follow streams via SSE; --since accepts 5m / 2h / 1d / ISO-8601. | — |\n| `sk ls` | — | List cached conversation sessions for the active profile | — |\n| `sk mcp` | — | Run a stdio MCP server proxied to the engine | — |\n| `sk notifications` | `notification:read` | Manage notification channels, rules, deliveries, and the inbox | `channels`, `deliveries`, `inbox`, `rules` |\n| `sk packages` | `package:import` | Move this workspace to another engine: export a package archive, import one with a reviewed plan, list past imports | `export`, `import`, `installs` |\n| `sk patch-candidates` | `workflow:read` | Manage patch candidates | `approve`, `get`, `list`, `preview`, `reject` |\n| `sk portal-tokens` | `portal_token:read` | Manage portal tokens | `create`, `list`, `revoke` |\n| `sk profile` | — | Manage named profiles (environments) | `add`, `delete`, `list`, `show`, `use` |\n| `sk rbac` | `rbac:read` | Manage RBAC roles, permissions, grants, groups, and hooks | `can`, `grants`, `groups`, `permissions`, `request-hooks`, `roles`, `users`, `whatcan` |\n| `sk rename` | — | Assign or change a short alias for a session (used by `sk -r <alias>`) | — |\n| `sk review` | `workflow:read` | Aggregated approval digest: pending patch candidates, proposed skill candidates, and recent failed executions. | — |\n| `sk rm` | — | Drop a session from the local cache (the server-side conversation row is preserved) | — |\n| `sk schedules` | `workflow:read` | Scheduled workflow runs | `create`, `delete`, `list`, `pause`, `resume`, `update` |\n| `sk self-healing` | `workflow:write` | Trigger and review proactive drift scans (admin) | `list`, `scan`, `show` |\n| `sk sessions` | — | Manage locally-cached conversation sessions | `ls`, `rename`, `rm`, `search`, `show` |\n| `sk settings` | `settings:read` | List, read, write, or interactively configure engine settings (secrets always masked) | `configure`, `get`, `list`, `set` |\n| `sk show` | — | Show cached metadata for a session by id or alias | — |\n| `sk skill-candidates` | `skill:read` | Manage skill candidates | `approve`, `get`, `list`, `reject` |\n| `sk skills` | `skill:read` | Manage skills | `activate`, `archive`, `create`, `delete`, `edit`, `get`, `history`, `list`, `patch`, `restore`, `sync` |\n| `sk stats` | `stats:read` | Tenant-scoped runtime statistics (needs stats:read) | `chat`, `connectors`, `conversations`, `events`, `executions`, `http`, `llm`, `mcp`, `operations` |\n| `sk status` | — | Print the active profile + engine reachability | — |\n| `sk subscriptions` | `subscription:read` | Manage event subscriptions | `create`, `delete`, `deliveries`, `get`, `list`, `patch`, `replay` |\n| `sk system` | `system:restart` | Engine process operations (restart) | `restart` |\n| `sk system-accounts` | `identity:read` | Manage system accounts | `create`, `delete`, `list` |\n| `sk tenants` | — | List tenants you belong to or switch the active one | — |\n| `sk update` | — | Update sk CLI to the latest version from your engine, falling back to GitHub releases | — |\n| `sk users` | `identity:read` | Manage identity users | `create`, `delete`, `get`, `invite`, `list`, `patch` |\n| `sk workflows` | `workflow:read` | Manage workflows | `create`, `delete`, `dry-run`, `get`, `history`, `invoke-snippet`, `list`, `patch`, `preview`, `restore`, `run`, `update`, `validate` |\n\n## Commands and arguments\n\nEvery argument of every command. `<name>` is positional; `--name` is a flag.\n\n### `sk agent`\n\nCoding-agent integration: session briefings and hook setup\n\n#### `sk agent briefing`\n\nPrint or verify the domain-scoped session briefing for coding agents\n\n- `--domains` (string) — Comma-separated domain slugs (default: .sk/agent.json of the repo; without hooks, else the known domains the repository name names)\n- `--budget` (string) — Token budget for the briefing\n- `--hook` (default: false) — Hook mode for Codex and Claude Code: inject a repository briefing and show a non-blocking status or warning\n- `--json` (default: false) — JSON output\n\n#### `sk agent capture`\n\nSend a session transcript to the engine to collect learnings for review\n\n- `--transcript` (string) — Path to the transcript file (JSONL or text)\n- `--domains` (string) — Comma-separated domain slugs (default: .sk/agent.json of the repo)\n- `--agent` (string, default: claude-code) — Producing agent name\n- `--session-id` (string) — Session id for evidence attribution\n- `--hook` (default: false) — SessionEnd/Stop-hook mode: read hook JSON from stdin, never fail\n- `--detach` (default: false) — Process the hook payload in a detached process\n- `--json` (default: false) — JSON output\n\n#### `sk agent init`\n\nSet up automatic SubKit briefings for this repository in Claude Code and Codex\n\n- `--domains` (string, required) — Comma-separated domains for this repository (e.g. accounting, blog-de)\n- `--budget` (string) — Optional token budget for each briefing\n- `--skip-claude` (default: false) — Do not touch ~/.claude/settings.json\n- `--skip-codex` (default: false) — Do not touch ~/.codex/hooks.json\n\n\n### `sk apikeys`\n\nManage API keys\n\n#### `sk apikeys create`\n\nIssue a new API key (shown once)\n\n- `--name` (string) — Friendly key name (label)\n- `--expires` (string) — Expiry — ISO-8601 timestamp\n- `--scopes` (string) — Comma-separated scope strings (e.g. \"workflow:read,workflow:run\"). Defaults to your own credential's scopes; [\"*\"] (full role-derived access, and read-and-execute over MCP) only when your credential has no scope limits. Add \"mcp:authoring\" for a key that may also author definitions over MCP (a coding agent); leave it off for a key going into a browser client.\n- `--allowed-workflows` (string) — Comma-separated workflow ids/slugs. Use \"*\" for explicit \"all\".\n- `--allowed-connectors` (string) — Comma-separated connector ids/slugs. Use \"*\" for explicit \"all\".\n\n#### `sk apikeys list`\n\nList API keys\n\n- `--json` — JSON output\n\n#### `sk apikeys revoke`\n\nRevoke an API key\n\n- `<id>` (positional, required) — Key id\n\n#### `sk apikeys rotate`\n\nRotate an API key (new key shown once)\n\n- `<id>` (positional, required) — Key id\n\n\n### `sk apps`\n\nThe apps that sign their users in and call SubKit (products settings, sign-in providers, workflows, users, budget); erase-user removes one app user's SubKit data\n\n#### `sk apps erase-user`\n\nErase an app user: removes SubKit's own data about that person for this app; the account at the sign-in provider stays. Irreversible\n\n- `<app>` (positional, required) — App id (the product_id)\n- `<user>` (positional, required) — User id (listed by sk apps show <app>)\n- `--yes` (default: false) — Confirm the erasure without asking\n- `--json` (default: false) — JSON output\n\n#### `sk apps list`\n\nList the apps of this workspace with environment, users, budget today and readiness\n\n- `--json` (default: false) — JSON output\n\n#### `sk apps show`\n\nShow one app: settings, sign-in, workflows, users, today's budget and readiness with the next action\n\n- `<id>` (positional, required) — App id (the product_id)\n- `--json` (default: false) — JSON output\n\n\n### `sk attach`\n\nUpload a file and link it to a conversation (shortcut)\n\n- `<conversation-id>` (positional, required) — Conversation id (UUID)\n- `<path>` (positional, required) — Path to file\n- `--content-type` (string) — Override detected MIME type\n- `--slug` (string) — Optional slug for the link\n- `--role` (string) — Optional role for the link\n- `--quiet` (default: false) — Suppress progress output\n- `--json` (default: false) — JSON output\n\n\n### `sk audit`\n\nQuery the append-only audit log\n\n#### `sk audit export`\n\nStream audit log as NDJSON to stdout or a file\n\n- `--since` (string) — Lower bound — ISO-8601 timestamp\n- `--to` (string) — Exclusive UTC upper bound (ISO-8601)\n- `--action` (string) — Action name filter\n- `--actor` (string) — Actor id filter\n- `--actor-type` (string) — Actor kind\n- `--api-key-id` (string) — Recorded API key id\n- `--session-id` (string) — Recorded session id\n- `--access-type` (string) — Verified access type\n- `--oauth-client-id` (string) — Verified OAuth client id\n- `--request-source` (string) — Legacy recorded source (not verified)\n- `--origin-source` (string) — Verified initiating source\n- `--execution-source` (string) — Immediate server execution step\n- `--correlation-id` (string) — Trusted audit correlation id\n- `--resource-type` (string) — Resource type\n- `--resource-types` (string) — Comma-separated resource types\n- `--resource-id` (string) — Resource id\n- `--result` (string) — success, denied or error\n- `--trace-id` (string) — Trace id\n- `--execution-id` (string) — Recorded execution id\n- `--conversation-id` (string) — Recorded conversation id\n- `--workflow-id` (string) — Recorded workflow id\n- `--output` (string) — Output file path (default: stdout)\n\n#### `sk audit query`\n\nFilter the audit log\n\n- `--limit` (string) — Max rows\n- `--since` (string) — Lower bound — ISO-8601 timestamp or relative (e.g. 10m, 1h, 7d)\n- `--action` (string) — Action name filter\n- `--actor` (string) — Actor id filter\n- `--actor-type` (string) — Actor kind\n- `--api-key-id` (string) — Recorded API key id\n- `--session-id` (string) — Recorded session id\n- `--access-type` (string) — Verified access type\n- `--oauth-client-id` (string) — Verified OAuth client id\n- `--request-source` (string) — Legacy recorded source (not verified)\n- `--origin-source` (string) — Verified initiating source\n- `--execution-source` (string) — Immediate server execution step\n- `--correlation-id` (string) — Trusted audit correlation id\n- `--resource-type` (string) — Resource type\n- `--resource-types` (string) — Comma-separated resource types\n- `--resource-id` (string) — Filter by resource id\n- `--result` (string) — success, denied or error\n- `--trace-id` (string) — Trace id\n- `--execution-id` (string) — Recorded execution id\n- `--conversation-id` (string) — Recorded conversation id\n- `--workflow-id` (string) — Recorded workflow id\n- `--to` (string) — Exclusive UTC upper bound (ISO-8601)\n- `--cursor` (string) — Continue after a previous page (its next_cursor)\n- `--json` — JSON output\n\n#### `sk audit show`\n\nFetch one audit event by id\n\n- `<id>` (positional, required) — Audit event id\n\n\n### `sk auth`\n\nStart a connector's browser sign-in and print the URL to open. Works for every connector that signs in with an account — a web service or an MCP server; the engine names the route.\n\n- `--connector-id` (string, required) — Connector to reauthenticate\n- `--json` — Emit the full response as JSON\n\n\n### `sk branding`\n\nRead, update, reset, or download tenant branding\n\n#### `sk branding get`\n\nRead tenant branding\n\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n#### `sk branding logo`\n\nDownload normalized branding logo PNG\n\n- `<theme>` (positional, required) — light or dark\n- `--output` (string) — Output file, defaults to stdout\n- `--revision` (string)\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n#### `sk branding reset`\n\nReset branding at an expected revision\n\n- `<revision>` (positional, required)\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n#### `sk branding update`\n\nReplace branding from canonical JSON body (file or - for stdin)\n\n- `<input>` (positional, required) — JSON file or -\n- `--engine-url` (string)\n- `--api-key` (string)\n- `--profile` (string)\n- `--json`\n\n\n### `sk categories`\n\nShow and rename the catalog categories shared by every kind\n\n#### `sk categories list`\n\nList the catalog categories with how many workflows, connectors, knowledge sources, skills and files use each\n\n- `--json` — JSON output\n\n#### `sk categories rename`\n\nRename across all kinds with revision checks; preserve purpose ownership and merge into an existing target\n\n- `<from>` (positional, required) — Current category\n- `<to>` (positional, required) — New category\n- `--json` — JSON output\n\n\n### `sk chat`\n\nManage external chat spaces (Google Chat / Slack)\n\n#### `sk chat install-space`\n\nRegister a chat space with the engine (Google Chat / Slack)\n\n- `<platform>` (positional) — google_chat | slack\n- `<workspace_id>` (positional) — Native space id, e.g. spaces/<id> (Slack: team id T…)\n- `--bot-token` (string) — Slack bot token (xoxb-…) — required for slack\n- `--default-channel` (string) — Optional default channel\n- `--as` (string) — Installer platform user id (auto-filled from a pending space when omitted)\n- `--json` — JSON output\n\n#### `sk chat remove-space`\n\nRemove a chat-space install\n\n- `<id>` (positional) — Chat workspace row id\n- `--yes` — Skip confirmation\n- `--json` — JSON output\n\n#### `sk chat spaces`\n\nList chat spaces installed in this tenant\n\n- `--json` — JSON output\n\n\n### `sk clipper`\n\nInstall the Chrome clipping extension\n\n#### `sk clipper install`\n\nInstall the local Chrome clipping extension\n\n- `--dir` (string) — Installation directory\n- `--engine-url` (string) — Engine address (default: active profile)\n- `--open` (default: true) — Open Chrome extensions after installing\n\n\n### `sk connector-templates`\n\nManage connector templates\n\n#### `sk connector-templates create`\n\nCreate a connector template\n\n- `--file` (string) — Path to a full template JSON file\n- `--slug` (string) — Template slug (short-form convenience mode)\n- `--name` (string) — Template name (short-form convenience mode)\n- `--driver` (string) — Driver identifier (short-form convenience mode)\n\n#### `sk connector-templates delete`\n\nDelete a connector template\n\n- `<id>` (positional, required) — Template id\n\n#### `sk connector-templates list`\n\nList connector templates\n\n- `--json` — JSON output\n\n#### `sk connector-templates recipe`\n\nShow one recipe by slug (template slug + recipe slug)\n\n- `<slug>` (positional) — Template slug (e.g. stripe)\n- `<recipe>` (positional) — Recipe slug (e.g. list-customers)\n- `--json` — JSON output\n\n#### `sk connector-templates recipe-pack`\n\nShow the recipes in a vertical pack\n\n- `<vertical>` (positional) — Vertical (revops | customer-success | finance | data | devops | security | marketing | hr | solutions)\n- `--json` — JSON output\n\n#### `sk connector-templates recipes`\n\nList recipes shipped with a connector template\n\n- `<slug>` (positional) — Template slug (e.g. stripe, github)\n- `--json` — JSON output\n\n#### `sk connector-templates search`\n\nFuzzy-search connector templates by name/alias/keyword\n\n- `<query>` (positional, required) — Search text (e.g. 'hub')\n- `--limit` (string, default: 10) — Max results\n- `--json` — JSON output\n\n#### `sk connector-templates set-oauth`\n\nStore tenant-scoped OAuth client credentials for a connector template\n\n- `--slug` (string, required) — Template slug\n- `--client-id` (string, required) — OAuth client id\n- `--client-secret` (string, required) — OAuth client secret\n\n\n### `sk connectors`\n\nManage connectors\n\n#### `sk connectors create`\n\nCreate a connector from a template slug (--template) or a definition file (--file). --file runs validate and probe against the unsaved definition first, so a broken connector is never created; pass --skip-checks to bypass.\n\n- `--template` (string) — Template slug\n- `--file` (string) — Path to a connector definition JSON file\n- `--credential` (string) — Path to a credential JSON file used to sign the pre-save probe. Never stored — attach the credential with `sk credentials set` after create.\n- `--name` (string) — Override connector name (--template only)\n- `--skip-checks` — Skip the checks (NOT recommended).\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk connectors delete`\n\nDelete a connector\n\n- `<id>` (positional) — Connector id\n- `--yes` — Skip confirmation\n\n#### `sk connectors disable`\n\nDisable a connector. It keeps its configuration and credentials and stops being offered for use.\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors docs-delete`\n\nDelete a connector doc\n\n- `<id>` (positional, required) — Connector id\n- `<doc-id>` (positional, required) — Doc id\n\n#### `sk connectors docs-ingest`\n\nIngest docs from a URL into a connector\n\n- `<id>` (positional, required) — Connector id\n- `--url` (string, required) — URL to ingest\n\n#### `sk connectors docs-list`\n\nList ingested docs for a connector\n\n- `<id>` (positional, required) — Connector id\n- `--json` — JSON output\n\n#### `sk connectors docs-search`\n\nRanked search over connector docs\n\n- `<id>` (positional, required) — Connector id\n- `<query>` (positional, required) — Search query\n- `--limit` (string, default: 10) — Max results\n\n#### `sk connectors enable`\n\nEnable a connector (operator on switch)\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors get`\n\nGet a connector by id\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors import`\n\nTurn an API specification into a connector. Parses the spec, shows the draft it produced, then creates it after confirmation (--yes to skip). Nothing is saved until you agree.\n\n- `--spec` (string, required) — Path to the specification file, or a URL / curl command (see --source)\n- `--source` (string, required) — openapi | google_discovery | postman | har | graphql | graphql_introspection | curl\n- `--name` (string) — Override the connector name\n- `--environment` (string) — dev (default) or prod\n- `--yes` — Create without asking (for non-interactive use)\n- `--dry-run` — Print the draft and stop. Nothing is created.\n- `--json` — JSON-only output\n\n#### `sk connectors inspect`\n\nInspect a connector resource (alias of `get`).\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors list`\n\nList connectors, grouped into catalog blocks\n\n- `--limit` (string, default: 50) — Max rows\n- `--category` (string) — Only this catalog block\n- `--driver` (string) — Only this driver: http, graphql, postgres, s3, mcp\n- `--flat` — One flat table instead of grouped blocks\n- `--json` — JSON output\n\n#### `sk connectors mcp-authorize`\n\nmcp driver: begin the interactive OAuth 2.1 flow and print the URL to open in a browser.\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors mcp-inspect`\n\nmcp driver: force one handshake and list the tools, capabilities and instructions the remote actually serves.\n\n- `<id>` (positional) — Connector id\n\n#### `sk connectors patch`\n\nUpdate a connector, from --file (a partial definition: only the fields it names change) or from --name, --description and --category. --file runs validate first.\n\n- `<id>` (positional, required) — Connector id\n- `--file` (string) — Path to a partial definition JSON file\n- `--name` (string) — New name\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--skip-checks` — Skip validation (NOT recommended).\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk connectors probe`\n\nProbe a connector's upstream boundary. With an id, probes the saved connector (alias of `test`); with --file, probes an unsaved definition and saves nothing.\n\n- `<id>` (positional) — Connector id\n- `--file` (string) — Path to a connector definition JSON file — probes it without saving it\n- `--credential` (string) — Path to a credential JSON file. Signs this probe only; never stored. Required when the definition's auth_type is not 'none'.\n- `--json` — JSON-only output\n\n#### `sk connectors promote`\n\nPromote a connector and its credentials from DEV to PROD\n\n- `<id>` (positional) — DEV connector id\n- `--to` (string, default: prod) — Target environment (prod only)\n- `--strategy` (string, default: copy) — Promotion strategy: copy or move\n- `--idempotency-key` (string) — Stable retry key; generated when omitted\n- `--yes` — Confirm a move without prompting\n- `--json` — JSON output\n\n#### `sk connectors test`\n\nTest a connector connection (alias of `probe`). Exits non-zero when the probe fails.\n\n- `<id>` (positional) — Connector id\n- `--json` — JSON-only output\n\n#### `sk connectors validate`\n\nCheck a connector definition file against its driver's config schema. Saves nothing, reaches no upstream.\n\n- `<file>` (positional, required) — Path to a definition JSON file\n- `--json` — JSON-only output\n\n\n### `sk credentials`\n\nManage connector credentials\n\n#### `sk credentials delete`\n\nDelete a credential\n\n- `<credential-id>` (positional, required) — Credential id\n\n#### `sk credentials list`\n\nList credentials for a connector\n\n- `<connector-id>` (positional, required) — Connector id\n- `--json` — JSON output\n\n#### `sk credentials rotate`\n\nRotate a credential\n\n- `<credential-id>` (positional, required) — Credential id\n\n#### `sk credentials set`\n\nAttach a credential to a connector (scriptable; no conversation needed). Modes: bearer | header | query | basic | aws_sigv4 | signed_jwt | none.\n\n- `<connector-id>` (positional, required) — Connector id\n- `--mode` (string, required) — bearer | header | query | basic | aws_sigv4 | signed_jwt | none\n- `--private-key-file` (string) — signed_jwt: local PKCS#8 PEM file; contents are sent only to the credential endpoint\n- `--token` (string) — Secret token (bearer mode)\n- `--header` (string) — header mode: \"Name=Value\" (comma-separate multiple)\n- `--query` (string) — query mode: \"key=Value\" (comma-separate multiple)\n- `--username` (string) — basic mode username\n- `--password` (string) — basic mode password\n- `--access-key-id` (string) — aws_sigv4 access key id\n- `--secret-access-key` (string) — aws_sigv4 secret access key\n- `--session-token` (string) — aws_sigv4 optional STS session token\n- `--skip-checks` — Skip the post-set connectivity probe\n- `--json` — JSON-only output\n\n\n### `sk diagnostics`\n\nEngine diagnostics: errors, LLM status, setup validation\n\n#### `sk diagnostics errors`\n\nShow recent engine errors\n\n- `--limit` (string, default: 20) — Max rows\n- `--since` (string) — ISO timestamp lower bound\n- `--trace-id` (string) — Filter by trace id\n- `--tail` — Keep reading (not applicable — uses snapshot endpoint)\n- `--json` — JSON output\n\n#### `sk diagnostics llm`\n\nShow LLM diagnostics\n\n_No arguments._\n\n#### `sk diagnostics setup`\n\nValidate engine setup\n\n- `--json` — JSON output\n\n\n### `sk discovery`\n\nManage discovery runs and artifacts\n\n#### `sk discovery approve`\n\nApprove a discovery artifact\n\n- `<artifact-id>` (positional, required) — Artifact id\n\n#### `sk discovery artifacts`\n\nList artifacts for a discovery run\n\n- `<run-id>` (positional, required) — Run id\n- `--json` (default: false) — JSON output\n\n#### `sk discovery create`\n\nStart a discovery run from one or more files\n\n- `--file` (string, required) — File path(s), comma-separated\n- `--label` (string) — Optional label for the run\n\n#### `sk discovery get`\n\nGet a discovery run\n\n- `<run-id>` (positional, required) — Run id\n\n#### `sk discovery list`\n\nList discovery runs\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk discovery reject`\n\nReject a discovery artifact\n\n- `<artifact-id>` (positional, required) — Artifact id\n- `--reason` (string) — Rejection reason\n\n\n### `sk doctor`\n\nDiagnose engine connectivity, authentication, and setup. Exits 0 (ok or warn) or 2 (blocked).\n\n- `--engine-url` (string) — Override the resolved engine URL\n- `--api-key` (string) — Override the resolved API key\n- `--profile` (string) — Use a named profile\n- `--json` — Emit one JSON object instead of human output\n\n\n### `sk events`\n\nQuery audit events\n\n#### `sk events get`\n\nGet an audit event by id\n\n- `<id>` (positional, required) — Event id\n\n#### `sk events list`\n\nList audit events\n\n- `--limit` (string, default: 50) — Max rows\n- `--since` (string) — ISO timestamp lower bound\n- `--action` (string) — Filter by action\n- `--json` — JSON output\n\n\n### `sk executions`\n\nManage workflow executions\n\n#### `sk executions abort`\n\nAbort a running execution\n\n- `<id>` (positional) — Execution id\n\n#### `sk executions get`\n\nGet an execution by id\n\n- `<id>` (positional) — Execution id\n- `--json` (default: false) — JSON-only (skip Output files line)\n\n#### `sk executions list`\n\nList executions\n\n- `--limit` (string, default: 20) — Max rows\n- `--status` (string) — Filter by status\n- `--source` (string) — Filter by request source (e.g. scheduler, cli, api, mcp, chat)\n- `--parent` (string) — Lineage filter: list the reruns spawned from this execution id\n- `--from` (string) — Only runs that started at or after this instant (ISO-8601 or now-24h, now-7d, startOfMonth)\n- `--to` (string) — Only runs that started before this instant (exclusive; default: open)\n- `--cursor` (string) — Continue after a previous page (the next_cursor it printed)\n- `--json` (default: false) — JSON output\n\n#### `sk executions rerun`\n\nRe-run a previous execution against the workflow + input it carried. Useful after diagnose/repair.\n\n- `<id>` (positional) — Execution id to rerun\n- `--input` (string) — Override the original input (JSON string). Omit to reuse it verbatim.\n- `--follow` — Queue the rerun and stream its progress live (step-by-step JSON lines).\n\n#### `sk executions result`\n\nPrint the final output a workflow execution produced\n\n- `<id>` (positional) — Execution id\n- `--json` (default: false) — JSON-only output\n\n#### `sk executions steps`\n\nList steps for an execution\n\n- `<id>` (positional) — Execution id\n- `--json` (default: false) — JSON output\n\n#### `sk executions tail`\n\nStream live output from an execution\n\n- `<id>` (positional) — Execution id\n\n\n### `sk extract`\n\nExtract structured data from a file (LLM for text, native parsers for binary)\n\n- `<file>` (positional, required) — Path to sample file\n- `--hint` (string) — Hint to the LLM extractor (text inputs only)\n\n\n### `sk files`\n\nManage files (upload, download, link, …)\n\n#### `sk files delete`\n\nSoft-delete a file\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--force` (default: false) — Skip confirmation prompt\n\n#### `sk files download`\n\nDownload a file by id\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--output` (string) — Output path (default: ./<filename>, '-' for stdout)\n- `--quiet` (default: false) — Suppress progress output\n\n#### `sk files get`\n\nShow file metadata\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--json` (default: false) — JSON output\n\n#### `sk files link`\n\nAttach a file to an owning resource (conversation, knowledge_source, …)\n\n- `<fid>` (positional, required) — File id (fid_…)\n- `--to` (string, required) — Owning resource as <resource_type>:<id>\n- `--slug` (string) — Optional slug for the link\n- `--role` (string) — Optional role for the link\n\n#### `sk files list`\n\nList files\n\n- `--status` (string) — Filter by status (pending|ready|failed|…)\n- `--linked-to` (string) — Filter to files linked to <type>:<id> (e.g. conversation:abc-…)\n- `--cursor` (string) — Pagination cursor\n- `--limit` (string, default: 20) — Max rows (1-100)\n- `--json` (default: false) — JSON output\n\n#### `sk files patch`\n\nRename a file or change its description or category\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--filename` (string) — New filename\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--json` — JSON-only output\n\n#### `sk files replace`\n\nReplace a file's content (up to 5 MB); the id, reference and earlier versions stay\n\n- `<id>` (positional, required) — File id (fid_…)\n- `<path>` (positional, required) — Path to the new content\n- `--content-type` (string) — Override detected MIME type\n- `--json` (default: false) — JSON output\n\n#### `sk files restore`\n\nMake an earlier content version current again as a new version\n\n- `<id>` (positional, required) — File id (fid_…)\n- `<version>` (positional, required) — Version number to restore\n- `--json` (default: false) — JSON output\n\n#### `sk files stats`\n\nAggregate file counters for this tenant\n\n- `--by` (string) — Group by: status|scanner_verdict (default: status)\n- `--json` (default: false) — JSON output\n\n#### `sk files upload`\n\nUpload a file (inline ≤5 MB, authenticated streaming above)\n\n- `<path>` (positional, required) — Path to file\n- `--content-type` (string) — Override detected MIME type\n- `--no-dedup` (default: false) — Skip the client-side sha256 dedup probe (forces an upload)\n- `--link-to` (string) — After upload, link the file to <resource_type>:<id>\n- `--slug` (string) — Optional slug for the link\n- `--role` (string) — Optional role for the link\n- `--label` (string) — Reserved for future labels (no-op today)\n- `--quiet` (default: false) — Suppress progress output\n- `--json` (default: false) — JSON output (also silences progress)\n\n#### `sk files versions`\n\nList a file's current and earlier content versions\n\n- `<id>` (positional, required) — File id (fid_…)\n- `--json` (default: false) — JSON output\n\n\n### `sk health`\n\nRuntime posture: liveness, token budget, failing runs, risk signals, schema drift, and process runtime. Use `sk doctor` for connectivity/setup.\n\n- `--engine-url` (string) — Engine base URL\n- `--window-hours` (string) — Lookback window for failing runs (default 24)\n- `--json` — JSON output (composite object)\n\n\n### `sk hooks`\n\nManage inbound webhook bindings\n\n#### `sk hooks create`\n\nCreate an inbound webhook binding. The signing secret is read from a file (or - for stdin), never from an argument.\n\n- `--slug` (string, required) — Public path: POST /v1/hooks/<slug>\n- `--workflow-id` (string, required) — Workflow id to bind\n- `--verifier` (string, default: standard) — Signature scheme: standard | github | stripe | hmac\n- `--secret-file` (string, required) — File holding the shared signing secret (- reads stdin)\n- `--config-file` (string) — JSON file for native_verifier_config, e.g. {\"hmac\": {...}} for the hmac verifier\n\n#### `sk hooks delete`\n\nDelete an inbound webhook binding\n\n- `<id>` (positional, required) — Hook id\n\n#### `sk hooks get`\n\nGet an inbound webhook binding\n\n- `<id>` (positional, required) — Hook id\n\n#### `sk hooks list`\n\nList inbound webhook bindings\n\n- `--json` — JSON output\n\n\n### `sk init`\n\nComplete first-run engine bootstrap (consumes the token printed at engine boot)\n\n- `--token` (string) — One-time bootstrap token printed by the engine on first boot\n- `--engine-url` (string) — Engine base URL (defaults to http://localhost:3000)\n- `--profile` (string) — Profile to write the new admin key into (default: default)\n- `--admin-email` (string) — Admin user email (skip prompt)\n- `--tenant-name` (string) — Tenant display name (skip prompt)\n- `--llm-provider` (string) — LLM provider: mock|anthropic|openai|gemini|azure|bedrock|vertex (skip prompt)\n- `--llm-api-key` (string) — LLM API key (skip prompt)\n- `--llm-model` (string) — Model id the key is checked with and saved as llm.model (Azure: deployment name; needed for azure and bedrock)\n- `--defaults` — Never prompt: fill anything still missing with local defaults (mock LLM provider, tenant 'Local', admin email from git config)\n\n\n### `sk install`\n\nGuided setup for enterprise integrations\n\n#### `sk install github`\n\nInstall GitHub connector\n\n_No arguments._\n\n#### `sk install google-workspace`\n\nInstall Google Workspace connector\n\n_No arguments._\n\n#### `sk install hubspot`\n\nInstall HubSpot connector\n\n_No arguments._\n\n#### `sk install jira`\n\nInstall Jira connector\n\n_No arguments._\n\n#### `sk install salesforce`\n\nInstall Salesforce connector\n\n_No arguments._\n\n#### `sk install slack`\n\nInstall Slack notifications\n\n_No arguments._\n\n#### `sk install teams`\n\nInstall Microsoft Teams notifications\n\n_No arguments._\n\n\n### `sk intake`\n\nList collected items and start a selected Chat review\n\n#### `sk intake default`\n\nSet your personal default intake category\n\n- `--category` (string, required) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake discard`\n\nDiscard an intake item\n\n- `--item` (string, required) — Intake item UUID\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake list`\n\nList collected intake items in one shared category\n\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake move`\n\nMove an intake item to a shared category\n\n- `--item` (string, required) — Intake item UUID\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake restore`\n\nRestore a discarded intake item\n\n- `--item` (string, required) — Intake item UUID\n- `--category` (string) — Shared category name\n- `--json` — JSON output\n\n#### `sk intake review`\n\nStart a selected intake review in authenticated Cockpit chat\n\n- `--category` (string) — Shared category name\n- `--items` (string) — Comma-separated item UUIDs\n- `--lang` (string) — Language of the review: de or en\n- `--json` — JSON output\n\n\n### `sk invites`\n\nManage user-provisioning invites\n\n#### `sk invites list`\n\nList provisioning invites\n\n- `--status` (string) — Filter by status: pending|redeemed|revoked|expired\n- `--json` — JSON output\n\n#### `sk invites revoke`\n\nRevoke an un-redeemed invite\n\n- `<id>` (positional, required) — Invite id\n\n\n### `sk join`\n\nRedeem an invite to provision your personal API key (no login required)\n\n- `--invite` (string, required) — Single-use invite token from your admin\n- `--engine-url` (string) — Engine base URL (defaults to http://localhost:3000)\n- `--profile` (string) — Profile to write the new key into (default: default)\n\n\n### `sk knowledge-sources`\n\nManage knowledge sources\n\n#### `sk knowledge-sources analyze`\n\nGenerate a description + tags for a knowledge source via the engine LLM\n\n- `<id>` (positional, required) — Knowledge source id\n- `--force` (default: false) — Overwrite an existing description\n\n#### `sk knowledge-sources create`\n\nUpload a file as a knowledge source\n\n- `--file` (string, required) — Path to file\n- `--name` (string) — Source name (defaults to the filename)\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--tags` (string) — Comma-separated tags. When set, they are authoritative (no AI auto-tagging). Omit --description and --category to let the engine describe the source.\n- `--scope` (string) — Scope: global | workflow\n- `--workflow-id` (string) — Workflow id (required when scope=workflow)\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk knowledge-sources delete`\n\nDelete a knowledge source\n\n- `<id>` (positional, required) — Knowledge source id\n\n#### `sk knowledge-sources get`\n\nGet a knowledge source by id\n\n- `<id>` (positional, required) — Knowledge source id\n\n#### `sk knowledge-sources history`\n\nShow a knowledge source's content versions (newest first)\n\n- `<id>` (positional, required) — Knowledge source id\n- `--limit` (string) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources import`\n\nImport a directory of markdown files as one knowledge source (upsert by slug; OKF-compatible frontmatter is read tolerantly)\n\n- `<dir>` (positional, required) — Directory to import\n- `--name` (string) — Source name (defaults to root index.md H1 or dirname)\n- `--slug` (string) — Stable slug (defaults to slugified name)\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--tags` (string) — Comma-separated extra tags (frontmatter tags merge in)\n- `--scope` (string) — Scope: global | workflow\n- `--workflow-id` (string) — Workflow id (required when scope=workflow)\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources list`\n\nList knowledge sources\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources patch`\n\nUpdate a knowledge source\n\n- `<id>` (positional, required) — Knowledge source id\n- `--name` (string) — New name\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--tags` (string) — Comma-separated tags (replaces existing)\n- `--status` (string) — Status: active | inactive\n\n#### `sk knowledge-sources restore`\n\nRestore an earlier content version; the result is a new version\n\n- `<id>` (positional, required) — Knowledge source id\n- `--to` (string, required) — Version number from `sk knowledge-sources history`\n- `--json` (default: false) — JSON output\n\n#### `sk knowledge-sources search`\n\nSemantic search across knowledge sources\n\n- `<query>` (positional, required) — Search query\n- `--tags` (string) — Comma-separated tags to narrow results\n- `--limit` (string, default: 10) — Max results\n- `--json` (default: false) — JSON output\n\n\n### `sk login`\n\nAuthenticate against a subkit engine\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — Scripted API-key login (skips device flow)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n- `--portal-token` (string) — Authenticate as a portal-token principal\n\n\n### `sk logout`\n\nDrop the active profile\n\n- `--profile` (string) — Profile name to clear (default: active)\n\n\n### `sk logs`\n\nTail the engine's runtime log ring. --follow streams via SSE; --since accepts 5m / 2h / 1d / ISO-8601.\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (audit:read required)\n- `--profile` (string) — Use a named profile\n- `--follow` (alias -f) — Live SSE tail (Ctrl-C to stop)\n- `--since` (string) — Start time — relative (5m, 2h, 1d), ISO-8601, or unix-ms\n- `--limit` (string) — Max entries when not following (default 200)\n- `--module` (string) — Filter by module name (e.g. migrate, scheduler)\n- `--action` (string) — Filter by action (e.g. drift_detected)\n- `--level` (string) — Minimum level (trace|debug|info|warn|error|fatal)\n- `--json` — Emit raw NDJSON for piping to jq, instead of pretty-printing\n\n\n### `sk ls`\n\nList cached conversation sessions for the active profile\n\n- `--limit` (string, default: 20) — Max rows\n- `--search` (string) — Filter by substring in title / alias\n- `--all` — Show every profile, not just the active one\n\n\n### `sk mcp`\n\nRun a stdio MCP server proxied to the engine\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (Bearer)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n\n\n### `sk notifications`\n\nManage notification channels, rules, deliveries, and the inbox\n\n#### `sk notifications channels`\n\nManage notification channels\n\n_No arguments._\n\n#### `sk notifications deliveries`\n\nNotification deliveries\n\n_No arguments._\n\n#### `sk notifications inbox`\n\nRead and acknowledge queued notifications\n\n- `--all` — Show everything queued, ignoring the stored cursor\n- `--unread` — Only tasks you have not marked read\n- `--actionable` — Only tasks that need someone to act\n- `--limit` (string) — Max rows (<=500)\n- `--json` — JSON output\n\n#### `sk notifications rules`\n\nManage notification rules\n\n_No arguments._\n\n\n### `sk packages`\n\nMove this workspace to another engine: export a package archive, import one with a reviewed plan, list past imports\n\n#### `sk packages export`\n\nExport this workspace as a package archive (workflows, connectors without credentials, templates, skills, schedules, knowledge, files)\n\n- `--out` (string, required) — Path of the archive to write\n- `--only` (string) — Comma-separated kinds to export (connector_template, connector, file, skill, workflow, schedule, knowledge)\n- `--category` (string) — Comma-separated catalog categories to export, one area per package\n- `--json` — JSON output\n- `--profile` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n#### `sk packages import`\n\nImport a package archive: shows the plan, asks for confirmation (--yes to skip), then applies exactly that plan\n\n- `<file>` (positional, required) — Package archive (.zip)\n- `--yes` — Apply without asking\n- `--json` — JSON output\n- `--profile` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n#### `sk packages installs`\n\nList past package imports, or show one with its items\n\n- `<id>` (positional) — Install id\n- `--json` — JSON output\n- `--profile` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n\n### `sk patch-candidates`\n\nManage patch candidates\n\n#### `sk patch-candidates approve`\n\nApprove a patch candidate\n\n- `<id>` (positional, required) — Patch candidate id\n- `--review-digest` (string, required) — Digest from the reviewed candidate preview\n\n#### `sk patch-candidates get`\n\nGet a patch candidate by id\n\n- `<id>` (positional, required) — Patch candidate id\n\n#### `sk patch-candidates list`\n\nList patch candidates\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk patch-candidates preview`\n\nReview the exact repair diff and approval digest\n\n- `<id>` (positional, required) — Patch candidate id\n\n#### `sk patch-candidates reject`\n\nReject a patch candidate\n\n- `<id>` (positional, required) — Patch candidate id\n- `--reason` (string) — Rejection reason\n\n\n### `sk portal-tokens`\n\nManage portal tokens\n\n#### `sk portal-tokens create`\n\nIssue a portal token (shown once)\n\n- `--name` (string, required) — Token name\n- `--user-id` (string) — User id to bind the token to\n- `--expires` (string) — Expiry — ISO-8601 timestamp\n\n#### `sk portal-tokens list`\n\nList portal tokens\n\n- `--json` — JSON output\n\n#### `sk portal-tokens revoke`\n\nRevoke a portal token\n\n- `<id>` (positional, required) — Token id\n\n\n### `sk profile`\n\nManage named profiles (environments)\n\n#### `sk profile add`\n\nCreate a new profile (guided setup)\n\n- `--name` (string) — Profile name\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n\n#### `sk profile delete`\n\nDelete a saved profile\n\n- `<name>` (positional, required) — Profile name to delete\n\n#### `sk profile list`\n\nList all saved profiles\n\n_No arguments._\n\n#### `sk profile show`\n\nShow profile details + health check\n\n- `<name>` (positional) — Profile name (default: active)\n\n#### `sk profile use`\n\nSwitch the active profile\n\n- `<name>` (positional) — Profile name to activate\n\n\n### `sk rbac`\n\nManage RBAC roles, permissions, grants, groups, and hooks\n\n#### `sk rbac can`\n\nCheck whether a principal holds a permission\n\n- `<principal>` (positional, required) — Principal id\n- `<permission>` (positional, required) — Permission name\n- `<resource>` (positional) — Optional resource in <type>:<id> form\n- `--json` — JSON output\n\n#### `sk rbac grants`\n\nManage resource grants\n\n_No arguments._\n\n#### `sk rbac groups`\n\nManage groups\n\n_No arguments._\n\n#### `sk rbac permissions`\n\nBrowse the permission catalog\n\n_No arguments._\n\n#### `sk rbac request-hooks`\n\nManage before-request hooks\n\n_No arguments._\n\n#### `sk rbac roles`\n\nManage RBAC roles\n\n_No arguments._\n\n#### `sk rbac users`\n\nManage user role bindings\n\n_No arguments._\n\n#### `sk rbac whatcan`\n\nShow your effective access level on a connector (none/read-only/read-write)\n\n- `<connector>` (positional, required) — Connector id\n- `--json` — JSON output\n\n\n### `sk rename`\n\nAssign or change a short alias for a session (used by `sk -r <alias>`)\n\n- `<ref>` (positional, required) — Conversation id or existing alias\n- `<alias>` (positional, required) — New alias\n\n\n### `sk review`\n\nAggregated approval digest: pending patch candidates, proposed skill candidates, and recent failed executions.\n\n- `--limit` (string, default: 10) — Max rows per section\n- `--json` (default: false) — JSON output\n\n\n### `sk rm`\n\nDrop a session from the local cache (the server-side conversation row is preserved)\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n\n### `sk schedules`\n\nScheduled workflow runs\n\n#### `sk schedules create`\n\nSchedule a workflow (a workflow carries at most one schedule; re-create updates it)\n\n- `--workflow` (string, required) — Workflow id\n- `--cron` (string, required) — 5-field cron or \"every:<seconds>\" (e.g. \"0 8 * * *\")\n- `--timezone` (string) — IANA timezone (default UTC)\n- `--executionMode` (string, default: prod) — Connector environment: dev or prod (default prod)\n- `--paused` (default: false) — Create in paused state\n- `--input` (string) — JSON input payload passed to every run\n- `--json` (default: false) — JSON output\n\n#### `sk schedules delete`\n\nDelete a schedule\n\n- `<id>` (positional, required) — Schedule id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules list`\n\nList scheduled workflow runs\n\n- `--workflow` (string) — Filter by workflow id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules pause`\n\nPause a schedule (keeps the row)\n\n- `<id>` (positional, required) — Schedule id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules resume`\n\nResume a paused schedule\n\n- `<id>` (positional, required) — Schedule id\n- `--json` (default: false) — JSON output\n\n#### `sk schedules update`\n\nUpdate a schedule's cron, timezone, environment, or input\n\n- `<id>` (positional, required) — Schedule id\n- `--cron` (string) — New cron expression\n- `--timezone` (string) — New IANA timezone\n- `--executionMode` (string) — New connector environment: dev or prod\n- `--input` (string) — New JSON input payload\n- `--json` (default: false) — JSON output\n\n\n### `sk self-healing`\n\nTrigger and review proactive drift scans (admin)\n\n#### `sk self-healing list`\n\nList proactive drift scans\n\n- `--limit` (string, default: 20) — Max rows\n- `--status` (string) — Filter by status (running/succeeded/failed)\n- `--source` (string) — Filter by source (scheduler/admin_http/mcp)\n- `--json` (default: false) — JSON output\n\n#### `sk self-healing scan`\n\nTrigger a proactive self-healing drift scan\n\n- `--workflow` (string) — Scope validation-drift to this workflow id\n- `--connector` (string) — Scope schema-drift to this connector id\n- `--idempotency-key` (string) — Replay-safe key; a second call within 24h with the same key returns the original result\n- `--json` (default: false) — JSON output\n\n#### `sk self-healing show`\n\nShow a proactive drift scan by id\n\n- `<id>` (positional, required) — Scan id\n\n\n### `sk sessions`\n\nManage locally-cached conversation sessions\n\n#### `sk sessions ls`\n\nList cached conversation sessions for the active profile\n\n- `--limit` (string, default: 20) — Max rows\n- `--search` (string) — Filter by substring in title / alias\n- `--all` — Show every profile, not just the active one\n\n#### `sk sessions rename`\n\nAssign or change a short alias for a session (used by `sk -r <alias>`)\n\n- `<ref>` (positional, required) — Conversation id or existing alias\n- `<alias>` (positional, required) — New alias\n\n#### `sk sessions rm`\n\nDrop a session from the local cache (the server-side conversation row is preserved)\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n#### `sk sessions search`\n\nFuzzy-search cached sessions by title / alias / id\n\n- `<query>` (positional, required) — Search text\n- `--limit` (string, default: 20) — Max rows\n- `--all` — Search every profile, not just the active one\n\n#### `sk sessions show`\n\nShow cached metadata for a session by id or alias\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n\n### `sk settings`\n\nList, read, write, or interactively configure engine settings (secrets always masked)\n\n#### `sk settings configure`\n\nInteractive Ink palette for inspecting settings (← / → cycles tabs, type to filter in Config, Enter to edit, Esc to exit). In non-TTY environments use --non-interactive to print the JSON contract instead.\n\n- `--tab` (string) — Open directly on a tab: Status | Config | Usage | Skills | Knowledge\n- `--non-interactive` — Skip the Ink renderer; print the GET /v1/settings response as JSON. Auto-detected when stdin is not a TTY.\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n#### `sk settings get`\n\nRead one leaf by dotted path\n\n- `<path>` (positional, required) — Setting path (e.g. llm.api_key)\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n#### `sk settings list`\n\nList every leaf with its resolved value\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n#### `sk settings set`\n\nWrite one leaf. <value> must be valid JSON ('\"abc\"', 42, true, null).\n\n- `<path>` (positional, required) — Setting path\n- `<value>` (positional, required) — Value as JSON\n- `--force` — Bypass requiresRestart guard in production\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--tenant` (string) — Tenant id (writes a tenant overlay)\n- `--json` — JSON output\n\n\n### `sk show`\n\nShow cached metadata for a session by id or alias\n\n- `<ref>` (positional, required) — Conversation id or alias\n\n\n### `sk skill-candidates`\n\nManage skill candidates\n\n#### `sk skill-candidates approve`\n\nApprove a skill candidate\n\n- `<id>` (positional, required) — Candidate id\n\n#### `sk skill-candidates get`\n\nGet a skill candidate by id\n\n- `<id>` (positional, required) — Candidate id\n\n#### `sk skill-candidates list`\n\nList skill candidates\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk skill-candidates reject`\n\nReject a skill candidate\n\n- `<id>` (positional, required) — Candidate id\n- `--reason` (string) — Rejection reason\n\n\n### `sk skills`\n\nManage skills\n\n#### `sk skills activate`\n\nActivate a skill\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills archive`\n\nArchive a skill\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills create`\n\nCreate a skill from a JSON file\n\n- `--file` (string, required) — Path to SkillDef JSON\n\n#### `sk skills delete`\n\nDelete a skill\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills edit`\n\nUpdate a skill\n\n- `<id>` (positional, required) — Skill id\n- `--file` (string) — Path to JSON patch file\n- `--title` (string) — New title\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n\n#### `sk skills get`\n\nGet a skill by id\n\n- `<id>` (positional, required) — Skill id\n\n#### `sk skills history`\n\nShow a skill's version history (newest first)\n\n- `<id>` (positional, required) — Skill id\n- `--json` (default: false) — JSON output\n\n#### `sk skills list`\n\nList skills\n\n- `--limit` (string, default: 20) — Max rows\n- `--json` (default: false) — JSON output\n\n#### `sk skills patch`\n\nUpdate a skill\n\n- `<id>` (positional, required) — Skill id\n- `--file` (string) — Path to JSON patch file\n- `--title` (string) — New title\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n\n#### `sk skills restore`\n\nRestore a skill to a prior audited snapshot\n\n- `<id>` (positional, required) — Skill id\n- `--to` (string, required) — audit_entry_id from `sk skills history`\n\n#### `sk skills sync`\n\nMaterialize domain skills as SKILL.md for Claude Code and Codex\n\n- `--domains` (string) — Comma-separated domain slugs (default: .sk/agent.json of the repo)\n- `--json` (default: false) — JSON output\n\n\n### `sk stats`\n\nTenant-scoped runtime statistics (needs stats:read)\n\n#### `sk stats chat`\n\nChat turns, modes, deduplication, and outcomes\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats connectors`\n\nConnector-call volume + latency + outcome. Example: sk stats connectors --bucket hour --from now-24h\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--connector-id` (string) — Filter by connector id\n- `--connector-slug` (string) — Filter by connector slug\n- `--driver` (string) — Filter by driver (comma-separated)\n- `--method` (string) — Filter by method (comma-separated)\n- `--outcome` (string) — Filter by outcome (success,denied,error)\n- `--status-class` (string) — 2xx,3xx,4xx_other,4xx_auth,4xx_rate_limited,5xx,network_error,no_status\n- `--include-endpoint` — Add normalized endpoint-path axis\n\n#### `sk stats conversations`\n\nConversation calls, streams, disconnects, and outcomes\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats events`\n\nAudit-event volume by class (webhook_outbound, webhook_inbound, chat, notification, schedule, self_healing, discovery, execution_lifecycle, policy, external_write). Example: sk stats events --class self_healing --bucket day --from now-7d\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--class` (string, required) — One of: webhook_outbound, webhook_inbound, chat, notification, schedule, self_healing, discovery, execution_lifecycle, policy, external_write\n- `--outcome` (string) — Filter by outcome (success,denied,error)\n\n#### `sk stats executions`\n\nWorkflow run volume + duration distribution. Example: sk stats executions --bucket hour --from now-24h\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--workflow-id` (string) — Filter by workflow id\n- `--status` (string) — Filter by status (comma-separated: succeeded,failed,…)\n- `--request-source` (string) — Filter by request source (open set, e.g. api,scheduler,wait_reaper)\n- `--execution-mode` (string) — dev|prod\n\n#### `sk stats http`\n\nHTTP route volume, latency, bytes, and errors\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats llm`\n\nLLM token usage + cache-hit + latency. Example: sk stats llm --bucket day --from startOfMonth\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--model` (string) — Filter by model (comma-separated)\n- `--flow` (string) — Filter by flow (comma-separated)\n- `--user-id` (string) — Scope to one user (another user needs stats:read:all)\n- `--mine` — Scope to your own usage (resolves your user id automatically)\n\n#### `sk stats mcp`\n\nMCP JSON-RPC, sessions, capacity, tasks, and SSE\n\n- `--bucket` (string) — minute|hour|day|month|year\n- `--from` (string) — ISO-8601 or relative (now-24h, now-7d, startOfMonth)\n- `--to` (string) — ISO-8601 or relative (default: now)\n- `--tz` (string) — IANA timezone (default UTC)\n- `--group-by` (string) — comma-separated group dimensions (≤2)\n- `--json` (default: false) — raw JSON output\n- `--traffic-class` (string) — organic|synthetic|internal (comma-separated; default organic)\n- `--operation` (string) — Filter canonical operation(s)\n- `--outcome` (string) — Filter outcome(s)\n- `--request-source` (string) — Filter request source(s)\n- `--platform` (string) — Filter platform(s)\n- `--response-mode` (string) — json|sse|sync|async|none\n\n#### `sk stats operations`\n\nThe Übersicht's operations figures: runs, success rate, healthy connectors (now), applied repairs. Example: sk stats operations --window 7d\n\n- `--window` (string) — 24h (default), 7d or 30d\n- `--from` (string) — Window start (ISO-8601 or now-24h, startOfMonth)\n- `--to` (string) — Window end (default: now)\n- `--json` — Emit the raw engine response\n\n\n### `sk status`\n\nPrint the active profile + engine reachability\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (Bearer)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n\n\n### `sk subscriptions`\n\nManage event subscriptions\n\n#### `sk subscriptions create`\n\nCreate a subscription\n\n- `--event` (string, required) — Event type\n- `--workflow-id` (string, required) — Workflow id\n\n#### `sk subscriptions delete`\n\nDelete a subscription\n\n- `<id>` (positional, required) — Subscription id\n\n#### `sk subscriptions deliveries`\n\nShow deliveries for a subscription\n\n- `<id>` (positional, required) — Subscription id\n\n#### `sk subscriptions get`\n\nGet a subscription\n\n- `<id>` (positional, required) — Subscription id\n\n#### `sk subscriptions list`\n\nList subscriptions\n\n- `--json` — JSON output\n\n#### `sk subscriptions patch`\n\nUpdate a subscription\n\n- `<id>` (positional, required) — Subscription id\n- `--active` (string, required) — Set active state (true|false)\n\n#### `sk subscriptions replay`\n\nReplay a subscription delivery\n\n- `<sub-id>` (positional, required) — Subscription id\n- `<delivery-id>` (positional, required) — Delivery id\n\n\n### `sk system`\n\nEngine process operations (restart)\n\n#### `sk system restart`\n\nRestart the engine so a saved restart-sensitive setting takes effect (needs a supervisor)\n\n- `--wait` — Wait (up to 240 s) until the restarted engine runs the saved settings\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key\n- `--profile` (string) — Profile name\n- `--json` — JSON output\n\n\n### `sk system-accounts`\n\nManage system accounts\n\n#### `sk system-accounts create`\n\nCreate a system account\n\n- `--name` (string, required) — Account name\n\n#### `sk system-accounts delete`\n\nDelete a system account\n\n- `<id>` (positional, required) — Account id\n\n#### `sk system-accounts list`\n\nList system accounts\n\n- `--json` — JSON output\n\n\n### `sk tenants`\n\nList tenants you belong to or switch the active one\n\n- `--engine-url` (string) — Engine base URL\n- `--api-key` (string) — API key (Bearer)\n- `--tenant` (string) — Active tenant id\n- `--profile` (string) — Profile name (~/.sk/config.json)\n- `<use>` (positional) — Tenant id to switch to\n\n\n### `sk update`\n\nUpdate sk CLI to the latest version from your engine, falling back to GitHub releases\n\n- `--force` (default: false) — Force re-download even if already up to date\n- `--check` (default: false) — Check for updates without installing\n- `--channel` (string, default: stable) — Release channel: stable | beta\n- `--rollback` (default: false) — Restore the most recent retained sk binary\n- `--to` (string) — With --rollback, the explicit version to restore (default: most recent retained)\n\n\n### `sk users`\n\nManage identity users\n\n#### `sk users create`\n\nCreate a user in the caller's tenant\n\n- `--email` (string, required) — User email\n- `--role` (string) — Role: admin|member|enduser (default member)\n- `--json` — JSON output\n\n#### `sk users delete`\n\nDelete a user\n\n- `<id>` (positional, required) — User id\n\n#### `sk users get`\n\nFetch a user by id\n\n- `<id>` (positional, required) — User id\n\n#### `sk users invite`\n\nIssue a single-use provisioning invite for a user (token shown once)\n\n- `<id>` (positional, required) — User id to invite\n- `--scopes` (string) — Comma-separated scope strings (default: your own credential's scopes; [\"*\"] only when your credential has no scope limits)\n- `--allowed-workflows` (string) — Comma-separated workflow ids/slugs\n- `--allowed-connectors` (string) — Comma-separated connector ids/slugs\n- `--ttl` (string) — Invite lifetime in minutes\n- `--json` — JSON output\n\n#### `sk users list`\n\nList identity users\n\n- `--limit` (string) — Max rows\n- `--app` (string) — Only users who signed in to this app (product_id, see sk apps list)\n- `--json` — JSON output\n\n#### `sk users patch`\n\nUpdate a user's role (admin only)\n\n- `<id>` (positional, required) — User id\n- `--role` (string, required) — New role: admin|member|enduser\n\n\n### `sk workflows`\n\nManage workflows\n\n#### `sk workflows create`\n\nCreate a workflow from a JSON file (--file) or a solution recipe (--from-recipe <slug>, see `sk connector-templates recipe-pack solutions`). Runs `validate` and `preview` by default; pass --skip-checks to bypass.\n\n- `--file` (string) — Path to WorkflowDef JSON\n- `--from-recipe` (string) — Slug of a solution recipe; its connectors are bound to the ones you already have\n- `--bind` (string) — With --from-recipe: bind connectors yourself, as <template or placeholder>=<connector id or slug>[,…]; needed for templates without a fixed address such as http\n- `--environment` (string, default: dev) — Where the pre-flight preview runs: dev (default) or prod. Use the environment the workflow's schedule or webhook runs in; writes stay held either way.\n- `--skip-checks` — Skip the validate+preview pre-flight entirely (NOT recommended). Preview warnings never block; only validation errors and preview failures do.\n- `--input` (string) — Input JSON string passed to the preview dry-run. With --from-recipe it defaults to the recipe's sample input.\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk workflows delete`\n\nDelete a workflow\n\n- `<id>` (positional) — Workflow id\n\n#### `sk workflows dry-run`\n\nPreview a draft WorkflowDef by dry-running it via runExecution (source=draft). No persistence. Alias: dry-run.\n\n- `<file>` (positional, required) — Path to WorkflowDef JSON\n- `--input` (string) — Input JSON string\n- `--name` (string) — Optional label (goes to executions.source_ref)\n- `--environment` (string, default: dev) — Where the run executes: dev (default) or prod. Sent as the x-subkit-environment header; write steps need a connector bound to this environment.\n\n#### `sk workflows get`\n\nGet a workflow by id\n\n- `<id>` (positional) — Workflow id\n\n#### `sk workflows history`\n\nList committed versions of a workflow\n\n- `<id>` (positional, required) — Workflow id\n- `--json` — JSON output\n\n#### `sk workflows invoke-snippet`\n\nEmit a ready-to-paste, authenticated snippet to run a saved workflow from your own app or CI (curl/node/python).\n\n- `<id>` (positional, required) — Workflow id\n- `--lang` (string, default: curl) — Snippet language: curl (default), node, or python\n- `--environment` (string, default: prod) — Where the call runs: prod (default) or dev. Printed as the x-subkit-environment header.\n- `--json` — JSON output\n\n#### `sk workflows list`\n\nList workflows, grouped into catalog blocks\n\n- `--limit` (string, default: 50) — Max rows\n- `--category` (string) — Only this catalog block\n- `--connector` (string) — Only workflows using this connector (id or slug)\n- `--flat` — One flat table instead of grouped blocks\n- `--json` — JSON output\n\n#### `sk workflows patch`\n\nChange a workflow's name, description or category without saving a new version (the slug and its wf_<slug> tool stay as they are).\n\n- `<workflow>` (positional, required) — Workflow id or slug\n- `--name` (string) — New display name\n- `--description` (string) — What it is for, in plain language — the assistant reads this to pick the right object. \"\" hands it back to automatic description.\n- `--category` (string) — Catalog block, lowercase words joined by dashes (see `sk categories list`). \"\" hands it back to automatic categorisation.\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk workflows preview`\n\nPreview a draft WorkflowDef by dry-running it via runExecution (source=draft). No persistence. Alias: dry-run.\n\n- `<file>` (positional, required) — Path to WorkflowDef JSON\n- `--input` (string) — Input JSON string\n- `--name` (string) — Optional label (goes to executions.source_ref)\n- `--environment` (string, default: dev) — Where the run executes: dev (default) or prod. Sent as the x-subkit-environment header; write steps need a connector bound to this environment.\n\n#### `sk workflows restore`\n\nRestore a prior workflow version\n\n- `<id>` (positional, required) — Workflow id\n- `<version>` (positional, required) — Version number\n\n#### `sk workflows run`\n\nRun a saved workflow, an inline draft definition, or a single step\n\n- `<id>` (positional) — Workflow id or slug (omit when using --draft or --step)\n- `--input` (string) — Input JSON string. Prefix with `@` to read from a file (e.g. `--input @./payload.json`).\n- `--input-file` (string) — Upload a file and substitute its ref into --input at key K. Format: K=<path>. Repeatable.\n- `--draft` (string) — Path to a draft WorkflowDef JSON file (no commit)\n- `--step` (string) — Path to a single StepDef JSON file (no workflow persistence)\n- `--name` (string) — Optional label for --draft runs (goes to executions.source_ref)\n- `--slug` (string) — Optional workflow_slug for --step runs (cosmetic)\n- `--follow` — Queue the run and stream its progress live (step-by-step JSON lines). Saved workflows only.\n- `--idempotency-key` (string) — Make this trigger safe to repeat: a second run with the same key is not started, the first run's id comes back instead. Saved workflows only.\n- `--environment` (string, default: dev) — Where the run executes: dev (default) or prod. Sent as the x-subkit-environment header; write steps need a connector bound to this environment.\n\n#### `sk workflows update`\n\nUpdate a workflow from a JSON file (PUT the full definition). Runs `validate` and `preview` by default; pass --skip-checks to bypass. An unchanged definition does not rotate a version.\n\n- `<id>` (positional, required) — Workflow id\n- `--file` (string, required) — Path to WorkflowDef JSON\n- `--environment` (string, default: dev) — Where the pre-flight preview runs: dev (default) or prod. Use the environment the workflow's schedule or webhook runs in; writes stay held either way.\n- `--skip-checks` — Skip the validate+preview pre-flight entirely (NOT recommended). Preview warnings never block; only validation errors and preview failures do.\n- `--input` (string) — Input JSON string passed to the preview dry-run.\n- `--json` — JSON-only output (suppresses narration)\n\n#### `sk workflows validate`\n\nValidate a draft WorkflowDef JSON file (structural + step schema checks). No execution, no persistence.\n\n- `<file>` (positional, required) — Path to WorkflowDef JSON"
        }
      }
    },
    {
      "slug": "settings",
      "llms_path": "settings.md",
      "audience": "public",
      "section": "reference",
      "order": 2,
      "generated": true,
      "locales": {
        "en": {
          "title": "SubKit runtime settings",
          "summary": "Look up every runtime setting with its description and default value.",
          "headings": [
            {
              "depth": 1,
              "text": "SubKit runtime settings",
              "anchor": "subkit-runtime-settings"
            },
            {
              "depth": 2,
              "text": "log",
              "anchor": "log"
            },
            {
              "depth": 2,
              "text": "server",
              "anchor": "server"
            },
            {
              "depth": 2,
              "text": "database",
              "anchor": "database"
            },
            {
              "depth": 2,
              "text": "llm",
              "anchor": "llm"
            },
            {
              "depth": 2,
              "text": "auth",
              "anchor": "auth"
            },
            {
              "depth": 2,
              "text": "platform",
              "anchor": "platform"
            },
            {
              "depth": 2,
              "text": "storage",
              "anchor": "storage"
            },
            {
              "depth": 2,
              "text": "observability",
              "anchor": "observability"
            },
            {
              "depth": 2,
              "text": "egress",
              "anchor": "egress"
            },
            {
              "depth": 2,
              "text": "mcp",
              "anchor": "mcp"
            },
            {
              "depth": 2,
              "text": "errors",
              "anchor": "errors"
            },
            {
              "depth": 2,
              "text": "spec",
              "anchor": "spec"
            },
            {
              "depth": 2,
              "text": "queue",
              "anchor": "queue"
            },
            {
              "depth": 2,
              "text": "tokens",
              "anchor": "tokens"
            },
            {
              "depth": 2,
              "text": "operations",
              "anchor": "operations"
            },
            {
              "depth": 2,
              "text": "sandbox",
              "anchor": "sandbox"
            },
            {
              "depth": 2,
              "text": "repl",
              "anchor": "repl"
            },
            {
              "depth": 2,
              "text": "ui",
              "anchor": "ui"
            },
            {
              "depth": 2,
              "text": "notifications",
              "anchor": "notifications"
            },
            {
              "depth": 2,
              "text": "connectors",
              "anchor": "connectors"
            },
            {
              "depth": 2,
              "text": "products",
              "anchor": "products"
            },
            {
              "depth": 2,
              "text": "Authentication providers",
              "anchor": "authentication-providers"
            }
          ],
          "images": [],
          "sha256": "9bfb10135b1b56d5c4560a2098ee2f0af5d865f1b29288014eb448abbe2b0a58",
          "body": "# SubKit runtime settings\n\nLook up every runtime setting with its description and default value.\nYou change a value in the Cockpit, through the HTTP or MCP settings APIs, or with\n`sk settings configure` and `sk settings set`. Per-tenant overrides go into the\nfile's `tenants` section and only apply to settings tagged `scope=tenant`.\n\nA value resolves in this order: tenant overlay, then global value, then schema\ndefault. Environment variables never set a runtime setting.\n\n## log\nLogging\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `log.format` | enum(\"dev\" \\| \"pretty\" \\| \"prod\" \\| \"ndjson\" \\| \"json\") | `\"ndjson\"` | global | no | no | Log output format |\n| `log.level` | enum(\"trace\" \\| \"debug\" \\| \"info\" \\| \"warn\" \\| \"error\" \\| \"fatal\") | `\"info\"` | global | no | no | Log verbosity |\n\n## server\nHTTP server\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `server.hosted_rate_limit.global_per_minute` | number | `0` | global | no | no | Operator request ceiling across hosted ingress per minute; zero denies hosted ingress |\n| `server.hosted_rate_limit.peer_per_minute` | number | `0` | global | no | no | Operator request ceiling per verified connection peer and minute; zero denies hosted ingress |\n| `server.hosted_rate_limit.principal_per_minute` | number | `0` | global | no | no | Operator request ceiling per authenticated principal and tenant per minute; zero denies hosted requests |\n| `server.hosted_rate_limit.tenant_per_minute` | number | `0` | global | no | no | Operator request ceiling per hosted tenant and minute; zero denies hosted requests |\n| `server.hosted_rate_limit.tenant_per_month` | number | `0` | global | no | no | Operator request allowance per hosted tenant and UTC calendar month; zero denies hosted requests |\n| `server.port` | number | `3000` | global | no | yes | HTTP port to bind (1..65535) |\n| `server.public_base_url` | string | `\"\"` | global | no | no | External-facing URL the engine resolves at. Used by /install, chat link replies, and OAuth2 redirect-URI synthesis. Required for any OAuth2 connector. |\n| `server.restart_supervised` | boolean | `false` | global | no | no | A supervisor (systemd with Restart=on-failure, Docker with a restart policy) starts the engine again after it ends. Enables POST /v1/system/restart (exit code 75). |\n| `server.root_redirect_to_cockpit` | boolean | `false` | global | no | no | Redirect a browser's GET / (Accept: text/html) to /cockpit with a non-cacheable temporary redirect. Other clients keep the Markdown entry point. Disabled by default. |\n| `server.trusted_proxy_hops` | number | `0` | global | no | no | Trusted reverse-proxy hops counted from the right of X-Forwarded-For; zero ignores forwarding headers. |\n| `server.trusted_proxy_ips` | array | `[]` | global | no | no | Exact trusted reverse-proxy socket peer IPs. Every configured forwarding hop must match; X-Real-IP is never trusted. |\n\n## database\nDatabase connection\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `database.connect_timeout_ms` | number | `10000` | global | no | yes | Deadline for acquiring or establishing a PostgreSQL connection. |\n| `database.idle_timeout_ms` | number | `30000` | global | no | yes | Time before an unused pooled connection is closed. |\n| `database.keepalive_delay_ms` | number | `10000` | global | no | yes | Initial TCP keepalive delay for PostgreSQL connections. |\n| `database.pool_max` | number | `10` | global | no | yes | Maximum application connections per pool and replica. |\n| `database.query_timeout_ms` | number | `150000` | global | no | yes | Client-side PostgreSQL query deadline in milliseconds. |\n| `database.statement_timeout_ms` | number | `120000` | global | no | yes | Server-side PostgreSQL statement deadline, initialized on each session. |\n| `database.url` | string | `—` | global | yes | yes | Bootstrap-only Postgres connection string. Rotate DATABASE_URL and restart replicas; runtime revisions cannot change this binding. |\n\n## llm\nLLM configuration\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `llm.api_key` | string | `\"\"` | tenant | yes | no | Primary LLM API key |\n| `llm.context_1m` | boolean | `false` | tenant | no | no | Enable 1M context window where supported |\n| `llm.critic.enabled` | boolean | `false` | tenant | no | no | Run the second-stage LLM critic on workflow drafts after every static gate passes |\n| `llm.critic.max_consecutive_rejections` | number | `3` | tenant | no | no | After this many consecutive critic_rejected results in a conversation, skip the critic to avoid an infinite re-author loop |\n| `llm.critic.min_steps` | number | `3` | tenant | no | no | Minimum step count for the critic to run on a draft (drift in recent drafts also triggers a run) |\n| `llm.fallback_model` | string | `\"\"` | tenant | no | no | Fallback model identifier |\n| `llm.fallback_provider` | enum(\"mock\" \\| \"anthropic\" \\| \"openai\" \\| \"gemini\" \\| \"azure\" \\| \"bedrock\" \\| \"vertex\" \\| \"ai_gateway\") | `null` | tenant | no | no | Fallback provider on primary failure |\n| `llm.hosted.enabled` | boolean | `false` | global | no | no | Hosted paid-model service mode; requires tenant context independently of signup policy. |\n| `llm.hosted.global_monthly_microunits` | string | `\"0\"` | global | no | no | Operator-owned global monthly hosted budget in USD microunits; zero blocks paid calls. |\n| `llm.hosted.models` | json | `[]` | global | no | no | Exact provider:model allowlist with verified provider-enforced context maxima, including extended context, and maximum USD rates for every context tier. No paid native tools or multimodal inputs. |\n| `llm.hosted.tenant_monthly_microunits` | string | `\"0\"` | global | no | no | Operator-owned monthly hosted budget per tenant in USD microunits; zero blocks paid calls. |\n| `llm.model` | string | `\"\"` | tenant | no | no | Primary model identifier |\n| `llm.output_guard` | enum(\"soft\" \\| \"hard\" \\| \"off\") | `\"soft\"` | global | no | no | LLM output safety mode (soft: rewrite + log, hard: throw, off: bypass — never use in production) |\n| `llm.provider` | enum(\"mock\" \\| \"anthropic\" \\| \"openai\" \\| \"gemini\" \\| \"azure\" \\| \"bedrock\" \\| \"vertex\" \\| \"ai_gateway\") | `\"mock\"` | tenant | no | no | Primary LLM provider |\n| `llm.providers.ai_gateway.api_key` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.ai_gateway.model` | string | `\"\"` | global | no | no |  |\n| `llm.providers.anthropic.api_key` | string | `\"\"` | tenant | yes | no | API key for this provider |\n| `llm.providers.anthropic.base_url` | string | `\"\"` | global | no | no | Optional base URL override |\n| `llm.providers.anthropic.model` | string | `\"\"` | tenant | no | no | Default model identifier |\n| `llm.providers.azure.api_key` | string | `\"\"` | tenant | yes | no |  |\n| `llm.providers.azure.api_version` | string | `\"\"` | global | no | no |  |\n| `llm.providers.azure.base_url` | string | `\"\"` | global | no | no |  |\n| `llm.providers.azure.model` | string | `\"\"` | tenant | no | no |  |\n| `llm.providers.azure.resource_name` | string | `\"\"` | global | no | no |  |\n| `llm.providers.azure.use_deployment_based_urls` | boolean | `false` | global | no | no |  |\n| `llm.providers.bedrock.access_key_id` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.bedrock.base_url` | string | `\"\"` | global | no | no |  |\n| `llm.providers.bedrock.model` | string | `\"\"` | tenant | no | no |  |\n| `llm.providers.bedrock.region` | string | `\"\"` | global | no | no |  |\n| `llm.providers.bedrock.secret_access_key` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.bedrock.session_token` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.gemini.api_key` | string | `\"\"` | tenant | yes | no | API key for this provider |\n| `llm.providers.gemini.base_url` | string | `\"\"` | global | no | no | Optional base URL override |\n| `llm.providers.gemini.model` | string | `\"\"` | tenant | no | no | Default model identifier |\n| `llm.providers.openai.api_key` | string | `\"\"` | tenant | yes | no | API key for this provider |\n| `llm.providers.openai.base_url` | string | `\"\"` | global | no | no | Optional base URL override |\n| `llm.providers.openai.model` | string | `\"\"` | tenant | no | no | Default model identifier |\n| `llm.providers.vertex.api_key` | string | `\"\"` | tenant | yes | no |  |\n| `llm.providers.vertex.client_email` | string | `\"\"` | global | no | no |  |\n| `llm.providers.vertex.google_application_credentials` | string | `\"\"` | global | no | no |  |\n| `llm.providers.vertex.location` | string | `\"\"` | global | no | no |  |\n| `llm.providers.vertex.model` | string | `\"\"` | tenant | no | no |  |\n| `llm.providers.vertex.private_key` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.vertex.project` | string | `\"\"` | global | no | no |  |\n| `llm.suggestion_model` | string | `\"\"` | tenant | no | no | Small model used to generate post-turn suggestions; empty uses the primary provider's default |\n| `llm.summarize_model` | string | `\"\"` | tenant | no | no | Model used for summarization passes |\n| `llm.summarize_provider` | enum(\"mock\" \\| \"anthropic\" \\| \"openai\" \\| \"gemini\" \\| \"azure\" \\| \"bedrock\" \\| \"vertex\" \\| \"ai_gateway\") | `null` | tenant | no | no | Provider used for summarization passes |\n| `llm.web_search` | boolean | `true` | tenant | no | no | Allow the assistant to use Anthropic-native server-side web search (billed per search; Anthropic models only). Toggle off per tenant via /settings. |\n\n## auth\nAuthentication\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `auth.enable_signup` | boolean | `false` | global | no | no | Compatibility fallback for self-hosted OIDC providers without signup_policy: allow first-time SSO member accounts. Explicit provider policies override it; hosted signup never uses it. |\n| `auth.hosted.admission.mcp_clients_per_minute` | number | `0` | global | no | no | Operator global hosted MCP dynamic-client registration ceiling per minute. |\n| `auth.hosted.admission.mcp_clients_per_peer_per_minute` | number | `0` | global | no | no | Operator hosted MCP dynamic-client registration ceiling per verified peer and minute. |\n| `auth.hosted.admission.retained_mcp_clients` | number | `0` | global | no | no | Operator ceiling for retained MCP client registrations, including retired and disabled clients; zero denies new clients. |\n| `auth.hosted.admission.retained_tenants` | number | `0` | global | no | no | Operator ceiling for retained self-service tenant records, including erased ownership tombstones; zero denies new tenants. |\n| `auth.hosted.admission.tenant_creations_per_minute` | number | `0` | global | no | no | Operator global ceiling for newly created self-service tenants per minute; idempotent callbacks do not consume it. |\n| `auth.hosted.enabled` | boolean | `false` | global | no | yes | Enable identity-first hosted browser authentication for explicitly opted-in providers. |\n| `auth.hosted.registration_enabled` | boolean | `false` | global | no | no | Allow new hosted identities to provision their own workspace. Existing members and reviewed invitation handoffs remain available while registration is closed. |\n| `auth.mcp_oauth.access_token_ttl_seconds` | number | `3600` | global | no | no | Lifetime in seconds for MCP OAuth access tokens. |\n| `auth.mcp_oauth.authorization_code_ttl_seconds` | number | `60` | global | no | no | Lifetime in seconds for MCP OAuth authorization codes. |\n| `auth.mcp_oauth.dynamic_registration_enabled` | boolean | `true` | global | no | no | Allow RFC 7591 dynamic client registration at POST /v1/oauth/register. |\n| `auth.mcp_oauth.enabled` | boolean | `true` | global | no | yes | Enable the MCP OAuth 2.1 authorization server (ChatGPT / Claude.ai / Cursor). |\n| `auth.mcp_oauth.refresh_token_ttl_seconds` | number | `2592000` | global | no | no | Lifetime in seconds for MCP OAuth refresh tokens (30 days). |\n| `auth.mcp_oauth.scopes_supported` | string[] | `[\"mcp:read\",\"mcp:authoring\",\"mcp:admin\",\"metrics:read\"]` | global | no | no | OAuth scopes advertised in the authorization server metadata. Add, reorder and remove freely, except metrics:read: GET /metrics enforces it, so it is restored whenever a written value omits it. |\n| `auth.providers` | json | `[{\"protocol\":\"api_key\",\"id\":\"api-key\",\"label\":\"SubKit API key\"}]` | global | no | no | Authentication adapters: api_key, oidc (public browser client with PKCE, no secret) and oidc_bearer (an issuer's access token as bearer for one product, verified against its JWKS). |\n| `auth.session.secret` | string | `\"\"` | global | yes | yes | Session signing secret (auto-generated to a 32-byte hex value on first boot if empty); operator-supplied values must be at least 32 chars |\n\n## platform\nChat platform integrations\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `platform.googlechat.audience` | string | `\"\"` | global | no | yes |  |\n| `platform.googlechat.client_email` | string | `\"\"` | global | no | yes |  |\n| `platform.googlechat.private_key` | string | `\"\"` | global | yes | yes |  |\n| `platform.googlechat.project_id` | string | `\"\"` | global | no | yes |  |\n| `platform.googlechat.sync_turn_timeout_ms` | number | `25000` | global | no | no | Bounded wait for the inline synchronous Google Chat turn before falling back to detached async delivery (must stay under Google's ~30s sync window) |\n| `platform.slack.client_id` | string | `\"\"` | global | no | yes |  |\n| `platform.slack.client_secret` | string | `\"\"` | global | yes | yes |  |\n| `platform.slack.signing_secret` | string | `\"\"` | global | yes | yes |  |\n| `platform.teams.app_id` | string | `\"\"` | global | no | yes |  |\n| `platform.teams.app_password` | string | `\"\"` | global | yes | yes |  |\n\n## storage\nObject storage\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `storage.hosted.max_file_bytes` | string | `\"0\"` | global | no | no | Operator-owned maximum declared bytes of each new hosted file; zero blocks file admission. |\n| `storage.hosted.retained_rows_per_resource` | number | `1000` | global | no | no | Operator-owned retained row ceiling, initially 1,000 for the Free offering, for each hosted resource table, including histories and soft-deleted rows; zero blocks resource creation. |\n| `storage.hosted.tenant_bytes` | string | `\"0\"` | global | no | no | Operator-owned shared logical byte quota for files, object reservations and all retained user content, including copies and revisions. Not a physical bucket or PostgreSQL disk quota. |\n| `storage.object_store.access_key_id` | string | `\"\"` | global | yes | no |  |\n| `storage.object_store.bucket` | string | `\"\"` | global | no | no |  |\n| `storage.object_store.endpoint` | string | `\"\"` | global | no | no |  |\n| `storage.object_store.force_path_style` | boolean | `true` | global | no | no |  |\n| `storage.object_store.region` | string | `\"us-east-1\"` | global | no | no |  |\n| `storage.object_store.secret_access_key` | string | `\"\"` | global | yes | no |  |\n| `storage.object_store.session_token` | string | `\"\"` | global | yes | no |  |\n\n## observability\nObservability\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `observability.analytics.api_key` | string | `\"\"` | global | yes | no | API key for the analytics endpoint. |\n| `observability.analytics.enabled` | boolean | `false` | global | no | no | Enable product-analytics emission. Off by default — no external calls are made unless this is true and an endpoint is configured. |\n| `observability.analytics.endpoint` | string | `\"\"` | global | no | no | Self-hostable analytics ingest endpoint. Empty disables emission even when enabled=true. |\n| `observability.analytics.project` | string | `\"\"` | global | no | no | Project or workspace identifier on the analytics platform. |\n| `observability.deployment_environment` | string | `\"production\"` | global | no | no | Deployment identity used for the OpenTelemetry deployment.environment.name resource attribute. |\n| `observability.field_truncation_chars` | number | `2048` | global | no | no | Per-field cap (in characters / UTF-16 code units, not bytes) applied to structured log fields after redaction. |\n| `observability.langfuse.host` | string | `\"\"` | global | no | no |  |\n| `observability.langfuse.public_key` | string | `\"\"` | global | no | no |  |\n| `observability.langfuse.secret_key` | string | `\"\"` | global | yes | no |  |\n| `observability.otlp.endpoint` | string | `\"\"` | global | no | no |  |\n| `observability.otlp.service_name` | string | `\"subkit\"` | global | no | no |  |\n| `observability.predictive.connector_unhealthy_pct` | number | `80` | global | no | no | Percent of recent connector calls returning a non-ok health verdict above which connector drift is flagged. |\n| `observability.predictive.dlq_critical_depth` | number | `5` | global | no | no | Standing dead-letter-queue depth at or above which DLQ accumulation is flagged critical (a worker-failure backlog, not a per-window delta). |\n| `observability.predictive.llm_fallback_pct` | number | `80` | global | no | no | Percent of LLM calls falling back to the secondary provider above which primary-provider degradation is flagged. |\n| `observability.predictive.memory_cap_fraction` | number | `0.9` | global | no | no | Fraction of the host memory cap the RSS high-water may reach before an OOM-risk warning. |\n| `observability.predictive.pool_saturation_pct` | number | `80` | global | no | no | Percent of the Postgres pool in use (or any waiting clients) above which saturation is flagged. |\n| `observability.predictive.transient_retry_rate` | number | `1` | global | no | no | Transient-DB-retries-per-minute above which a flapping Postgres is flagged. |\n| `observability.usage.enabled` | boolean | `false` | global | no | no | Persist privacy-safe, tenant-scoped product usage events locally. Disabled by default; requires hmac_secret when enabled. |\n| `observability.usage.hmac_secret` | string | `\"\"` | global | yes | no | Product-local HMAC secret for actor and session pseudonyms. Set at least 32 characters before enabling usage telemetry. |\n| `observability.usage.retention_days` | number | `90` | global | no | no | Raw usage-event retention in days; aggregate reports may outlive raw rows. |\n\n## egress\nEgress filter\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `egress.mode` | enum(\"strict\" \\| \"permissive\") | `null` | global | no | no | Egress mode: strict blocks private/loopback hosts, permissive allows them. Null falls back to NODE_ENV default. |\n| `egress.provider_hosts_extra` | string[] | `[]` | global | no | no | Extra hostnames counted as LLM providers for token accounting and per-run budgets. Does NOT affect the egress filter — adding a host makes calls to it metered, not permitted. |\n\n## mcp\nMCP transport\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `mcp.api_key` | string | `\"\"` | global | yes | no |  |\n| `mcp.read_only` | boolean | `false` | global | no | no |  |\n\n## errors\nError ring buffer\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `errors.ring_size` | number | `100` | global | no | yes |  |\n\n## spec\nSpec fetcher\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `spec.allow_private_fetch` | boolean | `false` | global | no | no | Allow OpenAPI spec fetches from private/loopback hosts (test-only) |\n\n## queue\nQueue worker\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `queue.abort_poll_interval_ms` | number | `500` | global | no | no | Hot-reloadable interval for workers to observe durable cross-replica execution cancellation requests. |\n| `queue.concurrency` | number | `1` | global | no | yes | Executions this replica runs at once. Raising it trades isolation for throughput. Restart required. |\n| `queue.crash_recovery_sweep_interval_ms` | number | `60000` | global | no | no | Hot-reloadable interval for reconciling executions orphaned by a worker or engine restart. |\n| `queue.crash_recovery_threshold_ms` | number | `0` | global | no | no | Hard age threshold for crash recovery. 0 uses each workflow timeout multiplied by its grace factor. |\n| `queue.hosted.chat_concurrency` | number | `0` | global | no | no | Operator ceiling for simultaneous hosted chat turns per tenant, including direct calls; zero denies work. |\n| `queue.hosted.execution_concurrency` | number | `0` | global | no | no | Operator ceiling for simultaneous hosted root executions per tenant; zero denies work. |\n| `queue.hosted.pending_jobs` | number | `0` | global | no | no | Operator ceiling for queued hosted execution and conversation jobs per tenant; zero denies queue admission. |\n\n## tokens\nToken budget\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `tokens.currency` | string | `\"USD\"` | tenant | no | no | ISO 4217 code for tokens.prices. The built-in catalog is in USD and applies only while this is USD; otherwise only tokens.prices entries price anything. |\n| `tokens.monthly_budget` | number | `0` | tenant | no | no | Hard cap on tokens consumed per calendar month. 0 = unlimited. |\n| `tokens.prices` | json | `[]` | tenant | no | no | Per-model price overrides on top of the built-in catalog, per 1M tokens. An entry replaces its model's catalog price. A model with neither is reported as unpriced, not as zero. |\n\n## operations\nStartup operations\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `operations.seed_skills_at_boot` | boolean | `true` | global | no | yes | Upsert embedded skill seeds for all tenants during startup |\n| `operations.update_check_enabled` | boolean | `true` | global | no | yes | Check for a newer engine release during startup |\n\n## sandbox\nQuickJS JS sandbox limits\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `sandbox.ipc_max_bytes` | number | `33554432` | global | no | no | Maximum sandbox worker request or response size in bytes. Default 32 MB. |\n| `sandbox.max_transform_wall_ms` | number | `300000` | global | no | no | Operator ceiling for a transform step's wall-clock, in ms. A step timeout_ms above it runs with the ceiling and sandbox_limit_clamped_total counts the cut. Default 5 min. |\n| `sandbox.memory_bytes` | number | `134217728` | global | no | no | Hard WASM heap cap for a JS sandbox run, in bytes. Default 128 MB. |\n| `sandbox.prewarm` | boolean | `false` | global | no | no | Start one default sandbox worker after boot, once the knowledge seed and its embeddings are done, so the first transform or JSONata step does not pay the worker cold start. Default off. |\n| `sandbox.queue_limit` | number | `32` | global | no | no | Maximum queued sandbox jobs across one worker lane. Default 32. |\n| `sandbox.stack_bytes` | number | `2097152` | global | no | no | Max stack size for a JS sandbox run, in bytes. Default 2 MB. |\n| `sandbox.tenant_queue_limit` | number | `8` | global | no | no | Maximum queued sandbox jobs for one tenant in one worker lane. Default 8. |\n| `sandbox.tick_budget` | number | `10000000` | global | no | no | Interrupt-tick budget (coarse runaway backstop, not an opcode count). |\n| `sandbox.transform_wall_ms` | number | `60000` | global | no | no | Wall-clock cap for transform steps, in ms (overridable per step via timeout_ms). Long synchronous transforms block the worker — chunk via for_each instead of raising. Default 60 s. |\n| `sandbox.wall_ms` | number | `30000` | global | no | no | Default wall-clock cap for a JS sandbox run, in ms. Default 30 s. |\n| `sandbox.worker_rss_bytes` | number | `536870912` | global | no | no | RSS threshold that recycles a sandbox worker after a job, in bytes. Default 512 MB. |\n\n## repl\nsk REPL session preferences\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `repl.permissionMode` | enum(\"ask\" \\| \"auto\" \\| \"plan\" \\| \"yolo\") | `\"auto\"` | tenant | no | no | Default REPL permission mode for the principal: ask, auto, plan, or yolo. |\n| `repl.portalTokenTtlMin` | number | `15` | tenant | no | no | TTL in minutes for portal tokens minted by the /session slash (1..1440). |\n\n## ui\nREPL chrome preferences\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `ui.personality` | enum(\"concise\" \\| \"balanced\" \\| \"verbose\") | `\"balanced\"` | tenant | no | no | Assistant response style: concise \\| balanced \\| verbose. |\n| `ui.statusline.format` | enum(\"minimal\" \\| \"compact\" \\| \"detailed\") | `\"compact\"` | tenant | no | no | Status-line layout: minimal \\| compact \\| detailed. |\n| `ui.theme` | enum(\"auto\" \\| \"light\" \\| \"dark\" \\| \"high-contrast\") | `\"auto\"` | tenant | no | no | REPL color theme: auto \\| light \\| dark \\| high-contrast. |\n| `ui.title.format` | enum(\"session-id\" \\| \"tenant-session\" \\| \"model-tenant-session\") | `\"session-id\"` | tenant | no | no | Window-title format used by the sk REPL. |\n\n## notifications\nsk REPL notification preferences\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `notifications.inbox.retention_days` | number | `30` | global | no | no | Days a notification inbox task survives before the retention sweep deletes it. |\n| `notifications.push.enabled` | boolean | `false` | tenant | no | no | OS push notifications for long-running execution completion. |\n| `notifications.push.quietHoursEnd` | string | `\"\"` | tenant | no | no | Quiet-hours window end (HH:MM, local TZ). Empty disables the window. |\n| `notifications.push.quietHoursStart` | string | `\"\"` | tenant | no | no | Quiet-hours window start (HH:MM, local TZ). Empty disables the window. |\n| `notifications.push.thresholdSec` | number | `30` | tenant | no | no | Minimum elapsed turn seconds before a notification fires. |\n\n## connectors\nPer-connector tunables. Each sub-section is owned by one connector template.\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `connectors.http.max_response_bytes` | number | `104857600` | tenant | no | no | Max bytes read from a single HTTP/GraphQL connector response before it is rejected as response_too_large. OOM guard; generous default (100 MB). |\n| `connectors.mcp.per_server_manifest_byte_cap` | number | `30000` | tenant | no | no | Byte cap on one external MCP connector's serialized tool manifest; the heaviest tools are dropped first when exceeded |\n| `connectors.mcp.remote_tool_call_timeout_ms` | number | `30000` | tenant | no | no | Bounded timeout (ms) for one remote external MCP tools/call invocation |\n| `connectors.mcp.tools_list_max_pages` | number | `5` | tenant | no | no | Max tools/list pages followed per external MCP handshake; a server paginating past this keeps only the pages read |\n| `connectors.web_scraper.authoring.extract_too_large_yellow_pct` | number | `30` | tenant | no | no | Past-run extract_too_large ratio (over last 20 runs) above which the gate Yellows. |\n| `connectors.web_scraper.authoring.red_sitemap_threshold` | number | `100000` | tenant | no | no | Sitemap entry count above which analyze_scrape_target refuses (Red). |\n| `connectors.web_scraper.authoring.yellow_sitemap_threshold` | number | `10000` | tenant | no | no | Sitemap entry count above which analyze_scrape_target returns Yellow. |\n| `connectors.web_scraper.optimization.min_runs_before_proposing` | number | `3` | tenant | no | no | Minimum recent runs before any candidate is emitted. |\n| `connectors.web_scraper.optimization.sample_size` | number | `10` | tenant | no | no | Number of recent runs the analyzer reads per recipe. |\n| `connectors.web_scraper.optimization.scan_cron` | string | `\"0 3 * * *\"` | global | no | no | Crontab for the per-tenant optimization scan (default daily 03:00). |\n| `connectors.web_scraper.optimization.trivial_markdown_bytes` | number | `512` | tenant | no | no | Pages whose MarkdownOutput.bytes is below this count as trivial. |\n| `connectors.web_scraper.robots_cache.max_entries` | number | `2000` | global | no | no | LRU ceiling shared across tenants (keyed by tenant_id + origin). |\n| `connectors.web_scraper.robots_cache.ttl_ms` | number | `3600000` | global | no | no | TTL for the per-tenant robots.txt LRU. |\n| `connectors.web_scraper.runtime.default_wait_ms` | number | `0` | tenant | no | no | Floor for between-page wait inside the crawl loop. Raised if robots.txt declares a higher Crawl-delay. |\n| `connectors.web_scraper.runtime.max_chars_markdown` | number | `100000` | tenant | no | no | Per-page markdown output cap (extract_too_large). |\n| `connectors.web_scraper.runtime.max_chars_readability` | number | `100000` | tenant | no | no | Per-page input cap into Readability (extract_too_large). |\n| `connectors.web_scraper.runtime.max_pages` | number | `1000` | tenant | no | no | Per-run crawl cap. Hard ceiling 10 000 (crawl_max_pages_exceeded). |\n| `connectors.web_scraper.runtime.respect_robots` | boolean | `true` | tenant | no | no | Skip URLs that robots.txt disallows for the configured User-Agent. |\n| `connectors.web_scraper.runtime.user_agent` | string | `\"\"` | tenant | no | no | User-Agent header on every fetch; passed to robots-parser matching. Empty means sk-web-scraper/<version> (+<server.public_base_url>/bot), or the project URL when no public base URL is set. |\n\n## products\nProduct settings keyed by product_id for product principals (oidc_bearer providers)\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `products` | json | `—` | global | no | no | Product settings keyed by product_id for product principals (oidc_bearer providers) |\n\n## Authentication providers\n\n`auth.providers` is one atomic, validated runtime setting available through Cockpit, HTTP, MCP, `sk settings`, and the canonical config file. Records use `protocol: api_key` or `oidc`; one API-key adapter and multiple named direct OIDC adapters may coexist. Provider ids must be unique, and every OIDC callback is `/v1/identity/login/callback` on `server.public_base_url`. A successful write is active for subsequent browser-login requests without an engine restart.\n\nOIDC records are public clients using Authorization Code with PKCE. Runtime configuration intentionally has no `client_secret` field and rejects one if supplied; use an issuer that supports public clients with `token_endpoint_auth_method=none`. The environment is not an auth-provider source.\n\nConfigured labels are diagnostic metadata only. The common `mcp-auth` surface derives its two user actions from protocol and always presents `Continue with SSO` before `Continue with API key`. Discovery exposes the canonical labels `SSO` and `API key`; no provider-specific route or parallel configuration tree is accepted."
        },
        "de": {
          "title": "Einstellungen",
          "summary": "Schlag jede Einstellung der Engine mit Beschreibung und Standardwert nach.",
          "headings": [
            {
              "depth": 1,
              "text": "SubKit runtime settings",
              "anchor": "subkit-runtime-settings"
            },
            {
              "depth": 2,
              "text": "log",
              "anchor": "log"
            },
            {
              "depth": 2,
              "text": "server",
              "anchor": "server"
            },
            {
              "depth": 2,
              "text": "database",
              "anchor": "database"
            },
            {
              "depth": 2,
              "text": "llm",
              "anchor": "llm"
            },
            {
              "depth": 2,
              "text": "auth",
              "anchor": "auth"
            },
            {
              "depth": 2,
              "text": "platform",
              "anchor": "platform"
            },
            {
              "depth": 2,
              "text": "storage",
              "anchor": "storage"
            },
            {
              "depth": 2,
              "text": "observability",
              "anchor": "observability"
            },
            {
              "depth": 2,
              "text": "egress",
              "anchor": "egress"
            },
            {
              "depth": 2,
              "text": "mcp",
              "anchor": "mcp"
            },
            {
              "depth": 2,
              "text": "errors",
              "anchor": "errors"
            },
            {
              "depth": 2,
              "text": "spec",
              "anchor": "spec"
            },
            {
              "depth": 2,
              "text": "queue",
              "anchor": "queue"
            },
            {
              "depth": 2,
              "text": "tokens",
              "anchor": "tokens"
            },
            {
              "depth": 2,
              "text": "operations",
              "anchor": "operations"
            },
            {
              "depth": 2,
              "text": "sandbox",
              "anchor": "sandbox"
            },
            {
              "depth": 2,
              "text": "repl",
              "anchor": "repl"
            },
            {
              "depth": 2,
              "text": "ui",
              "anchor": "ui"
            },
            {
              "depth": 2,
              "text": "notifications",
              "anchor": "notifications"
            },
            {
              "depth": 2,
              "text": "connectors",
              "anchor": "connectors"
            },
            {
              "depth": 2,
              "text": "products",
              "anchor": "products"
            },
            {
              "depth": 2,
              "text": "Authentication providers",
              "anchor": "authentication-providers"
            }
          ],
          "images": [],
          "sha256": "10e4f0682cbe69e7605cc02205fc587e1d986681b6c90b6d3f1484c42695fd10",
          "body": "Hier steht jeder Wert der Laufzeitkonfiguration mit Beschreibung und Standardwert. Du änderst ihn im Cockpit, über die HTTP- oder MCP-Schnittstelle oder mit `sk settings`. Eigene Werte für einen Arbeitsbereich gelten nur bei Einstellungen, die dafür markiert sind (`scope=tenant`). Umgebungsvariablen setzen keine dieser Einstellungen.\n\nDie Referenz unten wird aus der Konfiguration erzeugt und ist deshalb auf Englisch.\n\n# SubKit runtime settings\n\nLook up every runtime setting with its description and default value.\nYou change a value in the Cockpit, through the HTTP or MCP settings APIs, or with\n`sk settings configure` and `sk settings set`. Per-tenant overrides go into the\nfile's `tenants` section and only apply to settings tagged `scope=tenant`.\n\nA value resolves in this order: tenant overlay, then global value, then schema\ndefault. Environment variables never set a runtime setting.\n\n## log\nLogging\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `log.format` | enum(\"dev\" \\| \"pretty\" \\| \"prod\" \\| \"ndjson\" \\| \"json\") | `\"ndjson\"` | global | no | no | Log output format |\n| `log.level` | enum(\"trace\" \\| \"debug\" \\| \"info\" \\| \"warn\" \\| \"error\" \\| \"fatal\") | `\"info\"` | global | no | no | Log verbosity |\n\n## server\nHTTP server\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `server.hosted_rate_limit.global_per_minute` | number | `0` | global | no | no | Operator request ceiling across hosted ingress per minute; zero denies hosted ingress |\n| `server.hosted_rate_limit.peer_per_minute` | number | `0` | global | no | no | Operator request ceiling per verified connection peer and minute; zero denies hosted ingress |\n| `server.hosted_rate_limit.principal_per_minute` | number | `0` | global | no | no | Operator request ceiling per authenticated principal and tenant per minute; zero denies hosted requests |\n| `server.hosted_rate_limit.tenant_per_minute` | number | `0` | global | no | no | Operator request ceiling per hosted tenant and minute; zero denies hosted requests |\n| `server.hosted_rate_limit.tenant_per_month` | number | `0` | global | no | no | Operator request allowance per hosted tenant and UTC calendar month; zero denies hosted requests |\n| `server.port` | number | `3000` | global | no | yes | HTTP port to bind (1..65535) |\n| `server.public_base_url` | string | `\"\"` | global | no | no | External-facing URL the engine resolves at. Used by /install, chat link replies, and OAuth2 redirect-URI synthesis. Required for any OAuth2 connector. |\n| `server.restart_supervised` | boolean | `false` | global | no | no | A supervisor (systemd with Restart=on-failure, Docker with a restart policy) starts the engine again after it ends. Enables POST /v1/system/restart (exit code 75). |\n| `server.root_redirect_to_cockpit` | boolean | `false` | global | no | no | Redirect a browser's GET / (Accept: text/html) to /cockpit with a non-cacheable temporary redirect. Other clients keep the Markdown entry point. Disabled by default. |\n| `server.trusted_proxy_hops` | number | `0` | global | no | no | Trusted reverse-proxy hops counted from the right of X-Forwarded-For; zero ignores forwarding headers. |\n| `server.trusted_proxy_ips` | array | `[]` | global | no | no | Exact trusted reverse-proxy socket peer IPs. Every configured forwarding hop must match; X-Real-IP is never trusted. |\n\n## database\nDatabase connection\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `database.connect_timeout_ms` | number | `10000` | global | no | yes | Deadline for acquiring or establishing a PostgreSQL connection. |\n| `database.idle_timeout_ms` | number | `30000` | global | no | yes | Time before an unused pooled connection is closed. |\n| `database.keepalive_delay_ms` | number | `10000` | global | no | yes | Initial TCP keepalive delay for PostgreSQL connections. |\n| `database.pool_max` | number | `10` | global | no | yes | Maximum application connections per pool and replica. |\n| `database.query_timeout_ms` | number | `150000` | global | no | yes | Client-side PostgreSQL query deadline in milliseconds. |\n| `database.statement_timeout_ms` | number | `120000` | global | no | yes | Server-side PostgreSQL statement deadline, initialized on each session. |\n| `database.url` | string | `—` | global | yes | yes | Bootstrap-only Postgres connection string. Rotate DATABASE_URL and restart replicas; runtime revisions cannot change this binding. |\n\n## llm\nLLM configuration\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `llm.api_key` | string | `\"\"` | tenant | yes | no | Primary LLM API key |\n| `llm.context_1m` | boolean | `false` | tenant | no | no | Enable 1M context window where supported |\n| `llm.critic.enabled` | boolean | `false` | tenant | no | no | Run the second-stage LLM critic on workflow drafts after every static gate passes |\n| `llm.critic.max_consecutive_rejections` | number | `3` | tenant | no | no | After this many consecutive critic_rejected results in a conversation, skip the critic to avoid an infinite re-author loop |\n| `llm.critic.min_steps` | number | `3` | tenant | no | no | Minimum step count for the critic to run on a draft (drift in recent drafts also triggers a run) |\n| `llm.fallback_model` | string | `\"\"` | tenant | no | no | Fallback model identifier |\n| `llm.fallback_provider` | enum(\"mock\" \\| \"anthropic\" \\| \"openai\" \\| \"gemini\" \\| \"azure\" \\| \"bedrock\" \\| \"vertex\" \\| \"ai_gateway\") | `null` | tenant | no | no | Fallback provider on primary failure |\n| `llm.hosted.enabled` | boolean | `false` | global | no | no | Hosted paid-model service mode; requires tenant context independently of signup policy. |\n| `llm.hosted.global_monthly_microunits` | string | `\"0\"` | global | no | no | Operator-owned global monthly hosted budget in USD microunits; zero blocks paid calls. |\n| `llm.hosted.models` | json | `[]` | global | no | no | Exact provider:model allowlist with verified provider-enforced context maxima, including extended context, and maximum USD rates for every context tier. No paid native tools or multimodal inputs. |\n| `llm.hosted.tenant_monthly_microunits` | string | `\"0\"` | global | no | no | Operator-owned monthly hosted budget per tenant in USD microunits; zero blocks paid calls. |\n| `llm.model` | string | `\"\"` | tenant | no | no | Primary model identifier |\n| `llm.output_guard` | enum(\"soft\" \\| \"hard\" \\| \"off\") | `\"soft\"` | global | no | no | LLM output safety mode (soft: rewrite + log, hard: throw, off: bypass — never use in production) |\n| `llm.provider` | enum(\"mock\" \\| \"anthropic\" \\| \"openai\" \\| \"gemini\" \\| \"azure\" \\| \"bedrock\" \\| \"vertex\" \\| \"ai_gateway\") | `\"mock\"` | tenant | no | no | Primary LLM provider |\n| `llm.providers.ai_gateway.api_key` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.ai_gateway.model` | string | `\"\"` | global | no | no |  |\n| `llm.providers.anthropic.api_key` | string | `\"\"` | tenant | yes | no | API key for this provider |\n| `llm.providers.anthropic.base_url` | string | `\"\"` | global | no | no | Optional base URL override |\n| `llm.providers.anthropic.model` | string | `\"\"` | tenant | no | no | Default model identifier |\n| `llm.providers.azure.api_key` | string | `\"\"` | tenant | yes | no |  |\n| `llm.providers.azure.api_version` | string | `\"\"` | global | no | no |  |\n| `llm.providers.azure.base_url` | string | `\"\"` | global | no | no |  |\n| `llm.providers.azure.model` | string | `\"\"` | tenant | no | no |  |\n| `llm.providers.azure.resource_name` | string | `\"\"` | global | no | no |  |\n| `llm.providers.azure.use_deployment_based_urls` | boolean | `false` | global | no | no |  |\n| `llm.providers.bedrock.access_key_id` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.bedrock.base_url` | string | `\"\"` | global | no | no |  |\n| `llm.providers.bedrock.model` | string | `\"\"` | tenant | no | no |  |\n| `llm.providers.bedrock.region` | string | `\"\"` | global | no | no |  |\n| `llm.providers.bedrock.secret_access_key` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.bedrock.session_token` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.gemini.api_key` | string | `\"\"` | tenant | yes | no | API key for this provider |\n| `llm.providers.gemini.base_url` | string | `\"\"` | global | no | no | Optional base URL override |\n| `llm.providers.gemini.model` | string | `\"\"` | tenant | no | no | Default model identifier |\n| `llm.providers.openai.api_key` | string | `\"\"` | tenant | yes | no | API key for this provider |\n| `llm.providers.openai.base_url` | string | `\"\"` | global | no | no | Optional base URL override |\n| `llm.providers.openai.model` | string | `\"\"` | tenant | no | no | Default model identifier |\n| `llm.providers.vertex.api_key` | string | `\"\"` | tenant | yes | no |  |\n| `llm.providers.vertex.client_email` | string | `\"\"` | global | no | no |  |\n| `llm.providers.vertex.google_application_credentials` | string | `\"\"` | global | no | no |  |\n| `llm.providers.vertex.location` | string | `\"\"` | global | no | no |  |\n| `llm.providers.vertex.model` | string | `\"\"` | tenant | no | no |  |\n| `llm.providers.vertex.private_key` | string | `\"\"` | global | yes | no |  |\n| `llm.providers.vertex.project` | string | `\"\"` | global | no | no |  |\n| `llm.suggestion_model` | string | `\"\"` | tenant | no | no | Small model used to generate post-turn suggestions; empty uses the primary provider's default |\n| `llm.summarize_model` | string | `\"\"` | tenant | no | no | Model used for summarization passes |\n| `llm.summarize_provider` | enum(\"mock\" \\| \"anthropic\" \\| \"openai\" \\| \"gemini\" \\| \"azure\" \\| \"bedrock\" \\| \"vertex\" \\| \"ai_gateway\") | `null` | tenant | no | no | Provider used for summarization passes |\n| `llm.web_search` | boolean | `true` | tenant | no | no | Allow the assistant to use Anthropic-native server-side web search (billed per search; Anthropic models only). Toggle off per tenant via /settings. |\n\n## auth\nAuthentication\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `auth.enable_signup` | boolean | `false` | global | no | no | Compatibility fallback for self-hosted OIDC providers without signup_policy: allow first-time SSO member accounts. Explicit provider policies override it; hosted signup never uses it. |\n| `auth.hosted.admission.mcp_clients_per_minute` | number | `0` | global | no | no | Operator global hosted MCP dynamic-client registration ceiling per minute. |\n| `auth.hosted.admission.mcp_clients_per_peer_per_minute` | number | `0` | global | no | no | Operator hosted MCP dynamic-client registration ceiling per verified peer and minute. |\n| `auth.hosted.admission.retained_mcp_clients` | number | `0` | global | no | no | Operator ceiling for retained MCP client registrations, including retired and disabled clients; zero denies new clients. |\n| `auth.hosted.admission.retained_tenants` | number | `0` | global | no | no | Operator ceiling for retained self-service tenant records, including erased ownership tombstones; zero denies new tenants. |\n| `auth.hosted.admission.tenant_creations_per_minute` | number | `0` | global | no | no | Operator global ceiling for newly created self-service tenants per minute; idempotent callbacks do not consume it. |\n| `auth.hosted.enabled` | boolean | `false` | global | no | yes | Enable identity-first hosted browser authentication for explicitly opted-in providers. |\n| `auth.hosted.registration_enabled` | boolean | `false` | global | no | no | Allow new hosted identities to provision their own workspace. Existing members and reviewed invitation handoffs remain available while registration is closed. |\n| `auth.mcp_oauth.access_token_ttl_seconds` | number | `3600` | global | no | no | Lifetime in seconds for MCP OAuth access tokens. |\n| `auth.mcp_oauth.authorization_code_ttl_seconds` | number | `60` | global | no | no | Lifetime in seconds for MCP OAuth authorization codes. |\n| `auth.mcp_oauth.dynamic_registration_enabled` | boolean | `true` | global | no | no | Allow RFC 7591 dynamic client registration at POST /v1/oauth/register. |\n| `auth.mcp_oauth.enabled` | boolean | `true` | global | no | yes | Enable the MCP OAuth 2.1 authorization server (ChatGPT / Claude.ai / Cursor). |\n| `auth.mcp_oauth.refresh_token_ttl_seconds` | number | `2592000` | global | no | no | Lifetime in seconds for MCP OAuth refresh tokens (30 days). |\n| `auth.mcp_oauth.scopes_supported` | string[] | `[\"mcp:read\",\"mcp:authoring\",\"mcp:admin\",\"metrics:read\"]` | global | no | no | OAuth scopes advertised in the authorization server metadata. Add, reorder and remove freely, except metrics:read: GET /metrics enforces it, so it is restored whenever a written value omits it. |\n| `auth.providers` | json | `[{\"protocol\":\"api_key\",\"id\":\"api-key\",\"label\":\"SubKit API key\"}]` | global | no | no | Authentication adapters: api_key, oidc (public browser client with PKCE, no secret) and oidc_bearer (an issuer's access token as bearer for one product, verified against its JWKS). |\n| `auth.session.secret` | string | `\"\"` | global | yes | yes | Session signing secret (auto-generated to a 32-byte hex value on first boot if empty); operator-supplied values must be at least 32 chars |\n\n## platform\nChat platform integrations\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `platform.googlechat.audience` | string | `\"\"` | global | no | yes |  |\n| `platform.googlechat.client_email` | string | `\"\"` | global | no | yes |  |\n| `platform.googlechat.private_key` | string | `\"\"` | global | yes | yes |  |\n| `platform.googlechat.project_id` | string | `\"\"` | global | no | yes |  |\n| `platform.googlechat.sync_turn_timeout_ms` | number | `25000` | global | no | no | Bounded wait for the inline synchronous Google Chat turn before falling back to detached async delivery (must stay under Google's ~30s sync window) |\n| `platform.slack.client_id` | string | `\"\"` | global | no | yes |  |\n| `platform.slack.client_secret` | string | `\"\"` | global | yes | yes |  |\n| `platform.slack.signing_secret` | string | `\"\"` | global | yes | yes |  |\n| `platform.teams.app_id` | string | `\"\"` | global | no | yes |  |\n| `platform.teams.app_password` | string | `\"\"` | global | yes | yes |  |\n\n## storage\nObject storage\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `storage.hosted.max_file_bytes` | string | `\"0\"` | global | no | no | Operator-owned maximum declared bytes of each new hosted file; zero blocks file admission. |\n| `storage.hosted.retained_rows_per_resource` | number | `1000` | global | no | no | Operator-owned retained row ceiling, initially 1,000 for the Free offering, for each hosted resource table, including histories and soft-deleted rows; zero blocks resource creation. |\n| `storage.hosted.tenant_bytes` | string | `\"0\"` | global | no | no | Operator-owned shared logical byte quota for files, object reservations and all retained user content, including copies and revisions. Not a physical bucket or PostgreSQL disk quota. |\n| `storage.object_store.access_key_id` | string | `\"\"` | global | yes | no |  |\n| `storage.object_store.bucket` | string | `\"\"` | global | no | no |  |\n| `storage.object_store.endpoint` | string | `\"\"` | global | no | no |  |\n| `storage.object_store.force_path_style` | boolean | `true` | global | no | no |  |\n| `storage.object_store.region` | string | `\"us-east-1\"` | global | no | no |  |\n| `storage.object_store.secret_access_key` | string | `\"\"` | global | yes | no |  |\n| `storage.object_store.session_token` | string | `\"\"` | global | yes | no |  |\n\n## observability\nObservability\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `observability.analytics.api_key` | string | `\"\"` | global | yes | no | API key for the analytics endpoint. |\n| `observability.analytics.enabled` | boolean | `false` | global | no | no | Enable product-analytics emission. Off by default — no external calls are made unless this is true and an endpoint is configured. |\n| `observability.analytics.endpoint` | string | `\"\"` | global | no | no | Self-hostable analytics ingest endpoint. Empty disables emission even when enabled=true. |\n| `observability.analytics.project` | string | `\"\"` | global | no | no | Project or workspace identifier on the analytics platform. |\n| `observability.deployment_environment` | string | `\"production\"` | global | no | no | Deployment identity used for the OpenTelemetry deployment.environment.name resource attribute. |\n| `observability.field_truncation_chars` | number | `2048` | global | no | no | Per-field cap (in characters / UTF-16 code units, not bytes) applied to structured log fields after redaction. |\n| `observability.langfuse.host` | string | `\"\"` | global | no | no |  |\n| `observability.langfuse.public_key` | string | `\"\"` | global | no | no |  |\n| `observability.langfuse.secret_key` | string | `\"\"` | global | yes | no |  |\n| `observability.otlp.endpoint` | string | `\"\"` | global | no | no |  |\n| `observability.otlp.service_name` | string | `\"subkit\"` | global | no | no |  |\n| `observability.predictive.connector_unhealthy_pct` | number | `80` | global | no | no | Percent of recent connector calls returning a non-ok health verdict above which connector drift is flagged. |\n| `observability.predictive.dlq_critical_depth` | number | `5` | global | no | no | Standing dead-letter-queue depth at or above which DLQ accumulation is flagged critical (a worker-failure backlog, not a per-window delta). |\n| `observability.predictive.llm_fallback_pct` | number | `80` | global | no | no | Percent of LLM calls falling back to the secondary provider above which primary-provider degradation is flagged. |\n| `observability.predictive.memory_cap_fraction` | number | `0.9` | global | no | no | Fraction of the host memory cap the RSS high-water may reach before an OOM-risk warning. |\n| `observability.predictive.pool_saturation_pct` | number | `80` | global | no | no | Percent of the Postgres pool in use (or any waiting clients) above which saturation is flagged. |\n| `observability.predictive.transient_retry_rate` | number | `1` | global | no | no | Transient-DB-retries-per-minute above which a flapping Postgres is flagged. |\n| `observability.usage.enabled` | boolean | `false` | global | no | no | Persist privacy-safe, tenant-scoped product usage events locally. Disabled by default; requires hmac_secret when enabled. |\n| `observability.usage.hmac_secret` | string | `\"\"` | global | yes | no | Product-local HMAC secret for actor and session pseudonyms. Set at least 32 characters before enabling usage telemetry. |\n| `observability.usage.retention_days` | number | `90` | global | no | no | Raw usage-event retention in days; aggregate reports may outlive raw rows. |\n\n## egress\nEgress filter\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `egress.mode` | enum(\"strict\" \\| \"permissive\") | `null` | global | no | no | Egress mode: strict blocks private/loopback hosts, permissive allows them. Null falls back to NODE_ENV default. |\n| `egress.provider_hosts_extra` | string[] | `[]` | global | no | no | Extra hostnames counted as LLM providers for token accounting and per-run budgets. Does NOT affect the egress filter — adding a host makes calls to it metered, not permitted. |\n\n## mcp\nMCP transport\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `mcp.api_key` | string | `\"\"` | global | yes | no |  |\n| `mcp.read_only` | boolean | `false` | global | no | no |  |\n\n## errors\nError ring buffer\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `errors.ring_size` | number | `100` | global | no | yes |  |\n\n## spec\nSpec fetcher\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `spec.allow_private_fetch` | boolean | `false` | global | no | no | Allow OpenAPI spec fetches from private/loopback hosts (test-only) |\n\n## queue\nQueue worker\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `queue.abort_poll_interval_ms` | number | `500` | global | no | no | Hot-reloadable interval for workers to observe durable cross-replica execution cancellation requests. |\n| `queue.concurrency` | number | `1` | global | no | yes | Executions this replica runs at once. Raising it trades isolation for throughput. Restart required. |\n| `queue.crash_recovery_sweep_interval_ms` | number | `60000` | global | no | no | Hot-reloadable interval for reconciling executions orphaned by a worker or engine restart. |\n| `queue.crash_recovery_threshold_ms` | number | `0` | global | no | no | Hard age threshold for crash recovery. 0 uses each workflow timeout multiplied by its grace factor. |\n| `queue.hosted.chat_concurrency` | number | `0` | global | no | no | Operator ceiling for simultaneous hosted chat turns per tenant, including direct calls; zero denies work. |\n| `queue.hosted.execution_concurrency` | number | `0` | global | no | no | Operator ceiling for simultaneous hosted root executions per tenant; zero denies work. |\n| `queue.hosted.pending_jobs` | number | `0` | global | no | no | Operator ceiling for queued hosted execution and conversation jobs per tenant; zero denies queue admission. |\n\n## tokens\nToken budget\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `tokens.currency` | string | `\"USD\"` | tenant | no | no | ISO 4217 code for tokens.prices. The built-in catalog is in USD and applies only while this is USD; otherwise only tokens.prices entries price anything. |\n| `tokens.monthly_budget` | number | `0` | tenant | no | no | Hard cap on tokens consumed per calendar month. 0 = unlimited. |\n| `tokens.prices` | json | `[]` | tenant | no | no | Per-model price overrides on top of the built-in catalog, per 1M tokens. An entry replaces its model's catalog price. A model with neither is reported as unpriced, not as zero. |\n\n## operations\nStartup operations\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `operations.seed_skills_at_boot` | boolean | `true` | global | no | yes | Upsert embedded skill seeds for all tenants during startup |\n| `operations.update_check_enabled` | boolean | `true` | global | no | yes | Check for a newer engine release during startup |\n\n## sandbox\nQuickJS JS sandbox limits\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `sandbox.ipc_max_bytes` | number | `33554432` | global | no | no | Maximum sandbox worker request or response size in bytes. Default 32 MB. |\n| `sandbox.max_transform_wall_ms` | number | `300000` | global | no | no | Operator ceiling for a transform step's wall-clock, in ms. A step timeout_ms above it runs with the ceiling and sandbox_limit_clamped_total counts the cut. Default 5 min. |\n| `sandbox.memory_bytes` | number | `134217728` | global | no | no | Hard WASM heap cap for a JS sandbox run, in bytes. Default 128 MB. |\n| `sandbox.prewarm` | boolean | `false` | global | no | no | Start one default sandbox worker after boot, once the knowledge seed and its embeddings are done, so the first transform or JSONata step does not pay the worker cold start. Default off. |\n| `sandbox.queue_limit` | number | `32` | global | no | no | Maximum queued sandbox jobs across one worker lane. Default 32. |\n| `sandbox.stack_bytes` | number | `2097152` | global | no | no | Max stack size for a JS sandbox run, in bytes. Default 2 MB. |\n| `sandbox.tenant_queue_limit` | number | `8` | global | no | no | Maximum queued sandbox jobs for one tenant in one worker lane. Default 8. |\n| `sandbox.tick_budget` | number | `10000000` | global | no | no | Interrupt-tick budget (coarse runaway backstop, not an opcode count). |\n| `sandbox.transform_wall_ms` | number | `60000` | global | no | no | Wall-clock cap for transform steps, in ms (overridable per step via timeout_ms). Long synchronous transforms block the worker — chunk via for_each instead of raising. Default 60 s. |\n| `sandbox.wall_ms` | number | `30000` | global | no | no | Default wall-clock cap for a JS sandbox run, in ms. Default 30 s. |\n| `sandbox.worker_rss_bytes` | number | `536870912` | global | no | no | RSS threshold that recycles a sandbox worker after a job, in bytes. Default 512 MB. |\n\n## repl\nsk REPL session preferences\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `repl.permissionMode` | enum(\"ask\" \\| \"auto\" \\| \"plan\" \\| \"yolo\") | `\"auto\"` | tenant | no | no | Default REPL permission mode for the principal: ask, auto, plan, or yolo. |\n| `repl.portalTokenTtlMin` | number | `15` | tenant | no | no | TTL in minutes for portal tokens minted by the /session slash (1..1440). |\n\n## ui\nREPL chrome preferences\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `ui.personality` | enum(\"concise\" \\| \"balanced\" \\| \"verbose\") | `\"balanced\"` | tenant | no | no | Assistant response style: concise \\| balanced \\| verbose. |\n| `ui.statusline.format` | enum(\"minimal\" \\| \"compact\" \\| \"detailed\") | `\"compact\"` | tenant | no | no | Status-line layout: minimal \\| compact \\| detailed. |\n| `ui.theme` | enum(\"auto\" \\| \"light\" \\| \"dark\" \\| \"high-contrast\") | `\"auto\"` | tenant | no | no | REPL color theme: auto \\| light \\| dark \\| high-contrast. |\n| `ui.title.format` | enum(\"session-id\" \\| \"tenant-session\" \\| \"model-tenant-session\") | `\"session-id\"` | tenant | no | no | Window-title format used by the sk REPL. |\n\n## notifications\nsk REPL notification preferences\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `notifications.inbox.retention_days` | number | `30` | global | no | no | Days a notification inbox task survives before the retention sweep deletes it. |\n| `notifications.push.enabled` | boolean | `false` | tenant | no | no | OS push notifications for long-running execution completion. |\n| `notifications.push.quietHoursEnd` | string | `\"\"` | tenant | no | no | Quiet-hours window end (HH:MM, local TZ). Empty disables the window. |\n| `notifications.push.quietHoursStart` | string | `\"\"` | tenant | no | no | Quiet-hours window start (HH:MM, local TZ). Empty disables the window. |\n| `notifications.push.thresholdSec` | number | `30` | tenant | no | no | Minimum elapsed turn seconds before a notification fires. |\n\n## connectors\nPer-connector tunables. Each sub-section is owned by one connector template.\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `connectors.http.max_response_bytes` | number | `104857600` | tenant | no | no | Max bytes read from a single HTTP/GraphQL connector response before it is rejected as response_too_large. OOM guard; generous default (100 MB). |\n| `connectors.mcp.per_server_manifest_byte_cap` | number | `30000` | tenant | no | no | Byte cap on one external MCP connector's serialized tool manifest; the heaviest tools are dropped first when exceeded |\n| `connectors.mcp.remote_tool_call_timeout_ms` | number | `30000` | tenant | no | no | Bounded timeout (ms) for one remote external MCP tools/call invocation |\n| `connectors.mcp.tools_list_max_pages` | number | `5` | tenant | no | no | Max tools/list pages followed per external MCP handshake; a server paginating past this keeps only the pages read |\n| `connectors.web_scraper.authoring.extract_too_large_yellow_pct` | number | `30` | tenant | no | no | Past-run extract_too_large ratio (over last 20 runs) above which the gate Yellows. |\n| `connectors.web_scraper.authoring.red_sitemap_threshold` | number | `100000` | tenant | no | no | Sitemap entry count above which analyze_scrape_target refuses (Red). |\n| `connectors.web_scraper.authoring.yellow_sitemap_threshold` | number | `10000` | tenant | no | no | Sitemap entry count above which analyze_scrape_target returns Yellow. |\n| `connectors.web_scraper.optimization.min_runs_before_proposing` | number | `3` | tenant | no | no | Minimum recent runs before any candidate is emitted. |\n| `connectors.web_scraper.optimization.sample_size` | number | `10` | tenant | no | no | Number of recent runs the analyzer reads per recipe. |\n| `connectors.web_scraper.optimization.scan_cron` | string | `\"0 3 * * *\"` | global | no | no | Crontab for the per-tenant optimization scan (default daily 03:00). |\n| `connectors.web_scraper.optimization.trivial_markdown_bytes` | number | `512` | tenant | no | no | Pages whose MarkdownOutput.bytes is below this count as trivial. |\n| `connectors.web_scraper.robots_cache.max_entries` | number | `2000` | global | no | no | LRU ceiling shared across tenants (keyed by tenant_id + origin). |\n| `connectors.web_scraper.robots_cache.ttl_ms` | number | `3600000` | global | no | no | TTL for the per-tenant robots.txt LRU. |\n| `connectors.web_scraper.runtime.default_wait_ms` | number | `0` | tenant | no | no | Floor for between-page wait inside the crawl loop. Raised if robots.txt declares a higher Crawl-delay. |\n| `connectors.web_scraper.runtime.max_chars_markdown` | number | `100000` | tenant | no | no | Per-page markdown output cap (extract_too_large). |\n| `connectors.web_scraper.runtime.max_chars_readability` | number | `100000` | tenant | no | no | Per-page input cap into Readability (extract_too_large). |\n| `connectors.web_scraper.runtime.max_pages` | number | `1000` | tenant | no | no | Per-run crawl cap. Hard ceiling 10 000 (crawl_max_pages_exceeded). |\n| `connectors.web_scraper.runtime.respect_robots` | boolean | `true` | tenant | no | no | Skip URLs that robots.txt disallows for the configured User-Agent. |\n| `connectors.web_scraper.runtime.user_agent` | string | `\"\"` | tenant | no | no | User-Agent header on every fetch; passed to robots-parser matching. Empty means sk-web-scraper/<version> (+<server.public_base_url>/bot), or the project URL when no public base URL is set. |\n\n## products\nProduct settings keyed by product_id for product principals (oidc_bearer providers)\n\n| path | type | default | scope | sensitive | requiresRestart | description |\n| ---- | ---- | ------- | ----- | --------- | --------------- | ----------- |\n| `products` | json | `—` | global | no | no | Product settings keyed by product_id for product principals (oidc_bearer providers) |\n\n## Authentication providers\n\n`auth.providers` is one atomic, validated runtime setting available through Cockpit, HTTP, MCP, `sk settings`, and the canonical config file. Records use `protocol: api_key` or `oidc`; one API-key adapter and multiple named direct OIDC adapters may coexist. Provider ids must be unique, and every OIDC callback is `/v1/identity/login/callback` on `server.public_base_url`. A successful write is active for subsequent browser-login requests without an engine restart.\n\nOIDC records are public clients using Authorization Code with PKCE. Runtime configuration intentionally has no `client_secret` field and rejects one if supplied; use an issuer that supports public clients with `token_endpoint_auth_method=none`. The environment is not an auth-provider source.\n\nConfigured labels are diagnostic metadata only. The common `mcp-auth` surface derives its two user actions from protocol and always presents `Continue with SSO` before `Continue with API key`. Discovery exposes the canonical labels `SSO` and `API key`; no provider-specific route or parallel configuration tree is accepted."
        }
      }
    },
    {
      "slug": "connectors",
      "llms_path": "connectors.md",
      "audience": "public",
      "section": "reference",
      "order": 3,
      "generated": true,
      "locales": {
        "en": {
          "title": "Connector & recipe catalog",
          "summary": "Find the connector templates and recipes that ship with SubKit.",
          "headings": [
            {
              "depth": 1,
              "text": "Connector & recipe catalog",
              "anchor": "connector--recipe-catalog"
            },
            {
              "depth": 2,
              "text": "Connector templates",
              "anchor": "connector-templates"
            },
            {
              "depth": 3,
              "text": "CRM",
              "anchor": "crm"
            },
            {
              "depth": 3,
              "text": "Payments",
              "anchor": "payments"
            },
            {
              "depth": 3,
              "text": "E-commerce",
              "anchor": "e-commerce"
            },
            {
              "depth": 3,
              "text": "Marketing",
              "anchor": "marketing"
            },
            {
              "depth": 3,
              "text": "Communication",
              "anchor": "communication"
            },
            {
              "depth": 3,
              "text": "Project management",
              "anchor": "project-management"
            },
            {
              "depth": 3,
              "text": "Productivity & documents",
              "anchor": "productivity--documents"
            },
            {
              "depth": 3,
              "text": "File storage",
              "anchor": "file-storage"
            },
            {
              "depth": 3,
              "text": "Dev tools",
              "anchor": "dev-tools"
            },
            {
              "depth": 3,
              "text": "Databases",
              "anchor": "databases"
            },
            {
              "depth": 3,
              "text": "Analytics",
              "anchor": "analytics"
            },
            {
              "depth": 3,
              "text": "Web scraping",
              "anchor": "web-scraping"
            },
            {
              "depth": 3,
              "text": "Enterprise & support",
              "anchor": "enterprise--support"
            },
            {
              "depth": 3,
              "text": "AI",
              "anchor": "ai"
            },
            {
              "depth": 3,
              "text": "Cloud",
              "anchor": "cloud"
            },
            {
              "depth": 3,
              "text": "AWS operations",
              "anchor": "aws-operations"
            },
            {
              "depth": 2,
              "text": "Recipes",
              "anchor": "recipes"
            },
            {
              "depth": 3,
              "text": "Airtable (`airtable`)",
              "anchor": "airtable-airtable"
            },
            {
              "depth": 3,
              "text": "Anthropic (`anthropic`)",
              "anchor": "anthropic-anthropic"
            },
            {
              "depth": 3,
              "text": "AWS AppSync (Cognito User-Password) (`appsync-cognito`)",
              "anchor": "aws-appsync-cognito-user-password-appsync-cognito"
            },
            {
              "depth": 3,
              "text": "AWS AppSync (IAM SigV4) (`appsync-iam`)",
              "anchor": "aws-appsync-iam-sigv4-appsync-iam"
            },
            {
              "depth": 3,
              "text": "Asana (`asana`)",
              "anchor": "asana-asana"
            },
            {
              "depth": 3,
              "text": "AWS API Gateway (IAM SigV4) (`aws-apigw-iam`)",
              "anchor": "aws-api-gateway-iam-sigv4-aws-apigw-iam"
            },
            {
              "depth": 3,
              "text": "AWS CloudWatch Alarms (`aws-cloudwatch-alarms`)",
              "anchor": "aws-cloudwatch-alarms-aws-cloudwatch-alarms"
            },
            {
              "depth": 3,
              "text": "AWS CloudWatch Logs (`aws-cloudwatch-logs`)",
              "anchor": "aws-cloudwatch-logs-aws-cloudwatch-logs"
            },
            {
              "depth": 3,
              "text": "AWS CloudWatch Metrics (`aws-cloudwatch-metrics`)",
              "anchor": "aws-cloudwatch-metrics-aws-cloudwatch-metrics"
            },
            {
              "depth": 3,
              "text": "AWS Cognito User Pools (`aws-cognito-user-pools`)",
              "anchor": "aws-cognito-user-pools-aws-cognito-user-pools"
            },
            {
              "depth": 3,
              "text": "AWS DynamoDB (`aws-dynamodb`)",
              "anchor": "aws-dynamodb-aws-dynamodb"
            },
            {
              "depth": 3,
              "text": "AWS EventBridge (`aws-eventbridge`)",
              "anchor": "aws-eventbridge-aws-eventbridge"
            },
            {
              "depth": 3,
              "text": "AWS Lambda (`aws-lambda`)",
              "anchor": "aws-lambda-aws-lambda"
            },
            {
              "depth": 3,
              "text": "AWS S3 (`aws-s3`)",
              "anchor": "aws-s3-aws-s3"
            },
            {
              "depth": 3,
              "text": "AWS SES (`aws-ses`)",
              "anchor": "aws-ses-aws-ses"
            },
            {
              "depth": 3,
              "text": "AWS SQS (`aws-sqs`)",
              "anchor": "aws-sqs-aws-sqs"
            },
            {
              "depth": 3,
              "text": "AWS STS (`aws-sts`)",
              "anchor": "aws-sts-aws-sts"
            },
            {
              "depth": 3,
              "text": "Browserless (`browserless`)",
              "anchor": "browserless-browserless"
            },
            {
              "depth": 3,
              "text": "Cloudflare (`cloudflare`)",
              "anchor": "cloudflare-cloudflare"
            },
            {
              "depth": 3,
              "text": "Firebase (`firebase`)",
              "anchor": "firebase-firebase"
            },
            {
              "depth": 3,
              "text": "GitHub (REST) (`github`)",
              "anchor": "github-rest-github"
            },
            {
              "depth": 3,
              "text": "GitHub (GraphQL) (`github-graphql`)",
              "anchor": "github-graphql-github-graphql"
            },
            {
              "depth": 3,
              "text": "Google Analytics 4 (`google-analytics`)",
              "anchor": "google-analytics-4-google-analytics"
            },
            {
              "depth": 3,
              "text": "HubSpot (`hubspot`)",
              "anchor": "hubspot-hubspot"
            },
            {
              "depth": 3,
              "text": "Intercom (`intercom`)",
              "anchor": "intercom-intercom"
            },
            {
              "depth": 3,
              "text": "Jina Reader (`jina-reader`)",
              "anchor": "jina-reader-jina-reader"
            },
            {
              "depth": 3,
              "text": "Jira (`jira`)",
              "anchor": "jira-jira"
            },
            {
              "depth": 3,
              "text": "Linear (`linear`)",
              "anchor": "linear-linear"
            },
            {
              "depth": 3,
              "text": "LinkedIn (`linkedin`)",
              "anchor": "linkedin-linkedin"
            },
            {
              "depth": 3,
              "text": "Mailchimp (`mailchimp`)",
              "anchor": "mailchimp-mailchimp"
            },
            {
              "depth": 3,
              "text": "Monday.com (`monday`)",
              "anchor": "mondaycom-monday"
            },
            {
              "depth": 3,
              "text": "Notion (`notion`)",
              "anchor": "notion-notion"
            },
            {
              "depth": 3,
              "text": "OAuth2 Generic (`oauth2-generic`)",
              "anchor": "oauth2-generic-oauth2-generic"
            },
            {
              "depth": 3,
              "text": "OpenAI (`openai`)",
              "anchor": "openai-openai"
            },
            {
              "depth": 3,
              "text": "PostgreSQL (`postgres`)",
              "anchor": "postgresql-postgres"
            },
            {
              "depth": 3,
              "text": "SendGrid (`sendgrid`)",
              "anchor": "sendgrid-sendgrid"
            },
            {
              "depth": 3,
              "text": "Shopify (`shopify`)",
              "anchor": "shopify-shopify"
            },
            {
              "depth": 3,
              "text": "Slack (`slack`)",
              "anchor": "slack-slack"
            },
            {
              "depth": 3,
              "text": "Square (`square`)",
              "anchor": "square-square"
            },
            {
              "depth": 3,
              "text": "Stripe (`stripe`)",
              "anchor": "stripe-stripe"
            },
            {
              "depth": 3,
              "text": "Twilio (`twilio`)",
              "anchor": "twilio-twilio"
            },
            {
              "depth": 3,
              "text": "Vercel (`vercel`)",
              "anchor": "vercel-vercel"
            },
            {
              "depth": 3,
              "text": "Web Scraper (`web-scraper`)",
              "anchor": "web-scraper-web-scraper"
            },
            {
              "depth": 3,
              "text": "Xray Cloud (GraphQL) (`xray-cloud`)",
              "anchor": "xray-cloud-graphql-xray-cloud"
            }
          ],
          "images": [],
          "sha256": "c1d4fe2b8c0db805fc758120566649eee5b5d506b089358e976a94657ec416ae",
          "body": "# Connector & recipe catalog\n\nFind the connector templates and recipes that ship with SubKit. There are **61 connector templates** in **16 categories**, carrying **248 recipes**: complete, runnable workflows you clone instead of starting from a blank page.\n\nA **template** connects a system: base URL, sign-in flow, endpoint schema and a vendor-basics skill. A **recipe** is a complete workflow built on that template. Say what you want in a conversation, and SubKit clones the closest recipe as your first draft.\n\n## Connector templates\n\n### CRM\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **HubSpot** | `hubspot` | http | bearer | HubSpot CRM API |\n| **Salesforce** | `salesforce` | http | oauth2 | Salesforce REST API |\n\n### Payments\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Square** | `square` | http | bearer | Square payments and commerce API |\n| **Stripe** | `stripe` | http | bearer | Stripe payments API |\n\n### E-commerce\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Shopify** | `shopify` | http | header | Shopify Admin REST API |\n\n### Marketing\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Mailchimp** | `mailchimp` | http | bearer | Mailchimp email marketing API |\n\n### Communication\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Google Chat** | `google-chat` | http | oauth2 | Google Chat API |\n| **Google Gmail** | `google-gmail` | http | oauth2 | Google Gmail API |\n| **LinkedIn** | `linkedin` | http | oauth2 | LinkedIn API — member identity (OpenID Connect) and posting (UGC Posts). |\n| **SendGrid** | `sendgrid` | http | bearer | SendGrid email delivery API |\n| **Slack** | `slack` | http | bearer | Slack Web API |\n| **Twilio** | `twilio` | http | basic | Twilio SMS, Voice, and Messaging API |\n\n### Project management\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Asana** | `asana` | http | bearer | Asana project management API |\n| **Jira** | `jira` | http | oauth2 | Jira Cloud REST API. |\n| **Linear** | `linear` | graphql | bearer | Linear GraphQL API |\n| **Monday.com** | `monday` | graphql | bearer | Monday.com GraphQL API |\n| **Xray Cloud (GraphQL)** | `xray-cloud` | graphql | oauth2 | Xray Cloud test-management GraphQL API. |\n\n### Productivity & documents\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Airtable** | `airtable` | http | bearer | Airtable REST API |\n| **Confluence** | `confluence` | http | oauth2 | Confluence Cloud wiki API |\n| **Google Calendar** | `google-calendar` | http | oauth2 | Google Calendar API |\n| **Google Docs** | `google-docs` | http | oauth2 | Google Docs API |\n| **Google Sheets** | `google-sheets` | http | oauth2 | Google Sheets API |\n| **Google Workspace** | `google-workspace` | http | oauth2 | Google Workspace APIs (Gmail, Calendar, Drive) |\n| **HTTP API** | `http` | http | none | Any HTTP or REST API that has no dedicated template: set the base URL, pick how it authenticates, and every request step against it is governed like the rest. |\n| **Notion** | `notion` | http | bearer | Notion API |\n| **Web Scraper** | `web-scraper` | http | none | Fetch public web pages and convert to markdown / extract structured data. |\n\n### File storage\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Dropbox** | `dropbox` | http | oauth2 | Dropbox file storage API |\n| **Google Drive** | `google-drive` | http | oauth2 | Google Drive file storage API |\n\n### Dev tools\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **App Store Connect** | `app-store-connect` | http | signed_jwt | App Store Connect REST API for app metadata, TestFlight builds, beta groups, testers, and public links. |\n| **GitHub (REST)** | `github` | http | bearer | GitHub REST API (date-versioned: 2026-03-10 latest, 2022-11-28 default) — best for write operations (issue creation, PR merge, file commits) where REST is more expressive than GraphQL. |\n| **GitHub (GraphQL)** | `github-graphql` | graphql | bearer | GitHub GraphQL API v4 — read nested repository and ProjectV2 data without relying on REST OpenAPI discovery. |\n| **Vercel** | `vercel` | http | bearer | Vercel deployment and hosting API |\n\n### Databases\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Firebase** | `firebase` | http | oauth2 | Firebase Firestore REST API |\n| **PostgreSQL** | `postgres` | postgres | none | PostgreSQL relational database |\n| **Supabase** | `supabase` | http | header | Supabase PostgREST API |\n| **Supabase (GraphQL)** | `supabase-graphql` | graphql | header | Supabase GraphQL API (pg_graphql at /graphql/v1) — one roundtrip for nested reads instead of N+1 PostgREST calls. |\n\n### Analytics\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Google Analytics 4** | `google-analytics` | http | oauth2 | Google Analytics 4 Data API: users, sessions, page views, traffic sources and key events of a GA4 property. |\n| **Google Search Console** | `google-search-console` | http | oauth2 | Google Search Console API |\n\n### Web scraping\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Browserless** | `browserless` | http | query | Browserless headless Chrome API |\n| **Jina Reader** | `jina-reader` | http | bearer | Jina Reader URL-to-markdown and search API |\n\n### Enterprise & support\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Intercom** | `intercom` | http | bearer | Intercom customer messaging API |\n| **OAuth2 Generic** | `oauth2-generic` | http | header | Reusable OAuth2 endpoints (token exchange, refresh, introspect, revoke, client_credentials, device code) for arbitrary providers. |\n\n### AI\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Anthropic** | `anthropic` | http | header | Anthropic Claude API: call Claude from a workflow step through a connector, with the same boundary and per-run token budget as every other connector call. |\n| **OpenAI** | `openai` | http | bearer | OpenAI API for models, responses, embeddings, files, and structured outputs. |\n\n### Cloud\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **AWS DynamoDB** | `aws-dynamodb` | http | aws_sigv4 | AWS DynamoDB NoSQL database API |\n| **AWS Lambda** | `aws-lambda` | http | aws_sigv4 | AWS Lambda serverless functions API |\n| **AWS S3** | `aws-s3` | s3 | header | Amazon S3 object storage |\n| **AWS SES** | `aws-ses` | http | aws_sigv4 | AWS Simple Email Service API |\n| **AWS SQS** | `aws-sqs` | http | aws_sigv4 | AWS Simple Queue Service API |\n| **Cloudflare** | `cloudflare` | http | bearer | Cloudflare REST API for zones, DNS, Workers, R2, Zero Trust, and account services |\n| **DigitalOcean** | `digitalocean` | http | bearer | DigitalOcean cloud API |\n| **Google Cloud Storage** | `google-cloud-storage` | http | oauth2 | Google Cloud Storage JSON API |\n\n### AWS operations\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **AWS AppSync (Cognito User-Password)** | `appsync-cognito` | graphql | oauth2 | AWS AppSync GraphQL API authenticated via Cognito User-Pool USER_PASSWORD_AUTH. |\n| **AWS AppSync (IAM SigV4)** | `appsync-iam` | graphql | aws_sigv4 | AWS AppSync GraphQL API authenticated via IAM SigV4. |\n| **AWS API Gateway (IAM SigV4)** | `aws-apigw-iam` | http | aws_sigv4 | AWS API Gateway REST endpoint with IAM authorization. |\n| **AWS CloudWatch Alarms** | `aws-cloudwatch-alarms` | http | aws_sigv4 | Amazon CloudWatch Alarms API. |\n| **AWS CloudWatch Logs** | `aws-cloudwatch-logs` | http | aws_sigv4 | Amazon CloudWatch Logs API for log ingestion + Logs Insights query. |\n| **AWS CloudWatch Metrics** | `aws-cloudwatch-metrics` | http | aws_sigv4 | Amazon CloudWatch Metrics API for metric ingestion + statistic queries. |\n| **AWS Cognito User Pools** | `aws-cognito-user-pools` | http | aws_sigv4 | Amazon Cognito User Pools administrative API for users and groups. |\n| **AWS EventBridge** | `aws-eventbridge` | http | aws_sigv4 | Amazon EventBridge API for event publishing + rule management. |\n| **AWS STS** | `aws-sts` | http | aws_sigv4 | AWS Security Token Service — temporary-credential issuance for cross-account / cross-role access. |\n\n## Recipes\n\nGrouped by template. **Trigger** is how the workflow starts: `request` (on demand — chat, CLI, MCP, REST), `schedule` (cron), or `webhook` (an external system calls in). **Also uses** lists connectors beyond the template's own.\n\n### Airtable (`airtable`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-record` | POST a new row with fields. | request | — |\n| `delete-record` | DELETE a record by id. | request | — |\n| `get-record` | Fetch a single record from a table. | request | — |\n| `list-bases` | Enumerate accessible bases via the meta API. | request | — |\n| `list-records` | Page through records with offset-based pagination. | request | — |\n| `list-records-formula` | Run a server-side filter formula against a table. | request | — |\n| `list-tables` | Enumerate tables (and their fields) in a base. | request | — |\n| `update-record` | PATCH a record's fields (partial update). | request | — |\n\n### Anthropic (`anthropic`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `classify-text` | Asks Claude to put a text into exactly one of the categories you list and returns the category with a one-sentence reason as structured JSON. | request | — |\n| `list-models` | Lists the Claude models this API key can call, with their ids and display names. | request | — |\n| `summarize-text` | Sends a text to Claude and returns a short summary. | request | — |\n\n### AWS AppSync (Cognito User-Password) (`appsync-cognito`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-entity` | Starter mutation pattern. | request | — |\n| `list-page` | Starter pattern for AppSync list queries that return items plus nextToken. | request | — |\n| `query-by-id` | Generic AppSync query pattern with explicit variables and body.errors handling. | request | — |\n\n### AWS AppSync (IAM SigV4) (`appsync-iam`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-entity` | Starter mutation pattern. | request | — |\n| `list-page` | Starter pattern for AppSync list queries that return items plus nextToken. | request | — |\n| `query-by-id` | Generic AppSync query pattern with explicit variables and body.errors handling. | request | — |\n\n### Asana (`asana`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `add-comment` | POST a comment story. | request | — |\n| `create-task` | POST a new task to a project. | request | — |\n| `get-task` | Fetch one task record. | request | — |\n| `list-projects` | Enumerate projects. | request | — |\n| `list-tags` | Enumerate tags. | request | — |\n| `list-tasks` | Enumerate tasks for a project. | request | — |\n| `list-users` | Enumerate users in a workspace. | request | — |\n| `list-workspaces` | Enumerate workspaces the user is a member of. | request | — |\n| `me` | Fetch the user record for the PAT/OAuth identity. | request | — |\n| `update-task` | PUT changes to a task (assignee, due date, name). | request | — |\n\n### AWS API Gateway (IAM SigV4) (`aws-apigw-iam`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `signed-get` | Call an IAM-authorized API Gateway GET endpoint. | request | — |\n| `signed-post` | Call an IAM-authorized API Gateway POST endpoint with JSON body. | request | — |\n\n### AWS CloudWatch Alarms (`aws-cloudwatch-alarms`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `describe-alarms` | List alarms by name prefix, state, or alarm-action prefix. | request | — |\n| `disable-actions` | External write. | request | — |\n| `enable-actions` | External write. | request | — |\n| `set-alarm-state` | External write. | request | — |\n\n### AWS CloudWatch Logs (`aws-cloudwatch-logs`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-log-group` | External write. | request | — |\n| `filter-log-events` | Server-side filter pattern over a log group, optionally bounded by a time window. | request | — |\n| `list-log-groups` | Page through all log groups in the account, optionally filtered by name prefix. | request | — |\n| `put-log-event` | External write. | request | — |\n| `query-logs-insights` | Two-step pattern: StartQuery returns a queryId; GetQueryResults polls until the query completes. | request | — |\n| `set-retention` | External write. | request | — |\n\n### AWS CloudWatch Metrics (`aws-cloudwatch-metrics`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-metric-data` | Modern GetMetricData endpoint — fetch many metrics + statistics in a single call. | request | — |\n| `get-metric-statistics` | Query average / sum / max / min / sample-count over a time window with a period. | request | — |\n| `list-metrics` | Cursor-paginated listing of metric names + dimensions in a namespace. | request | — |\n| `put-metric-data` | External write. | request | — |\n\n### AWS Cognito User Pools (`aws-cognito-user-pools`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `admin-add-user-to-group` | Add a user to a Cognito group. | request | — |\n| `admin-disable-user` | Disable a user in a Cognito user pool. | request | — |\n| `admin-get-user` | Get one user by username from a user pool. | request | — |\n| `list-users` | List users in a user pool with optional pagination token. | request | — |\n\n### AWS DynamoDB (`aws-dynamodb`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-item` | Get one DynamoDB item by key using the JSON protocol. | request | — |\n| `put-item` | Write one DynamoDB item. | request | — |\n| `query-items` | Query a table or index with KeyConditionExpression and optional ExclusiveStartKey. | request | — |\n| `scan-page` | Scan a bounded page and return LastEvaluatedKey; use carefully on large tables. | request | — |\n\n### AWS EventBridge (`aws-eventbridge`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-rule` | External write. | request | — |\n| `disable-rule` | External write. | request | — |\n| `enable-rule` | External write. | request | — |\n| `list-rules` | List rules in a bus, optionally filtered by name prefix. | request | — |\n| `list-targets` | Show every target wired up to a rule (Lambda, SQS, SNS, ECS task, etc.). | request | — |\n| `put-events` | External write. | request | — |\n\n### AWS Lambda (`aws-lambda`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `invoke-function` | Invoke a Lambda function synchronously with a JSON payload. | request | — |\n\n### AWS S3 (`aws-s3`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `delete-object` | Delete one object key. | request | — |\n| `get-object-text` | Download an object and parse it as text. | request | — |\n| `list-prefix` | List objects under a prefix with optional pagination. | request | — |\n| `put-object-text` | Upload text content to an S3 key. | request | — |\n\n### AWS SES (`aws-ses`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `send-email` | Send a simple SES email from a verified identity. | request | — |\n\n### AWS SQS (`aws-sqs`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `delete-message` | Delete one received message by receipt handle. | request | — |\n| `receive-messages` | Receive a bounded batch without deleting it. | request | — |\n| `send-message` | Send one message to a queue URL. | request | — |\n\n### AWS STS (`aws-sts`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `assume-role` | External write (issues new credentials). | request | — |\n| `assume-role-with-web-identity` | Exchange a short-lived OIDC JWT (GitHub Actions, Auth0, custom IdP) for AWS temporary credentials. | request | — |\n| `get-caller-identity` | Returns the account, ARN, and userId of the IAM principal whose credentials signed the call. | request | — |\n| `get-session-token` | External write. | request | — |\n\n### Browserless (`browserless`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `scrape-then-email-digest` | Reliable scrape-then-email pattern for pages that load content via client-side JS. | schedule | `undefined`, `undefined` |\n\n### Cloudflare (`cloudflare`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-dns-records` | List DNS records for a Cloudflare zone. | request | — |\n| `list-zones` | List zones visible to the configured API token. | request | — |\n| `verify-token` | Verify that the configured Cloudflare API token is active and accepted. | request | — |\n\n### Firebase (`firebase`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `signin-email-password-then-firestore-read` | Two-step auth-chain pattern. | request | — |\n\n### GitHub (REST) (`github`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-issue` | POST a new issue to a repo. | request | — |\n| `delegated-triage-via-call` | File an issue then invoke a tenant-defined `triage-issue` sub-workflow by slug. | request | — |\n| `fan-out-issues-prs-releases` | Demonstrates ParallelStep — three independent GET requests run concurrently against the same repo (issues, pulls, releases) and the workflow surfaces the merged shape. | request | — |\n| `get-pr` | Fetch one PR by number. | request | — |\n| `get-repo` | Fetch a repo record by `owner/repo`. | request | — |\n| `list-all-repos-paginate-js-form` | Demonstrates LoopStep.data_selector — JS arrow form. | request | — |\n| `list-commits` | Page through commits on the default branch. | request | — |\n| `list-issues` | Page through open issues. | request | — |\n| `list-my-repos` | Page through the authenticated user's repos. | request | — |\n| `list-prs` | Page through open PRs for a repo. | request | — |\n| `list-releases` | Page through repo releases. | request | — |\n| `list-repos-retry-on-secondary-rate-limit` | Demonstrates RequestStep.retry_on_status + retry_backoff_ms. | request | — |\n| `list-workflow-runs` | Page through Actions workflow runs for a repo. | request | — |\n| `me` | Fetch the user record for the PAT/OAuth-authenticated identity. | request | — |\n| `merge-pr-after-approval` | Open a pull request, then pause until a reviewer POSTs an `pr_approved` signal to /v1/executions/{execution_id}/signals (typically via a portal-token approval link), then merge. | request | — |\n\n### GitHub (GraphQL) (`github-graphql`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-viewer-repositories` | Fetch the first page of repositories visible to the authenticated viewer with pageInfo for follow-up cursor pagination. | request | — |\n| `repository-issues` | Fetch issues for an owner/repo pair with labels, assignees, and cursor metadata. | request | — |\n| `repository-pull-requests` | Fetch recent pull requests with review status signals and cursor metadata. | request | — |\n| `search-repositories` | Run a GitHub GraphQL search query and return repository nodes plus rate-limit cost. | request | — |\n| `user-project-items` | Read every item and up to 20 Text and SingleSelect field values per item from a user-owned ProjectV2 with checked cursor pagination. | request | — |\n| `viewer` | Fetch the authenticated viewer and current GraphQL rate-limit state. | request | — |\n\n### Google Analytics 4 (`google-analytics`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `realtime-active-users` | Reads the realtime report: active users in the last 30 minutes per country. | request | — |\n| `run-report` | Runs one GA4 report with the core totals (active users, sessions, page views, key events) for the given date range. | request | — |\n| `top-pages` | Returns the pages with the most page views in the date range, ordered by views. | request | — |\n| `traffic-sources` | Returns the traffic sources that brought the most sessions in the date range. | request | — |\n\n### HubSpot (`hubspot`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-contact` | POST a new contact with email + firstname + lastname properties. | request | — |\n| `get-contact` | Fetch a single contact record. | request | — |\n| `list-companies` | Page through CRM companies. | request | — |\n| `list-contacts` | Page through CRM contacts with cursor pagination. | request | — |\n| `list-deals` | Page through CRM deals with stage + amount surfaced. | request | — |\n| `list-owners` | Enumerate CRM owners (users assigned to records). | request | — |\n| `list-pipelines` | Enumerate deal pipelines and their stages. | request | — |\n| `list-properties-contacts` | Return every property defined on the contact object — useful for property discovery before authoring. | request | — |\n| `list-tickets` | Page through CRM tickets. | request | — |\n| `postmortem-due-in-n-days-via-state` | Schedule + State multi-day lifecycle. | schedule | — |\n| `search-contacts-by-email` | Use the CRM search API to find contacts whose primary email matches. | request | — |\n\n### Intercom (`intercom`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-contact` | POST a new contact (role=user, email). | request | — |\n| `get-contact` | Fetch a single contact. | request | — |\n| `list-admins` | Enumerate admins. | request | — |\n| `list-contacts` | Search contacts ordered by created desc. | request | — |\n| `list-conversations` | Search conversations ordered by updated_at desc. | request | — |\n| `list-tags` | Enumerate tags in the workspace. | request | — |\n| `me` | Identity probe. | request | — |\n| `reply-to-conversation` | POST a reply (admin replies via assignee). | request | — |\n| `trial-nurture-day-1-3-7-14-via-state` | Replaces a multi-day in-flight wait with the canonical Schedule + State pattern. | schedule | — |\n\n### Jina Reader (`jina-reader`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `sec-filing-to-markdown` | Pattern for converting SEC filing HTML pages to markdown for downstream extraction. | request | — |\n| `url-to-markdown` | Fetch a web page through Jina Reader and return clean markdown. | request | — |\n\n### Jira (`jira`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-my-issues` | Fetch every issue assigned to the current user regardless of status. | request | — |\n| `list-open-issues` | Fetch issues assigned to the current user whose lifecycle is not Done, sorted by most recent update. | request | — |\n| `search-issues-by-jql` | Run an arbitrary JQL query against the Jira /search endpoint. | request | — |\n\n### Linear (`linear`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-issue` | Mutation to create an issue with a title. | request | — |\n| `get-issue` | Fetch one issue with its state + assignee. | request | — |\n| `list-cycles` | Enumerate cycles for a team. | request | — |\n| `list-issues` | First 50 open issues for a team, ordered by createdAt desc. | request | — |\n| `list-projects` | Enumerate projects with their progress. | request | — |\n| `list-teams` | Enumerate teams the user belongs to. | request | — |\n| `update-issue` | Mutation to update title / description / state. | request | — |\n| `viewer` | Identity probe via GraphQL `viewer { id email name }`. | request | — |\n\n### LinkedIn (`linkedin`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-post` | Publish a text post to the authenticated member's LinkedIn feed. | request | — |\n\n### Mailchimp (`mailchimp`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `add-member` | POST a subscriber. | request | — |\n| `campaign-report` | Engagement summary for a campaign. | request | — |\n| `list-audiences` | Enumerate audiences. | request | — |\n| `list-campaigns` | Page through campaigns. | request | — |\n| `list-members` | Page through members. | request | — |\n| `list-tags` | Enumerate tags. | request | — |\n| `ping` | Probe the API to validate the API key and data center suffix. | request | — |\n| `send-campaign` | Trigger send for a campaign id. | request | — |\n\n### Monday.com (`monday`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `complexity-probe` | Read the remaining complexity budget — useful before bulk operations. | request | — |\n| `create-item` | Add a new item to a board with column values. | request | — |\n| `get-board` | Fetch one board with its columns + first 100 items. | request | — |\n| `list-boards` | Page through accessible boards. | request | — |\n| `list-users` | Enumerate users. | request | — |\n| `list-workspaces` | Enumerate workspaces. | request | — |\n| `me` | Identity probe via GraphQL `me { id email name }`. | request | — |\n| `update-item-column` | Change a single column on an item. | request | — |\n\n### Notion (`notion`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-page` | Add a new row to a database with title + properties. | request | — |\n| `get-database` | Fetch one database's schema (properties + types). | request | — |\n| `get-page` | Fetch a single page record by id. | request | — |\n| `list-databases` | Enumerate databases the integration has access to. | request | — |\n| `list-page-children` | Page through the block tree under a page. | request | — |\n| `list-users` | Enumerate users in the workspace. | request | — |\n| `me` | Identity probe — useful before driving the API. | request | — |\n| `query-database` | Run a database query with filter + sort. | request | — |\n| `search` | Full-text search across pages + databases the integration sees. | request | — |\n| `update-page` | PATCH a page's properties block. | request | — |\n\n### OAuth2 Generic (`oauth2-generic`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `client-credentials-grant` | RFC 6749 §4.4 client_credentials grant. | request | — |\n| `device-code-flow` | First leg of the device-authorization grant for input-constrained devices (CLIs, TVs, IoT). | request | — |\n| `exchange-code-for-token` | RFC 6749 §4.1 authorization-code grant. | request | — |\n| `introspect-token` | Ask the authorization server whether a token is still active and what scopes / subject it represents. | request | — |\n| `refresh-access-token` | RFC 6749 §6 refresh-token grant. | request | — |\n| `revoke-token` | External write. | request | — |\n\n### OpenAI (`openai`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-embedding` | Create one text embedding for downstream semantic matching. | request | — |\n| `list-models` | List models available to the API key. | request | — |\n| `structured-extraction` | Extract people from text using a JSON schema response format. | request | — |\n\n### PostgreSQL (`postgres`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `active-connections` | pg_stat_activity snapshot — useful when investigating a stuck query or a connection storm. | request | — |\n| `atomic-debit-credit-double-entry` | Demonstrates RequestStep.sql.also — both the debit and credit run inside one transaction; either both commit or both roll back. | request | — |\n| `describe-table` | Return column name, data type, nullability, and default for a given table. | request | — |\n| `export-large-table-stream` | Demonstrates RequestStep.sql.cursor — instead of buffering the full result set in memory, the driver streams rows in batches of 1000 via a server-side cursor. | request | — |\n| `list-indexes` | Return index name, columns, and uniqueness for a target table. | request | — |\n| `list-schemas` | Enumerate non-system schemas. | request | — |\n| `list-tables` | List every table in the `public` schema with row-count estimates from pg_class. | request | — |\n| `recent-rows` | ORDER BY a timestamp column (default `created_at`) DESC LIMIT N. | request | — |\n| `row-count` | SELECT COUNT(*) for the supplied table. | request | — |\n| `table-bytes` | Use pg_total_relation_size to rank tables. | request | — |\n| `update-must-affect-exactly-one-row` | Demonstrates RequestStep.expected_row_count — UPDATE that affects more or fewer than one row triggers `expected_row_count_mismatch` and rolls back. | request | — |\n\n### SendGrid (`sendgrid`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-list` | POST a new marketing list. | request | — |\n| `get-template` | Fetch one template (versions + active). | request | — |\n| `list-contacts` | Page through marketing contacts. | request | — |\n| `list-stats` | Aggregated stats for the last 7 days. | request | — |\n| `list-suppressions` | Enumerate the bounce suppression list. | request | — |\n| `list-templates` | Page through dynamic templates. | request | — |\n| `send-from-template` | Send transactional mail using a dynamic template id and substitution data. | request | — |\n| `send-mail` | POST /v3/mail/send with from + to + subject + content. | request | — |\n\n### Shopify (`shopify`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-customers` | Page through customers. | request | — |\n| `list-orders` | Page through open orders. | request | — |\n| `list-products` | Page through products in the catalog. | request | — |\n| `shop-info` | Smoke probe — fetches store metadata. | request | — |\n\n### Slack (`slack`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `add-reaction` | Star/+1/etc — react to a message. | request | — |\n| `auth-test` | Validate the bot token. | request | — |\n| `channel-history` | Fetch recent messages from a channel. | request | — |\n| `create-channel` | Provision a new channel. | request | — |\n| `invite-user` | Add users to a channel. | request | — |\n| `list-channels` | Page through public channels with cursor pagination. | request | — |\n| `list-users` | Enumerate workspace members. | request | — |\n| `post-message` | Send a chat.postMessage to a channel id. | request | — |\n| `post-then-pause-then-edit` | Demonstrates WaitStep (short, in-process, duration_ms ≤ 6h). | request | — |\n| `team-info` | Workspace metadata (name, domain, enterprise). | request | — |\n| `upload-file` | Upload an attachment to a channel via files.upload. | request | — |\n\n### Square (`square`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-customer` | POST a new customer with given_name + email. | request | — |\n| `inventory-counts` | Fetch real-time inventory counts. | request | — |\n| `list-catalog-items` | Page through catalog items (ITEM type). | request | — |\n| `list-customers` | Page through customers. | request | — |\n| `list-locations` | Smoke probe — every Square workflow starts with a location id. | request | — |\n| `list-orders` | POST /orders/search with a location filter. | request | — |\n| `list-payments` | Page through Payments. | request | — |\n| `list-team-members` | Search team members at a location. | request | — |\n| `merchant-info` | Fetch merchant metadata. | request | — |\n| `refund-payment` | POST /refunds with payment_id + amount + currency. | request | — |\n\n### Stripe (`stripe`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `charge-or-refund-by-amount` | Demonstrates BranchStep — when amount > 0, capture a charge against the customer; when amount < 0, issue a refund of the absolute value against the most recent charge. | request | — |\n| `create-customer` | POST a new customer record. | request | — |\n| `create-customer-idempotent` | Demonstrates RequestStep.idempotency_key — the workflow can re-run with the same email and Stripe will return the original customer instead of creating a duplicate. | request | — |\n| `create-payment-intent` | POST a new payment intent. | request | — |\n| `daily-charges-digest` | Pull yesterday's charges every business day at 08:00 Europe/Berlin and summarise total volume + count by currency. | schedule | — |\n| `get-charge` | Fetch a single charge record by its Stripe id. | request | — |\n| `get-customer` | Fetch a single customer record by its Stripe id. | request | — |\n| `incremental-charges-via-state` | Canonical AI-authoring few-shot for the multi-day lifecycle pattern: a daily schedule wakes the workflow, `state_read` pulls the last-synced cursor (`null` on the first run via `default_value`), the request lists only newer charges, and `state_write` advances the watermark in the same transaction as the step result. | schedule | — |\n| `list-balance-transactions` | Page through Stripe balance transactions for finance reporting. | request | — |\n| `list-charges` | Page through charges, surfacing id + amount + currency + status. | request | — |\n| `list-charges-validate-no-zero-amount` | Demonstrates WorkflowDef.validation_function — a QuickJS expression evaluated against the final output. | request | — |\n| `list-customers` | Page through the most recent customers, returning id + email + created timestamp. | request | — |\n| `list-invoices` | Page through invoices, surfacing id + status + amount_due + customer. | request | — |\n| `list-payment-intents` | Page through payment intents with cursor pagination. | request | — |\n| `list-prices` | List prices, optionally scoped to one product id. | request | — |\n| `list-products` | Page through Stripe products. | request | — |\n| `list-subscriptions` | List subscriptions, defaulting to active status. | request | — |\n| `new-customer-enrich-notify` | Three-connector reference recipe. | request | `undefined`, `undefined`, `undefined` |\n| `on-charge-failed-notify-slack` | Webhook-triggered: when Stripe fires `charge.failed` against the workflow's inbound URL, this recipe verifies the Stripe signature, extracts the failed-charge fields (id, amount, currency, decline reason, customer email), and posts a redacted alert into the operator's chosen Slack channel. | webhook | `undefined` |\n\n### Twilio (`twilio`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `account-balance` | Fetch account balance + currency. | request | — |\n| `get-message` | Fetch a message record. | request | — |\n| `list-calls` | Recent voice call records. | request | — |\n| `list-messages` | Page through Messages.json. | request | — |\n| `list-numbers` | Enumerate purchased numbers. | request | — |\n| `send-sms` | POST a message via Messages.json — pass From + To + Body. | request | — |\n| `send-whatsapp` | Send via the WhatsApp From channel — From and To prefixed with `whatsapp:`. | request | — |\n| `verify-phone-lookup` | Use the Lookup API to validate a phone number. | request | — |\n\n### Vercel (`vercel`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-deployment` | Fetch one deployment by id or URL. | request | — |\n| `list-deployments` | List recent deployments, optionally scoped by project. | request | — |\n| `list-projects` | List projects visible to the token. | request | — |\n\n### Web Scraper (`web-scraper`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `crawl-sitemap-to-markdown` | Fetch a site's sitemap.xml, loop over its <loc> entries, extract the main article of each page via Readability, and return an array of { title, url, markdown } envelopes. | request | — |\n| `extract-main-content` | GET a URL, run Mozilla Readability to isolate the article, then convert to markdown. | request | — |\n| `fetch-url-as-markdown` | GET a single public URL and convert its HTML body to markdown. | request | — |\n\n### Xray Cloud (GraphQL) (`xray-cloud`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-test-by-issue-id` | Fetch a single Xray test entity by its Jira issue ID. | request | — |\n| `introspect-schema` | Run a standard GraphQL introspection query to verify the credential and enumerate available types. | request | — |"
        },
        "de": {
          "title": "Konnektor- und Rezeptkatalog",
          "summary": "Finde die Konnektor-Vorlagen und Rezepte, die SubKit mitbringt.",
          "headings": [
            {
              "depth": 1,
              "text": "Connector & recipe catalog",
              "anchor": "connector--recipe-catalog"
            },
            {
              "depth": 2,
              "text": "Connector templates",
              "anchor": "connector-templates"
            },
            {
              "depth": 3,
              "text": "CRM",
              "anchor": "crm"
            },
            {
              "depth": 3,
              "text": "Payments",
              "anchor": "payments"
            },
            {
              "depth": 3,
              "text": "E-commerce",
              "anchor": "e-commerce"
            },
            {
              "depth": 3,
              "text": "Marketing",
              "anchor": "marketing"
            },
            {
              "depth": 3,
              "text": "Communication",
              "anchor": "communication"
            },
            {
              "depth": 3,
              "text": "Project management",
              "anchor": "project-management"
            },
            {
              "depth": 3,
              "text": "Productivity & documents",
              "anchor": "productivity--documents"
            },
            {
              "depth": 3,
              "text": "File storage",
              "anchor": "file-storage"
            },
            {
              "depth": 3,
              "text": "Dev tools",
              "anchor": "dev-tools"
            },
            {
              "depth": 3,
              "text": "Databases",
              "anchor": "databases"
            },
            {
              "depth": 3,
              "text": "Analytics",
              "anchor": "analytics"
            },
            {
              "depth": 3,
              "text": "Web scraping",
              "anchor": "web-scraping"
            },
            {
              "depth": 3,
              "text": "Enterprise & support",
              "anchor": "enterprise--support"
            },
            {
              "depth": 3,
              "text": "AI",
              "anchor": "ai"
            },
            {
              "depth": 3,
              "text": "Cloud",
              "anchor": "cloud"
            },
            {
              "depth": 3,
              "text": "AWS operations",
              "anchor": "aws-operations"
            },
            {
              "depth": 2,
              "text": "Recipes",
              "anchor": "recipes"
            },
            {
              "depth": 3,
              "text": "Airtable (`airtable`)",
              "anchor": "airtable-airtable"
            },
            {
              "depth": 3,
              "text": "Anthropic (`anthropic`)",
              "anchor": "anthropic-anthropic"
            },
            {
              "depth": 3,
              "text": "AWS AppSync (Cognito User-Password) (`appsync-cognito`)",
              "anchor": "aws-appsync-cognito-user-password-appsync-cognito"
            },
            {
              "depth": 3,
              "text": "AWS AppSync (IAM SigV4) (`appsync-iam`)",
              "anchor": "aws-appsync-iam-sigv4-appsync-iam"
            },
            {
              "depth": 3,
              "text": "Asana (`asana`)",
              "anchor": "asana-asana"
            },
            {
              "depth": 3,
              "text": "AWS API Gateway (IAM SigV4) (`aws-apigw-iam`)",
              "anchor": "aws-api-gateway-iam-sigv4-aws-apigw-iam"
            },
            {
              "depth": 3,
              "text": "AWS CloudWatch Alarms (`aws-cloudwatch-alarms`)",
              "anchor": "aws-cloudwatch-alarms-aws-cloudwatch-alarms"
            },
            {
              "depth": 3,
              "text": "AWS CloudWatch Logs (`aws-cloudwatch-logs`)",
              "anchor": "aws-cloudwatch-logs-aws-cloudwatch-logs"
            },
            {
              "depth": 3,
              "text": "AWS CloudWatch Metrics (`aws-cloudwatch-metrics`)",
              "anchor": "aws-cloudwatch-metrics-aws-cloudwatch-metrics"
            },
            {
              "depth": 3,
              "text": "AWS Cognito User Pools (`aws-cognito-user-pools`)",
              "anchor": "aws-cognito-user-pools-aws-cognito-user-pools"
            },
            {
              "depth": 3,
              "text": "AWS DynamoDB (`aws-dynamodb`)",
              "anchor": "aws-dynamodb-aws-dynamodb"
            },
            {
              "depth": 3,
              "text": "AWS EventBridge (`aws-eventbridge`)",
              "anchor": "aws-eventbridge-aws-eventbridge"
            },
            {
              "depth": 3,
              "text": "AWS Lambda (`aws-lambda`)",
              "anchor": "aws-lambda-aws-lambda"
            },
            {
              "depth": 3,
              "text": "AWS S3 (`aws-s3`)",
              "anchor": "aws-s3-aws-s3"
            },
            {
              "depth": 3,
              "text": "AWS SES (`aws-ses`)",
              "anchor": "aws-ses-aws-ses"
            },
            {
              "depth": 3,
              "text": "AWS SQS (`aws-sqs`)",
              "anchor": "aws-sqs-aws-sqs"
            },
            {
              "depth": 3,
              "text": "AWS STS (`aws-sts`)",
              "anchor": "aws-sts-aws-sts"
            },
            {
              "depth": 3,
              "text": "Browserless (`browserless`)",
              "anchor": "browserless-browserless"
            },
            {
              "depth": 3,
              "text": "Cloudflare (`cloudflare`)",
              "anchor": "cloudflare-cloudflare"
            },
            {
              "depth": 3,
              "text": "Firebase (`firebase`)",
              "anchor": "firebase-firebase"
            },
            {
              "depth": 3,
              "text": "GitHub (REST) (`github`)",
              "anchor": "github-rest-github"
            },
            {
              "depth": 3,
              "text": "GitHub (GraphQL) (`github-graphql`)",
              "anchor": "github-graphql-github-graphql"
            },
            {
              "depth": 3,
              "text": "Google Analytics 4 (`google-analytics`)",
              "anchor": "google-analytics-4-google-analytics"
            },
            {
              "depth": 3,
              "text": "HubSpot (`hubspot`)",
              "anchor": "hubspot-hubspot"
            },
            {
              "depth": 3,
              "text": "Intercom (`intercom`)",
              "anchor": "intercom-intercom"
            },
            {
              "depth": 3,
              "text": "Jina Reader (`jina-reader`)",
              "anchor": "jina-reader-jina-reader"
            },
            {
              "depth": 3,
              "text": "Jira (`jira`)",
              "anchor": "jira-jira"
            },
            {
              "depth": 3,
              "text": "Linear (`linear`)",
              "anchor": "linear-linear"
            },
            {
              "depth": 3,
              "text": "LinkedIn (`linkedin`)",
              "anchor": "linkedin-linkedin"
            },
            {
              "depth": 3,
              "text": "Mailchimp (`mailchimp`)",
              "anchor": "mailchimp-mailchimp"
            },
            {
              "depth": 3,
              "text": "Monday.com (`monday`)",
              "anchor": "mondaycom-monday"
            },
            {
              "depth": 3,
              "text": "Notion (`notion`)",
              "anchor": "notion-notion"
            },
            {
              "depth": 3,
              "text": "OAuth2 Generic (`oauth2-generic`)",
              "anchor": "oauth2-generic-oauth2-generic"
            },
            {
              "depth": 3,
              "text": "OpenAI (`openai`)",
              "anchor": "openai-openai"
            },
            {
              "depth": 3,
              "text": "PostgreSQL (`postgres`)",
              "anchor": "postgresql-postgres"
            },
            {
              "depth": 3,
              "text": "SendGrid (`sendgrid`)",
              "anchor": "sendgrid-sendgrid"
            },
            {
              "depth": 3,
              "text": "Shopify (`shopify`)",
              "anchor": "shopify-shopify"
            },
            {
              "depth": 3,
              "text": "Slack (`slack`)",
              "anchor": "slack-slack"
            },
            {
              "depth": 3,
              "text": "Square (`square`)",
              "anchor": "square-square"
            },
            {
              "depth": 3,
              "text": "Stripe (`stripe`)",
              "anchor": "stripe-stripe"
            },
            {
              "depth": 3,
              "text": "Twilio (`twilio`)",
              "anchor": "twilio-twilio"
            },
            {
              "depth": 3,
              "text": "Vercel (`vercel`)",
              "anchor": "vercel-vercel"
            },
            {
              "depth": 3,
              "text": "Web Scraper (`web-scraper`)",
              "anchor": "web-scraper-web-scraper"
            },
            {
              "depth": 3,
              "text": "Xray Cloud (GraphQL) (`xray-cloud`)",
              "anchor": "xray-cloud-graphql-xray-cloud"
            }
          ],
          "images": [],
          "sha256": "745b7a1cfb1d58b392d8b8b696085946c9dca0025cad83afeab394659ad296fe",
          "body": "Eine Konnektor-Vorlage verbindet ein System: Adresse, Anmeldung, Endpunkte und ein Grundlagen-Skill des Anbieters. Viele Vorlagen bringen Rezepte mit, also fertige Workflows, die du klonst, statt bei null anzufangen. Sagst du im Chat, was du brauchst, nimmt SubKit das passende Rezept als ersten Entwurf. Ein System ohne Vorlage verbindest du aus der Beschreibung seiner Schnittstelle.\n\nDer Katalog unten wird aus den Konnektor-Vorlagen erzeugt und ist deshalb auf Englisch.\n\n# Connector & recipe catalog\n\nFind the connector templates and recipes that ship with SubKit. There are **61 connector templates** in **16 categories**, carrying **248 recipes**: complete, runnable workflows you clone instead of starting from a blank page.\n\nA **template** connects a system: base URL, sign-in flow, endpoint schema and a vendor-basics skill. A **recipe** is a complete workflow built on that template. Say what you want in a conversation, and SubKit clones the closest recipe as your first draft.\n\n## Connector templates\n\n### CRM\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **HubSpot** | `hubspot` | http | bearer | HubSpot CRM API |\n| **Salesforce** | `salesforce` | http | oauth2 | Salesforce REST API |\n\n### Payments\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Square** | `square` | http | bearer | Square payments and commerce API |\n| **Stripe** | `stripe` | http | bearer | Stripe payments API |\n\n### E-commerce\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Shopify** | `shopify` | http | header | Shopify Admin REST API |\n\n### Marketing\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Mailchimp** | `mailchimp` | http | bearer | Mailchimp email marketing API |\n\n### Communication\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Google Chat** | `google-chat` | http | oauth2 | Google Chat API |\n| **Google Gmail** | `google-gmail` | http | oauth2 | Google Gmail API |\n| **LinkedIn** | `linkedin` | http | oauth2 | LinkedIn API — member identity (OpenID Connect) and posting (UGC Posts). |\n| **SendGrid** | `sendgrid` | http | bearer | SendGrid email delivery API |\n| **Slack** | `slack` | http | bearer | Slack Web API |\n| **Twilio** | `twilio` | http | basic | Twilio SMS, Voice, and Messaging API |\n\n### Project management\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Asana** | `asana` | http | bearer | Asana project management API |\n| **Jira** | `jira` | http | oauth2 | Jira Cloud REST API. |\n| **Linear** | `linear` | graphql | bearer | Linear GraphQL API |\n| **Monday.com** | `monday` | graphql | bearer | Monday.com GraphQL API |\n| **Xray Cloud (GraphQL)** | `xray-cloud` | graphql | oauth2 | Xray Cloud test-management GraphQL API. |\n\n### Productivity & documents\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Airtable** | `airtable` | http | bearer | Airtable REST API |\n| **Confluence** | `confluence` | http | oauth2 | Confluence Cloud wiki API |\n| **Google Calendar** | `google-calendar` | http | oauth2 | Google Calendar API |\n| **Google Docs** | `google-docs` | http | oauth2 | Google Docs API |\n| **Google Sheets** | `google-sheets` | http | oauth2 | Google Sheets API |\n| **Google Workspace** | `google-workspace` | http | oauth2 | Google Workspace APIs (Gmail, Calendar, Drive) |\n| **HTTP API** | `http` | http | none | Any HTTP or REST API that has no dedicated template: set the base URL, pick how it authenticates, and every request step against it is governed like the rest. |\n| **Notion** | `notion` | http | bearer | Notion API |\n| **Web Scraper** | `web-scraper` | http | none | Fetch public web pages and convert to markdown / extract structured data. |\n\n### File storage\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Dropbox** | `dropbox` | http | oauth2 | Dropbox file storage API |\n| **Google Drive** | `google-drive` | http | oauth2 | Google Drive file storage API |\n\n### Dev tools\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **App Store Connect** | `app-store-connect` | http | signed_jwt | App Store Connect REST API for app metadata, TestFlight builds, beta groups, testers, and public links. |\n| **GitHub (REST)** | `github` | http | bearer | GitHub REST API (date-versioned: 2026-03-10 latest, 2022-11-28 default) — best for write operations (issue creation, PR merge, file commits) where REST is more expressive than GraphQL. |\n| **GitHub (GraphQL)** | `github-graphql` | graphql | bearer | GitHub GraphQL API v4 — read nested repository and ProjectV2 data without relying on REST OpenAPI discovery. |\n| **Vercel** | `vercel` | http | bearer | Vercel deployment and hosting API |\n\n### Databases\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Firebase** | `firebase` | http | oauth2 | Firebase Firestore REST API |\n| **PostgreSQL** | `postgres` | postgres | none | PostgreSQL relational database |\n| **Supabase** | `supabase` | http | header | Supabase PostgREST API |\n| **Supabase (GraphQL)** | `supabase-graphql` | graphql | header | Supabase GraphQL API (pg_graphql at /graphql/v1) — one roundtrip for nested reads instead of N+1 PostgREST calls. |\n\n### Analytics\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Google Analytics 4** | `google-analytics` | http | oauth2 | Google Analytics 4 Data API: users, sessions, page views, traffic sources and key events of a GA4 property. |\n| **Google Search Console** | `google-search-console` | http | oauth2 | Google Search Console API |\n\n### Web scraping\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Browserless** | `browserless` | http | query | Browserless headless Chrome API |\n| **Jina Reader** | `jina-reader` | http | bearer | Jina Reader URL-to-markdown and search API |\n\n### Enterprise & support\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Intercom** | `intercom` | http | bearer | Intercom customer messaging API |\n| **OAuth2 Generic** | `oauth2-generic` | http | header | Reusable OAuth2 endpoints (token exchange, refresh, introspect, revoke, client_credentials, device code) for arbitrary providers. |\n\n### AI\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **Anthropic** | `anthropic` | http | header | Anthropic Claude API: call Claude from a workflow step through a connector, with the same boundary and per-run token budget as every other connector call. |\n| **OpenAI** | `openai` | http | bearer | OpenAI API for models, responses, embeddings, files, and structured outputs. |\n\n### Cloud\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **AWS DynamoDB** | `aws-dynamodb` | http | aws_sigv4 | AWS DynamoDB NoSQL database API |\n| **AWS Lambda** | `aws-lambda` | http | aws_sigv4 | AWS Lambda serverless functions API |\n| **AWS S3** | `aws-s3` | s3 | header | Amazon S3 object storage |\n| **AWS SES** | `aws-ses` | http | aws_sigv4 | AWS Simple Email Service API |\n| **AWS SQS** | `aws-sqs` | http | aws_sigv4 | AWS Simple Queue Service API |\n| **Cloudflare** | `cloudflare` | http | bearer | Cloudflare REST API for zones, DNS, Workers, R2, Zero Trust, and account services |\n| **DigitalOcean** | `digitalocean` | http | bearer | DigitalOcean cloud API |\n| **Google Cloud Storage** | `google-cloud-storage` | http | oauth2 | Google Cloud Storage JSON API |\n\n### AWS operations\n\n| Template | slug | driver | auth | What it connects |\n| -------- | ---- | ------ | ---- | ---------------- |\n| **AWS AppSync (Cognito User-Password)** | `appsync-cognito` | graphql | oauth2 | AWS AppSync GraphQL API authenticated via Cognito User-Pool USER_PASSWORD_AUTH. |\n| **AWS AppSync (IAM SigV4)** | `appsync-iam` | graphql | aws_sigv4 | AWS AppSync GraphQL API authenticated via IAM SigV4. |\n| **AWS API Gateway (IAM SigV4)** | `aws-apigw-iam` | http | aws_sigv4 | AWS API Gateway REST endpoint with IAM authorization. |\n| **AWS CloudWatch Alarms** | `aws-cloudwatch-alarms` | http | aws_sigv4 | Amazon CloudWatch Alarms API. |\n| **AWS CloudWatch Logs** | `aws-cloudwatch-logs` | http | aws_sigv4 | Amazon CloudWatch Logs API for log ingestion + Logs Insights query. |\n| **AWS CloudWatch Metrics** | `aws-cloudwatch-metrics` | http | aws_sigv4 | Amazon CloudWatch Metrics API for metric ingestion + statistic queries. |\n| **AWS Cognito User Pools** | `aws-cognito-user-pools` | http | aws_sigv4 | Amazon Cognito User Pools administrative API for users and groups. |\n| **AWS EventBridge** | `aws-eventbridge` | http | aws_sigv4 | Amazon EventBridge API for event publishing + rule management. |\n| **AWS STS** | `aws-sts` | http | aws_sigv4 | AWS Security Token Service — temporary-credential issuance for cross-account / cross-role access. |\n\n## Recipes\n\nGrouped by template. **Trigger** is how the workflow starts: `request` (on demand — chat, CLI, MCP, REST), `schedule` (cron), or `webhook` (an external system calls in). **Also uses** lists connectors beyond the template's own.\n\n### Airtable (`airtable`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-record` | POST a new row with fields. | request | — |\n| `delete-record` | DELETE a record by id. | request | — |\n| `get-record` | Fetch a single record from a table. | request | — |\n| `list-bases` | Enumerate accessible bases via the meta API. | request | — |\n| `list-records` | Page through records with offset-based pagination. | request | — |\n| `list-records-formula` | Run a server-side filter formula against a table. | request | — |\n| `list-tables` | Enumerate tables (and their fields) in a base. | request | — |\n| `update-record` | PATCH a record's fields (partial update). | request | — |\n\n### Anthropic (`anthropic`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `classify-text` | Asks Claude to put a text into exactly one of the categories you list and returns the category with a one-sentence reason as structured JSON. | request | — |\n| `list-models` | Lists the Claude models this API key can call, with their ids and display names. | request | — |\n| `summarize-text` | Sends a text to Claude and returns a short summary. | request | — |\n\n### AWS AppSync (Cognito User-Password) (`appsync-cognito`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-entity` | Starter mutation pattern. | request | — |\n| `list-page` | Starter pattern for AppSync list queries that return items plus nextToken. | request | — |\n| `query-by-id` | Generic AppSync query pattern with explicit variables and body.errors handling. | request | — |\n\n### AWS AppSync (IAM SigV4) (`appsync-iam`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-entity` | Starter mutation pattern. | request | — |\n| `list-page` | Starter pattern for AppSync list queries that return items plus nextToken. | request | — |\n| `query-by-id` | Generic AppSync query pattern with explicit variables and body.errors handling. | request | — |\n\n### Asana (`asana`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `add-comment` | POST a comment story. | request | — |\n| `create-task` | POST a new task to a project. | request | — |\n| `get-task` | Fetch one task record. | request | — |\n| `list-projects` | Enumerate projects. | request | — |\n| `list-tags` | Enumerate tags. | request | — |\n| `list-tasks` | Enumerate tasks for a project. | request | — |\n| `list-users` | Enumerate users in a workspace. | request | — |\n| `list-workspaces` | Enumerate workspaces the user is a member of. | request | — |\n| `me` | Fetch the user record for the PAT/OAuth identity. | request | — |\n| `update-task` | PUT changes to a task (assignee, due date, name). | request | — |\n\n### AWS API Gateway (IAM SigV4) (`aws-apigw-iam`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `signed-get` | Call an IAM-authorized API Gateway GET endpoint. | request | — |\n| `signed-post` | Call an IAM-authorized API Gateway POST endpoint with JSON body. | request | — |\n\n### AWS CloudWatch Alarms (`aws-cloudwatch-alarms`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `describe-alarms` | List alarms by name prefix, state, or alarm-action prefix. | request | — |\n| `disable-actions` | External write. | request | — |\n| `enable-actions` | External write. | request | — |\n| `set-alarm-state` | External write. | request | — |\n\n### AWS CloudWatch Logs (`aws-cloudwatch-logs`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-log-group` | External write. | request | — |\n| `filter-log-events` | Server-side filter pattern over a log group, optionally bounded by a time window. | request | — |\n| `list-log-groups` | Page through all log groups in the account, optionally filtered by name prefix. | request | — |\n| `put-log-event` | External write. | request | — |\n| `query-logs-insights` | Two-step pattern: StartQuery returns a queryId; GetQueryResults polls until the query completes. | request | — |\n| `set-retention` | External write. | request | — |\n\n### AWS CloudWatch Metrics (`aws-cloudwatch-metrics`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-metric-data` | Modern GetMetricData endpoint — fetch many metrics + statistics in a single call. | request | — |\n| `get-metric-statistics` | Query average / sum / max / min / sample-count over a time window with a period. | request | — |\n| `list-metrics` | Cursor-paginated listing of metric names + dimensions in a namespace. | request | — |\n| `put-metric-data` | External write. | request | — |\n\n### AWS Cognito User Pools (`aws-cognito-user-pools`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `admin-add-user-to-group` | Add a user to a Cognito group. | request | — |\n| `admin-disable-user` | Disable a user in a Cognito user pool. | request | — |\n| `admin-get-user` | Get one user by username from a user pool. | request | — |\n| `list-users` | List users in a user pool with optional pagination token. | request | — |\n\n### AWS DynamoDB (`aws-dynamodb`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-item` | Get one DynamoDB item by key using the JSON protocol. | request | — |\n| `put-item` | Write one DynamoDB item. | request | — |\n| `query-items` | Query a table or index with KeyConditionExpression and optional ExclusiveStartKey. | request | — |\n| `scan-page` | Scan a bounded page and return LastEvaluatedKey; use carefully on large tables. | request | — |\n\n### AWS EventBridge (`aws-eventbridge`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-rule` | External write. | request | — |\n| `disable-rule` | External write. | request | — |\n| `enable-rule` | External write. | request | — |\n| `list-rules` | List rules in a bus, optionally filtered by name prefix. | request | — |\n| `list-targets` | Show every target wired up to a rule (Lambda, SQS, SNS, ECS task, etc.). | request | — |\n| `put-events` | External write. | request | — |\n\n### AWS Lambda (`aws-lambda`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `invoke-function` | Invoke a Lambda function synchronously with a JSON payload. | request | — |\n\n### AWS S3 (`aws-s3`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `delete-object` | Delete one object key. | request | — |\n| `get-object-text` | Download an object and parse it as text. | request | — |\n| `list-prefix` | List objects under a prefix with optional pagination. | request | — |\n| `put-object-text` | Upload text content to an S3 key. | request | — |\n\n### AWS SES (`aws-ses`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `send-email` | Send a simple SES email from a verified identity. | request | — |\n\n### AWS SQS (`aws-sqs`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `delete-message` | Delete one received message by receipt handle. | request | — |\n| `receive-messages` | Receive a bounded batch without deleting it. | request | — |\n| `send-message` | Send one message to a queue URL. | request | — |\n\n### AWS STS (`aws-sts`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `assume-role` | External write (issues new credentials). | request | — |\n| `assume-role-with-web-identity` | Exchange a short-lived OIDC JWT (GitHub Actions, Auth0, custom IdP) for AWS temporary credentials. | request | — |\n| `get-caller-identity` | Returns the account, ARN, and userId of the IAM principal whose credentials signed the call. | request | — |\n| `get-session-token` | External write. | request | — |\n\n### Browserless (`browserless`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `scrape-then-email-digest` | Reliable scrape-then-email pattern for pages that load content via client-side JS. | schedule | `undefined`, `undefined` |\n\n### Cloudflare (`cloudflare`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-dns-records` | List DNS records for a Cloudflare zone. | request | — |\n| `list-zones` | List zones visible to the configured API token. | request | — |\n| `verify-token` | Verify that the configured Cloudflare API token is active and accepted. | request | — |\n\n### Firebase (`firebase`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `signin-email-password-then-firestore-read` | Two-step auth-chain pattern. | request | — |\n\n### GitHub (REST) (`github`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-issue` | POST a new issue to a repo. | request | — |\n| `delegated-triage-via-call` | File an issue then invoke a tenant-defined `triage-issue` sub-workflow by slug. | request | — |\n| `fan-out-issues-prs-releases` | Demonstrates ParallelStep — three independent GET requests run concurrently against the same repo (issues, pulls, releases) and the workflow surfaces the merged shape. | request | — |\n| `get-pr` | Fetch one PR by number. | request | — |\n| `get-repo` | Fetch a repo record by `owner/repo`. | request | — |\n| `list-all-repos-paginate-js-form` | Demonstrates LoopStep.data_selector — JS arrow form. | request | — |\n| `list-commits` | Page through commits on the default branch. | request | — |\n| `list-issues` | Page through open issues. | request | — |\n| `list-my-repos` | Page through the authenticated user's repos. | request | — |\n| `list-prs` | Page through open PRs for a repo. | request | — |\n| `list-releases` | Page through repo releases. | request | — |\n| `list-repos-retry-on-secondary-rate-limit` | Demonstrates RequestStep.retry_on_status + retry_backoff_ms. | request | — |\n| `list-workflow-runs` | Page through Actions workflow runs for a repo. | request | — |\n| `me` | Fetch the user record for the PAT/OAuth-authenticated identity. | request | — |\n| `merge-pr-after-approval` | Open a pull request, then pause until a reviewer POSTs an `pr_approved` signal to /v1/executions/{execution_id}/signals (typically via a portal-token approval link), then merge. | request | — |\n\n### GitHub (GraphQL) (`github-graphql`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-viewer-repositories` | Fetch the first page of repositories visible to the authenticated viewer with pageInfo for follow-up cursor pagination. | request | — |\n| `repository-issues` | Fetch issues for an owner/repo pair with labels, assignees, and cursor metadata. | request | — |\n| `repository-pull-requests` | Fetch recent pull requests with review status signals and cursor metadata. | request | — |\n| `search-repositories` | Run a GitHub GraphQL search query and return repository nodes plus rate-limit cost. | request | — |\n| `user-project-items` | Read every item and up to 20 Text and SingleSelect field values per item from a user-owned ProjectV2 with checked cursor pagination. | request | — |\n| `viewer` | Fetch the authenticated viewer and current GraphQL rate-limit state. | request | — |\n\n### Google Analytics 4 (`google-analytics`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `realtime-active-users` | Reads the realtime report: active users in the last 30 minutes per country. | request | — |\n| `run-report` | Runs one GA4 report with the core totals (active users, sessions, page views, key events) for the given date range. | request | — |\n| `top-pages` | Returns the pages with the most page views in the date range, ordered by views. | request | — |\n| `traffic-sources` | Returns the traffic sources that brought the most sessions in the date range. | request | — |\n\n### HubSpot (`hubspot`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-contact` | POST a new contact with email + firstname + lastname properties. | request | — |\n| `get-contact` | Fetch a single contact record. | request | — |\n| `list-companies` | Page through CRM companies. | request | — |\n| `list-contacts` | Page through CRM contacts with cursor pagination. | request | — |\n| `list-deals` | Page through CRM deals with stage + amount surfaced. | request | — |\n| `list-owners` | Enumerate CRM owners (users assigned to records). | request | — |\n| `list-pipelines` | Enumerate deal pipelines and their stages. | request | — |\n| `list-properties-contacts` | Return every property defined on the contact object — useful for property discovery before authoring. | request | — |\n| `list-tickets` | Page through CRM tickets. | request | — |\n| `postmortem-due-in-n-days-via-state` | Schedule + State multi-day lifecycle. | schedule | — |\n| `search-contacts-by-email` | Use the CRM search API to find contacts whose primary email matches. | request | — |\n\n### Intercom (`intercom`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-contact` | POST a new contact (role=user, email). | request | — |\n| `get-contact` | Fetch a single contact. | request | — |\n| `list-admins` | Enumerate admins. | request | — |\n| `list-contacts` | Search contacts ordered by created desc. | request | — |\n| `list-conversations` | Search conversations ordered by updated_at desc. | request | — |\n| `list-tags` | Enumerate tags in the workspace. | request | — |\n| `me` | Identity probe. | request | — |\n| `reply-to-conversation` | POST a reply (admin replies via assignee). | request | — |\n| `trial-nurture-day-1-3-7-14-via-state` | Replaces a multi-day in-flight wait with the canonical Schedule + State pattern. | schedule | — |\n\n### Jina Reader (`jina-reader`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `sec-filing-to-markdown` | Pattern for converting SEC filing HTML pages to markdown for downstream extraction. | request | — |\n| `url-to-markdown` | Fetch a web page through Jina Reader and return clean markdown. | request | — |\n\n### Jira (`jira`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-my-issues` | Fetch every issue assigned to the current user regardless of status. | request | — |\n| `list-open-issues` | Fetch issues assigned to the current user whose lifecycle is not Done, sorted by most recent update. | request | — |\n| `search-issues-by-jql` | Run an arbitrary JQL query against the Jira /search endpoint. | request | — |\n\n### Linear (`linear`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-issue` | Mutation to create an issue with a title. | request | — |\n| `get-issue` | Fetch one issue with its state + assignee. | request | — |\n| `list-cycles` | Enumerate cycles for a team. | request | — |\n| `list-issues` | First 50 open issues for a team, ordered by createdAt desc. | request | — |\n| `list-projects` | Enumerate projects with their progress. | request | — |\n| `list-teams` | Enumerate teams the user belongs to. | request | — |\n| `update-issue` | Mutation to update title / description / state. | request | — |\n| `viewer` | Identity probe via GraphQL `viewer { id email name }`. | request | — |\n\n### LinkedIn (`linkedin`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-post` | Publish a text post to the authenticated member's LinkedIn feed. | request | — |\n\n### Mailchimp (`mailchimp`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `add-member` | POST a subscriber. | request | — |\n| `campaign-report` | Engagement summary for a campaign. | request | — |\n| `list-audiences` | Enumerate audiences. | request | — |\n| `list-campaigns` | Page through campaigns. | request | — |\n| `list-members` | Page through members. | request | — |\n| `list-tags` | Enumerate tags. | request | — |\n| `ping` | Probe the API to validate the API key and data center suffix. | request | — |\n| `send-campaign` | Trigger send for a campaign id. | request | — |\n\n### Monday.com (`monday`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `complexity-probe` | Read the remaining complexity budget — useful before bulk operations. | request | — |\n| `create-item` | Add a new item to a board with column values. | request | — |\n| `get-board` | Fetch one board with its columns + first 100 items. | request | — |\n| `list-boards` | Page through accessible boards. | request | — |\n| `list-users` | Enumerate users. | request | — |\n| `list-workspaces` | Enumerate workspaces. | request | — |\n| `me` | Identity probe via GraphQL `me { id email name }`. | request | — |\n| `update-item-column` | Change a single column on an item. | request | — |\n\n### Notion (`notion`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-page` | Add a new row to a database with title + properties. | request | — |\n| `get-database` | Fetch one database's schema (properties + types). | request | — |\n| `get-page` | Fetch a single page record by id. | request | — |\n| `list-databases` | Enumerate databases the integration has access to. | request | — |\n| `list-page-children` | Page through the block tree under a page. | request | — |\n| `list-users` | Enumerate users in the workspace. | request | — |\n| `me` | Identity probe — useful before driving the API. | request | — |\n| `query-database` | Run a database query with filter + sort. | request | — |\n| `search` | Full-text search across pages + databases the integration sees. | request | — |\n| `update-page` | PATCH a page's properties block. | request | — |\n\n### OAuth2 Generic (`oauth2-generic`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `client-credentials-grant` | RFC 6749 §4.4 client_credentials grant. | request | — |\n| `device-code-flow` | First leg of the device-authorization grant for input-constrained devices (CLIs, TVs, IoT). | request | — |\n| `exchange-code-for-token` | RFC 6749 §4.1 authorization-code grant. | request | — |\n| `introspect-token` | Ask the authorization server whether a token is still active and what scopes / subject it represents. | request | — |\n| `refresh-access-token` | RFC 6749 §6 refresh-token grant. | request | — |\n| `revoke-token` | External write. | request | — |\n\n### OpenAI (`openai`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-embedding` | Create one text embedding for downstream semantic matching. | request | — |\n| `list-models` | List models available to the API key. | request | — |\n| `structured-extraction` | Extract people from text using a JSON schema response format. | request | — |\n\n### PostgreSQL (`postgres`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `active-connections` | pg_stat_activity snapshot — useful when investigating a stuck query or a connection storm. | request | — |\n| `atomic-debit-credit-double-entry` | Demonstrates RequestStep.sql.also — both the debit and credit run inside one transaction; either both commit or both roll back. | request | — |\n| `describe-table` | Return column name, data type, nullability, and default for a given table. | request | — |\n| `export-large-table-stream` | Demonstrates RequestStep.sql.cursor — instead of buffering the full result set in memory, the driver streams rows in batches of 1000 via a server-side cursor. | request | — |\n| `list-indexes` | Return index name, columns, and uniqueness for a target table. | request | — |\n| `list-schemas` | Enumerate non-system schemas. | request | — |\n| `list-tables` | List every table in the `public` schema with row-count estimates from pg_class. | request | — |\n| `recent-rows` | ORDER BY a timestamp column (default `created_at`) DESC LIMIT N. | request | — |\n| `row-count` | SELECT COUNT(*) for the supplied table. | request | — |\n| `table-bytes` | Use pg_total_relation_size to rank tables. | request | — |\n| `update-must-affect-exactly-one-row` | Demonstrates RequestStep.expected_row_count — UPDATE that affects more or fewer than one row triggers `expected_row_count_mismatch` and rolls back. | request | — |\n\n### SendGrid (`sendgrid`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-list` | POST a new marketing list. | request | — |\n| `get-template` | Fetch one template (versions + active). | request | — |\n| `list-contacts` | Page through marketing contacts. | request | — |\n| `list-stats` | Aggregated stats for the last 7 days. | request | — |\n| `list-suppressions` | Enumerate the bounce suppression list. | request | — |\n| `list-templates` | Page through dynamic templates. | request | — |\n| `send-from-template` | Send transactional mail using a dynamic template id and substitution data. | request | — |\n| `send-mail` | POST /v3/mail/send with from + to + subject + content. | request | — |\n\n### Shopify (`shopify`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `list-customers` | Page through customers. | request | — |\n| `list-orders` | Page through open orders. | request | — |\n| `list-products` | Page through products in the catalog. | request | — |\n| `shop-info` | Smoke probe — fetches store metadata. | request | — |\n\n### Slack (`slack`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `add-reaction` | Star/+1/etc — react to a message. | request | — |\n| `auth-test` | Validate the bot token. | request | — |\n| `channel-history` | Fetch recent messages from a channel. | request | — |\n| `create-channel` | Provision a new channel. | request | — |\n| `invite-user` | Add users to a channel. | request | — |\n| `list-channels` | Page through public channels with cursor pagination. | request | — |\n| `list-users` | Enumerate workspace members. | request | — |\n| `post-message` | Send a chat.postMessage to a channel id. | request | — |\n| `post-then-pause-then-edit` | Demonstrates WaitStep (short, in-process, duration_ms ≤ 6h). | request | — |\n| `team-info` | Workspace metadata (name, domain, enterprise). | request | — |\n| `upload-file` | Upload an attachment to a channel via files.upload. | request | — |\n\n### Square (`square`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `create-customer` | POST a new customer with given_name + email. | request | — |\n| `inventory-counts` | Fetch real-time inventory counts. | request | — |\n| `list-catalog-items` | Page through catalog items (ITEM type). | request | — |\n| `list-customers` | Page through customers. | request | — |\n| `list-locations` | Smoke probe — every Square workflow starts with a location id. | request | — |\n| `list-orders` | POST /orders/search with a location filter. | request | — |\n| `list-payments` | Page through Payments. | request | — |\n| `list-team-members` | Search team members at a location. | request | — |\n| `merchant-info` | Fetch merchant metadata. | request | — |\n| `refund-payment` | POST /refunds with payment_id + amount + currency. | request | — |\n\n### Stripe (`stripe`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `charge-or-refund-by-amount` | Demonstrates BranchStep — when amount > 0, capture a charge against the customer; when amount < 0, issue a refund of the absolute value against the most recent charge. | request | — |\n| `create-customer` | POST a new customer record. | request | — |\n| `create-customer-idempotent` | Demonstrates RequestStep.idempotency_key — the workflow can re-run with the same email and Stripe will return the original customer instead of creating a duplicate. | request | — |\n| `create-payment-intent` | POST a new payment intent. | request | — |\n| `daily-charges-digest` | Pull yesterday's charges every business day at 08:00 Europe/Berlin and summarise total volume + count by currency. | schedule | — |\n| `get-charge` | Fetch a single charge record by its Stripe id. | request | — |\n| `get-customer` | Fetch a single customer record by its Stripe id. | request | — |\n| `incremental-charges-via-state` | Canonical AI-authoring few-shot for the multi-day lifecycle pattern: a daily schedule wakes the workflow, `state_read` pulls the last-synced cursor (`null` on the first run via `default_value`), the request lists only newer charges, and `state_write` advances the watermark in the same transaction as the step result. | schedule | — |\n| `list-balance-transactions` | Page through Stripe balance transactions for finance reporting. | request | — |\n| `list-charges` | Page through charges, surfacing id + amount + currency + status. | request | — |\n| `list-charges-validate-no-zero-amount` | Demonstrates WorkflowDef.validation_function — a QuickJS expression evaluated against the final output. | request | — |\n| `list-customers` | Page through the most recent customers, returning id + email + created timestamp. | request | — |\n| `list-invoices` | Page through invoices, surfacing id + status + amount_due + customer. | request | — |\n| `list-payment-intents` | Page through payment intents with cursor pagination. | request | — |\n| `list-prices` | List prices, optionally scoped to one product id. | request | — |\n| `list-products` | Page through Stripe products. | request | — |\n| `list-subscriptions` | List subscriptions, defaulting to active status. | request | — |\n| `new-customer-enrich-notify` | Three-connector reference recipe. | request | `undefined`, `undefined`, `undefined` |\n| `on-charge-failed-notify-slack` | Webhook-triggered: when Stripe fires `charge.failed` against the workflow's inbound URL, this recipe verifies the Stripe signature, extracts the failed-charge fields (id, amount, currency, decline reason, customer email), and posts a redacted alert into the operator's chosen Slack channel. | webhook | `undefined` |\n\n### Twilio (`twilio`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `account-balance` | Fetch account balance + currency. | request | — |\n| `get-message` | Fetch a message record. | request | — |\n| `list-calls` | Recent voice call records. | request | — |\n| `list-messages` | Page through Messages.json. | request | — |\n| `list-numbers` | Enumerate purchased numbers. | request | — |\n| `send-sms` | POST a message via Messages.json — pass From + To + Body. | request | — |\n| `send-whatsapp` | Send via the WhatsApp From channel — From and To prefixed with `whatsapp:`. | request | — |\n| `verify-phone-lookup` | Use the Lookup API to validate a phone number. | request | — |\n\n### Vercel (`vercel`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-deployment` | Fetch one deployment by id or URL. | request | — |\n| `list-deployments` | List recent deployments, optionally scoped by project. | request | — |\n| `list-projects` | List projects visible to the token. | request | — |\n\n### Web Scraper (`web-scraper`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `crawl-sitemap-to-markdown` | Fetch a site's sitemap.xml, loop over its <loc> entries, extract the main article of each page via Readability, and return an array of { title, url, markdown } envelopes. | request | — |\n| `extract-main-content` | GET a URL, run Mozilla Readability to isolate the article, then convert to markdown. | request | — |\n| `fetch-url-as-markdown` | GET a single public URL and convert its HTML body to markdown. | request | — |\n\n### Xray Cloud (GraphQL) (`xray-cloud`)\n\n| Recipe | What it does | Trigger | Also uses |\n| ------ | ------------ | ------- | --------- |\n| `get-test-by-issue-id` | Fetch a single Xray test entity by its Jira issue ID. | request | — |\n| `introspect-schema` | Run a standard GraphQL introspection query to verify the credential and enumerate available types. | request | — |"
        }
      }
    },
    {
      "slug": "license",
      "llms_path": "setup.md",
      "audience": "public",
      "section": "reference",
      "order": 4,
      "generated": false,
      "locales": {
        "en": {
          "title": "License",
          "summary": "Learn under which license you may use and share SubKit.",
          "headings": [
            {
              "depth": 2,
              "text": "License",
              "anchor": "license"
            },
            {
              "depth": 2,
              "text": "Third-party components",
              "anchor": "third-party-components"
            }
          ],
          "images": [],
          "sha256": "5ad9c7c67f8000397b830cced7a79d3256b0b3d47c28254a689e4691c0195ad9",
          "body": "## License\n\nMIT\n\n\n## Third-party components\n\nEvery release ships `THIRD_PARTY_NOTICES.txt` next to the binaries. It lists the license\ntexts of all bundled packages, the embedded embedding model and the Bun runtime.\n\n- **Embedding model:** `paraphrase-multilingual-MiniLM-L12-v2` by sentence-transformers,\n  Apache-2.0 per the upstream Hugging Face model card; ONNX conversion by Xenova.\n- **Bun runtime:** the `engine` and `sk` executables contain the Bun runtime, which statically\n  links LGPL components (JavaScriptCore/WebKit, tinycc). The section \"Relinking and\n  corresponding source\" in `THIRD_PARTY_NOTICES.txt` explains how to rebuild and relink.\n- **Container image:** `/usr/local/share/subkit/` also holds `BASE_IMAGE_INVENTORY.txt`\n  (operating system packages of the base image; the image contains no browser) and `SOURCE_OFFER.txt`.\n\nThe corresponding source of the GPL and LGPL components is available on request for at least\nthree years (written offer in the notices). Request it through the [contact form](https://subkit.mikebild.dev/kontakt). Once the SubKit repository is public, it will also\nbe linked there."
        },
        "de": {
          "title": "Lizenz",
          "summary": "Erfahre, unter welcher Lizenz du SubKit nutzen und weitergeben darfst.",
          "headings": [
            {
              "depth": 2,
              "text": "Lizenz",
              "anchor": "lizenz"
            },
            {
              "depth": 2,
              "text": "Drittanbieter-Komponenten",
              "anchor": "drittanbieter-komponenten"
            }
          ],
          "images": [],
          "sha256": "93c821dc6d55b761bdedfc06bc11dc595080473b20de70e85aca0240fb58d386",
          "body": "## Lizenz\n\nMIT\n\n\n## Drittanbieter-Komponenten\n\nJedes Release liefert `THIRD_PARTY_NOTICES.txt` neben den Binaries aus. Die Datei enthält die\nLizenztexte aller gebündelten Pakete, des eingebetteten Embedding-Modells und der Bun-Runtime.\n\n- **Embedding-Modell:** `paraphrase-multilingual-MiniLM-L12-v2` von sentence-transformers,\n  Apache-2.0 laut Hugging-Face-Model-Card; ONNX-Konvertierung von Xenova.\n- **Bun-Runtime:** Die Programme `engine` und `sk` enthalten die Bun-Runtime. Sie bindet\n  LGPL-Komponenten statisch ein (JavaScriptCore/WebKit, tinycc). Der Abschnitt „Relinking and\n  corresponding source“ in `THIRD_PARTY_NOTICES.txt` beschreibt Neubau und Relinking.\n- **Container-Image:** In `/usr/local/share/subkit/` liegen zusätzlich `BASE_IMAGE_INVENTORY.txt`\n  (Betriebssystempakete des Basis-Images; das Image enthält keinen Browser) und `SOURCE_OFFER.txt`.\n\nDen Quellcode der GPL- und LGPL-Komponenten erhältst du auf Anfrage für mindestens drei Jahre\n(schriftliches Angebot in den Notices). Anfragen gehen über das [Kontaktformular](https://subkit.mikebild.dev/kontakt). Sobald das SubKit-Repository öffentlich ist, wird er\nzusätzlich dort verlinkt."
        }
      }
    }
  ]
};
