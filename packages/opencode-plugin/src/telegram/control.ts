import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { telegramControlTokenPath } from "./paths.js";
import { telegramLog } from "./log.js";

const TOKEN_BYTES = 32;

/**
 * Read the loopback control token, creating it with mode 0600 when missing.
 *
 * The token protects mutating control endpoints (`/reload`, `/test`,
 * `/shutdown`) from other local users. Read-only `/health` stays open so
 * diagnostics do not need the secret.
 */
export function ensureControlToken(): string {
  const file = telegramControlTokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Create it below.
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Best effort.
    }
    telegramLog("created Telegram control token");
  } catch {
    // A token that cannot be persisted is still usable for this process.
  }
  return token;
}

/** Compare a request token without leaking length or content via timing. */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
