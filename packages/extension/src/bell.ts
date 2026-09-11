import { exec } from "node:child_process";

/** Platform-appropriate shell command that plays a short attention tone. */
export function defaultBellCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "afplay /System/Library/Sounds/Glass.aiff";
    case "win32":
      return 'powershell -NoProfile -Command "[console]::beep(880,250)"';
    default:
      return "paplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null || printf '\\a'";
  }
}

/** Best-effort fire-and-forget bell. Never throws. */
export function playBell(command: string, log: (message: string) => void): void {
  const finalCommand = command.trim() || defaultBellCommand();
  try {
    const child = exec(finalCommand, { timeout: 5000 }, (error) => {
      if (error) log(`bell command failed: ${error.message}`);
    });
    child.on("error", (error) => log(`bell command failed: ${error.message}`));
  } catch (error) {
    log(`bell command threw: ${String(error)}`);
  }
}
