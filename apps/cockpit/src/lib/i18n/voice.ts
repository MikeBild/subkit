export const voiceEn = {
  "voice.start": "Dictate",
  "voice.start.shortcut": "Dictate ({shortcut})",
  "voice.stop": "Stop and insert text",
  "voice.cancel": "Discard recording",
  "voice.listening": "Listening",
  "voice.transcribing": "Writing it down…",
  "voice.preparing": "Loading the speech model…",
  "voice.prepare": "Load speech model",
  "voice.prepare.hint": "Dictation runs on this server once its speech model ({size}) is loaded.",
  "voice.error.permission_denied":
    "The microphone is blocked. Allow it for SubKit in your browser or system settings.",
  "voice.error.no_microphone": "No microphone found.",
  "voice.error.microphone_busy": "Another app is using the microphone.",
  "voice.error.unsupported": "This browser cannot record audio.",
  "voice.error.no_speech": "Nothing was heard. Try again a bit closer to the microphone.",
  "voice.error.speech_unavailable": "Dictation is not available in this workspace.",
  "voice.error.preparing": "The speech model is still loading. Try again in a moment.",
  "voice.error.failed": "The recording could not be turned into text. Try again.",
  "voice.dismiss": "Dismiss",
} as const;

export const voiceDe: Record<keyof typeof voiceEn, string> = {
  "voice.start": "Diktieren",
  "voice.start.shortcut": "Diktieren ({shortcut})",
  "voice.stop": "Stoppen und Text einfügen",
  "voice.cancel": "Aufnahme verwerfen",
  "voice.listening": "Hört zu",
  "voice.transcribing": "Schreibt mit…",
  "voice.preparing": "Sprachmodell wird geladen…",
  "voice.prepare": "Sprachmodell laden",
  "voice.prepare.hint":
    "Diktieren läuft auf diesem Server, sobald sein Sprachmodell ({size}) geladen ist.",
  "voice.error.permission_denied":
    "Das Mikrofon ist gesperrt. Erlaube es für SubKit in den Browser- oder Systemeinstellungen.",
  "voice.error.no_microphone": "Kein Mikrofon gefunden.",
  "voice.error.microphone_busy": "Eine andere App nutzt gerade das Mikrofon.",
  "voice.error.unsupported": "Dieser Browser kann keinen Ton aufnehmen.",
  "voice.error.no_speech": "Es war nichts zu hören. Versuch es etwas näher am Mikrofon.",
  "voice.error.speech_unavailable": "Diktieren ist in diesem Workspace nicht verfügbar.",
  "voice.error.preparing": "Das Sprachmodell lädt noch. Versuch es gleich noch einmal.",
  "voice.error.failed": "Die Aufnahme ließ sich nicht in Text umwandeln. Versuch es noch einmal.",
  "voice.dismiss": "Schließen",
};
