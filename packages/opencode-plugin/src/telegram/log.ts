import * as fs from "node:fs";
import * as path from "node:path";
import { telegramLogPath } from "./paths.js";

const MAX_LOG_BYTES = 1_000_000;

function redact(value: string): string {
  // Never leak bot tokens into the log file, even if an upstream error embeds
  // the request URL.
  return value.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "<telegram-token>");
}

/** Append a diagnostic line to ~/.nerdr/telegram.log. Best effort only. */
export function telegramLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${redact(message)}\n`;
  try {
    const file = telegramLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // Missing log is normal.
    }
    fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Logging must never break the bridge.
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
