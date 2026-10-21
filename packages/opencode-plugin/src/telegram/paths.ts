import * as os from "node:os";
import * as path from "node:path";
import {
  BRIDGE_DIRNAME,
  TELEGRAM_CONFIG_FILE,
  TELEGRAM_LOG_FILE,
  TELEGRAM_STATE_FILE,
} from "@nerdr/protocol";

/** Resolve Nerdr's state directory, honoring NERDR_HOME for isolated tests. */
export function nerdrHome(): string {
  return process.env.NERDR_HOME || path.join(os.homedir(), BRIDGE_DIRNAME);
}

export function telegramConfigPath(): string {
  return path.join(nerdrHome(), TELEGRAM_CONFIG_FILE);
}

export function telegramStatePath(): string {
  return path.join(nerdrHome(), TELEGRAM_STATE_FILE);
}

export function telegramLogPath(): string {
  return path.join(nerdrHome(), TELEGRAM_LOG_FILE);
}
