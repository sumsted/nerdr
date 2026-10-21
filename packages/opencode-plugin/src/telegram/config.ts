import * as fs from "node:fs";
import { normalizeTelegramConfig, type TelegramConfig } from "@nerdr/protocol";
import { telegramConfigPath } from "./paths.js";
import { errorMessage, telegramLog } from "./log.js";

/** Read and validate ~/.nerdr/telegram.json. */
export function loadTelegramConfig(): TelegramConfig | undefined {
  const file = telegramConfigPath();
  try {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) {
      telegramLog(`${file} is readable by other users; run chmod 600`);
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const config = normalizeTelegramConfig(raw);
    if (!config) telegramLog(`${file} has no bot token`);
    return config;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") telegramLog(`cannot read ${file}: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Watch the config file for changes. `fs.watchFile` also reports file creation
 * and deletion, which is what the configure/disable commands need.
 */
export function watchTelegramConfig(onChange: () => void): () => void {
  const file = telegramConfigPath();
  let timer: NodeJS.Timeout | undefined;
  const listener = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, 250);
    timer.unref?.();
  };
  fs.watchFile(file, { interval: 3000 }, listener);
  return () => {
    if (timer) clearTimeout(timer);
    fs.unwatchFile(file, listener);
  };
}
