import { startTelegramLeader } from "./leader.js";
import { errorMessage, telegramLog } from "./log.js";

/**
 * Standalone Nerdr Telegram daemon.
 *
 * Runs independently of OpenCode and VSCodium. The VSCodium extension deploys
 * this bundle and starts/stops the process; there is no system service and no
 * automatic restart after a reboot.
 */
const leader = startTelegramLeader({
  managedBy: "daemon",
  onShutdown: () => {
    process.exit(0);
  },
});

process.title = "nerdr-telegram";
telegramLog(`Nerdr Telegram daemon started (pid ${process.pid})`);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  telegramLog(`Nerdr Telegram daemon stopping (${signal})`);
  try {
    await leader.stop();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  telegramLog(`daemon uncaught exception: ${errorMessage(error)}`);
});
process.on("unhandledRejection", (error) => {
  telegramLog(`daemon unhandled rejection: ${errorMessage(error)}`);
});
