// Languages offered for meeting transcription.
// code   = Whisper language code (what the recording transcriber uses)
// speech = BCP-47 tag for the browser's live speech recognition
// "auto" = detect the language from the recording (Whisper language detection)

export const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";
export const AUTO_LANGUAGE = "auto";

export const TRANSCRIPTION_LANGUAGES = [
  { code: "en", name: "English", speech: "en-IN" },
  { code: "ta", name: "Tamil", speech: "ta-IN" },
  { code: "hi", name: "Hindi", speech: "hi-IN" },
  { code: "te", name: "Telugu", speech: "te-IN" },
  { code: "ml", name: "Malayalam", speech: "ml-IN" },
  { code: "kn", name: "Kannada", speech: "kn-IN" },
  { code: "mr", name: "Marathi", speech: "mr-IN" },
  { code: "bn", name: "Bengali", speech: "bn-IN" },
  { code: "gu", name: "Gujarati", speech: "gu-IN" },
  { code: "pa", name: "Punjabi", speech: "pa-IN" },
  { code: "ur", name: "Urdu", speech: "ur-IN" },
  { code: "ne", name: "Nepali", speech: "ne-NP" },
  { code: "si", name: "Sinhala", speech: "si-LK" },
  { code: "ar", name: "Arabic", speech: "ar-SA" },
  { code: "zh", name: "Chinese", speech: "zh-CN" },
  { code: "ja", name: "Japanese", speech: "ja-JP" },
  { code: "ko", name: "Korean", speech: "ko-KR" },
  { code: "fr", name: "French", speech: "fr-FR" },
  { code: "de", name: "German", speech: "de-DE" },
  { code: "es", name: "Spanish", speech: "es-ES" },
  { code: "pt", name: "Portuguese", speech: "pt-PT" },
  { code: "it", name: "Italian", speech: "it-IT" },
  { code: "nl", name: "Dutch", speech: "nl-NL" },
  { code: "ru", name: "Russian", speech: "ru-RU" },
  { code: "tr", name: "Turkish", speech: "tr-TR" },
  { code: "id", name: "Indonesian", speech: "id-ID" },
  { code: "ms", name: "Malay", speech: "ms-MY" },
  { code: "th", name: "Thai", speech: "th-TH" },
  { code: "vi", name: "Vietnamese", speech: "vi-VN" },
];

const CODES = new Set([AUTO_LANGUAGE, ...TRANSCRIPTION_LANGUAGES.map((l) => l.code)]);

export const isTranscriptionLanguage = (code) => CODES.has(String(code || ""));

export const languageName = (code) =>
  code === AUTO_LANGUAGE ? "Auto-detect" : TRANSCRIPTION_LANGUAGES.find((l) => l.code === code)?.name || code || "";

// Accepts a code ("ta") or legacy WHISPER_LANGUAGE names ("tamil"); anything else → English
export const normalizeLanguage = (value) => {
  const v = String(value || "").trim().toLowerCase();
  if (CODES.has(v)) return v;
  return TRANSCRIPTION_LANGUAGES.find((l) => l.name.toLowerCase() === v)?.code || DEFAULT_TRANSCRIPTION_LANGUAGE;
};
