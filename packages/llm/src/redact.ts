/** Секрети лише з env; у логах/помилках/артефактах — ніколи. */
const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  /sk-[A-Za-z0-9_-]{12,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** значення, які треба знищити у тексті: реальні ключі з env + шаблони */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[REDACTED]");
  for (const re of KEY_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/** скільки збігів секрету у тексті (для тестів «0 збігів у логах/артефактах») */
export function countSecretHits(text: string, secrets: readonly string[]): number {
  let n = 0;
  for (const s of secrets) if (s) n += text.split(s).length - 1;
  return n;
}

export type LogSink = (line: string) => void;
export interface Logger { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void }

/** логер із обов'язковою редакцією; заголовки авторизації ніколи не логуються */
export function createLogger(sink: LogSink, secrets: readonly string[] = []): Logger {
  const w = (level: string, msg: string, data?: Record<string, unknown>) =>
    sink(redact(JSON.stringify({ level, msg, ...(data ?? {}) }), secrets));
  return { info: (m, d) => w("info", m, d), warn: (m, d) => w("warn", m, d) };
}
export const nullLogger: Logger = { info() {}, warn() {} };
