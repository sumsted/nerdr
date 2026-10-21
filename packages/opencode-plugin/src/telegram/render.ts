import * as path from "node:path";
import type { TelegramInlineKeyboard, TelegramInlineButton } from "./telegramApi.js";
import type {
  TelegramFormValue,
  TelegramQuestionField,
  TelegramQuestionRef,
  TelegramSessionInfo,
} from "./state.js";
import type { OpencodePermission } from "./opencode.js";

const TELEGRAM_MAX_MESSAGE = 4096;
const SAFE_CHUNK = 3900;

export function agentName(info: Pick<TelegramSessionInfo, "id" | "title" | "directory">): string {
  const directory = info.directory?.replace(/[/\\]+$/, "");
  const base = directory ? path.basename(directory) : "";
  if (base && base !== "." && base !== "/") return base;
  return info.title.trim() || info.id;
}

export function agentLabel(info: TelegramSessionInfo): string {
  const name = agentName(info);
  const suffix = info.id.length > 8 ? info.id.slice(-6) : info.id;
  return `${name} · ${suffix}`;
}

export function clock(): string {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function statusWord(status: string | undefined): string {
  return status || "unknown";
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Split text into Telegram-safe messages without breaking surrogate pairs. */
export function chunkText(text: string, max = SAFE_CHUNK): string[] {
  const limit = Math.max(1, Math.min(max, TELEGRAM_MAX_MESSAGE - 100));
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    // Do not split a surrogate pair.
    if (cut > 0 && /[\uD800-\uDBFF]/.test(rest[cut - 1] ?? "")) cut -= 1;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function button(text: string, callbackData: string): TelegramInlineButton {
  return { text: truncate(text, 60), callback_data: callbackData };
}

export function renderHelp(botUsername?: string): string {
  const mention = botUsername ? `@${botUsername}` : "this bot";
  return [
    `Nerdr Telegram bridge`,
    ``,
    `Reply to any notification to send a prompt to that agent, or use:`,
    `/agents — list agents`,
    `/use <name|number|session> — select an agent`,
    `/status — show the active agent`,
    `/stop — interrupt the active agent`,
    `/help — this message`,
    ``,
    `Use ${mention} only in a private chat.`,
  ].join("\n");
}

export function renderAgents(
  entries: Array<{ info: TelegramSessionInfo; active: boolean }>,
): { text: string; keyboard?: TelegramInlineKeyboard } {
  if (entries.length === 0) {
    return { text: "No agents found. Start OpenCode in a VSCodium terminal first." };
  }
  const lines = ["Agents", ""];
  const buttons: TelegramInlineButton[][] = [];
  entries.forEach(({ info, active }, index) => {
    const marker = active ? "▶" : " ";
    lines.push(
      `${marker} ${index + 1}. ${agentName(info)} — ${statusWord(info.status)} (${info.id.slice(-6)})`,
    );
    buttons.push([button(`${index + 1}. ${agentName(info)}`, `use:${info.id}`)]);
  });
  lines.push("", "Tap an agent or use /use <number>.");
  return { text: lines.join("\n"), keyboard: { inline_keyboard: buttons } };
}

export function renderStatus(
  info: TelegramSessionInfo,
  pendingPermissions: number,
  pendingQuestions: number,
): string {
  const lines = [
    `Agent: ${agentName(info)}`,
    `Status: ${statusWord(info.status)}`,
    `Session: ${info.id}`,
  ];
  if (info.directory) lines.push(`Directory: ${info.directory}`);
  if (info.lastEvent) lines.push(`Last event: ${info.lastEvent}`);
  if (pendingPermissions) lines.push(`Pending permissions: ${pendingPermissions}`);
  if (pendingQuestions) lines.push(`Pending questions: ${pendingQuestions}`);
  return lines.join("\n");
}

export function renderWorking(info: TelegramSessionInfo): string {
  return `⏳ ${agentName(info)} is working at ${clock()}`;
}

export function renderDone(
  info: TelegramSessionInfo,
  text: string | undefined,
  maxChars: number,
): string {
  const prefix = `✅ ${agentName(info)} is done at ${clock()}`;
  const body = text?.trim();
  if (!body) return prefix;
  return `${prefix}\n\n${truncate(body, maxChars)}`;
}

export function renderError(info: TelegramSessionInfo, message?: string): string {
  const prefix = `❌ ${agentName(info)} errored at ${clock()}`;
  const detail = message?.trim();
  return detail ? `${prefix}\n\n${truncate(detail, 1500)}` : prefix;
}

export function renderInterrupted(info: TelegramSessionInfo): string {
  return `⏹ ${agentName(info)} was interrupted at ${clock()}`;
}

export function renderPermission(
  info: TelegramSessionInfo,
  request: OpencodePermission,
  token: string,
): { text: string; keyboard: TelegramInlineKeyboard } {
  const lines = [`🔐 ${agentName(info)} needs permission`, "", `Action: ${request.action}`];
  const resources = request.resources.filter(Boolean);
  if (resources.length > 0) {
    lines.push("", "Resources:");
    for (const resource of resources.slice(0, 8)) {
      lines.push(`• ${truncate(resource, 300)}`);
    }
    if (resources.length > 8) lines.push(`…and ${resources.length - 8} more`);
  }
  if (request.message) lines.push("", truncate(request.message, 600));
  lines.push("", "Allow this action?");
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [button("Allow once", `perm:${token}:once`)],
        [button("Always allow", `perm:${token}:always`)],
        [button("Deny", `perm:${token}:reject`)],
      ],
    },
  };
}

export function permissionResult(decision: "once" | "always" | "reject", message?: string): string {
  if (decision === "once") return "✅ Allowed once";
  if (decision === "always") return "✅ Always allowed";
  return message ? `❌ Denied: ${truncate(message, 300)}` : "❌ Denied";
}

function fieldTitle(field: TelegramQuestionField): string {
  return field.title.trim() || field.key;
}

function fieldAnswer(field: TelegramQuestionField, value: TelegramFormValue | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) {
    const labels = value.map((item) => {
      const option = field.options.find((candidate) => candidate.value === item);
      return option?.label ?? item;
    });
    return labels.join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const option = field.options.find((candidate) => candidate.value === String(value));
  return option?.label ?? String(value);
}

export function renderQuestion(
  info: TelegramSessionInfo,
  question: TelegramQuestionRef,
): { text: string; keyboard?: TelegramInlineKeyboard } {
  const field = question.fields[question.index];
  if (!field) {
    return { text: `❓ ${agentName(info)} is waiting for an answer.` };
  }
  const total = question.fields.length;
  const lines = [
    `❓ ${agentName(info)} asks (${question.index + 1}/${total})`,
    "",
    fieldTitle(field),
  ];
  if (field.description) lines.push(field.description);
  if (question.title) lines.push("", truncate(question.title, 500));

  const rows: TelegramInlineButton[][] = [];
  const selected = question.answers[field.key];

  if (field.type === "external") {
    const url = field.options[0]?.value;
    lines.push("", "This step must be completed in the browser.", url ?? "");
    const externalRows: TelegramInlineButton[][] = [];
    if (url) externalRows.push([{ text: "Open link", url }]);
    externalRows.push([button("Done", `q:${question.token}:skip`)]);
    return {
      text: lines.join("\n"),
      keyboard: { inline_keyboard: externalRows },
    };
  }

  if (field.type === "multiselect" || field.options.length > 0) {
    lines.push("");
    field.options.forEach((option, index) => {
      const current = Array.isArray(selected) ? selected : [];
      const isSelected = current.includes(option.value);
      const mark = field.type === "multiselect" ? (isSelected ? "☑" : "☐") : "•";
      lines.push(`${mark} ${option.label}${option.description ? ` — ${option.description}` : ""}`);
      rows.push([
        button(
          `${field.type === "multiselect" ? `${isSelected ? "☑" : "☐"} ` : ""}${option.label}`,
          `q:${question.token}:${index}`,
        ),
      ]);
    });
    if (field.type === "multiselect") {
      rows.push([button("Submit", `q:${question.token}:submit`)]);
    }
    if (field.custom) {
      rows.push([button("Other (type an answer)", `q:${question.token}:other`)]);
    }
    if (!field.required) {
      rows.push([button("Skip", `q:${question.token}:skip`)]);
    }
  } else if (field.type === "boolean") {
    lines.push("");
    rows.push([button("Yes", `q:${question.token}:0`)]);
    rows.push([button("No", `q:${question.token}:1`)]);
    if (!field.required) rows.push([button("Skip", `q:${question.token}:skip`)]);
  } else {
    lines.push("", "Reply to this message with your answer.");
    if (!field.required) rows.push([button("Skip", `q:${question.token}:skip`)]);
  }

  const answer = fieldAnswer(field, selected);
  if (answer) lines.push("", `Selected: ${answer}`);
  return {
    text: lines.join("\n"),
    keyboard: rows.length > 0 ? { inline_keyboard: rows } : undefined,
  };
}

export function renderQuestionAnswered(
  info: TelegramSessionInfo,
  question: TelegramQuestionRef,
): string {
  const lines = [`✅ ${agentName(info)} — questions answered`];
  for (const field of question.fields) {
    const answer = fieldAnswer(field, question.answers[field.key]);
    if (answer) lines.push(`${fieldTitle(field)}: ${answer}`);
  }
  return lines.join("\n");
}

export function callbacksForField(question: TelegramQuestionRef): TelegramInlineKeyboard | undefined {
  const field = question.fields[question.index];
  if (!field) return undefined;
  const rows: TelegramInlineButton[][] = [];
  if (field.type === "multiselect" || field.options.length > 0) {
    const selected = question.answers[field.key];
    const current = Array.isArray(selected) ? selected : [];
    field.options.forEach((option, index) => {
      const isSelected = current.includes(option.value);
      rows.push([
        button(
          `${field.type === "multiselect" ? `${isSelected ? "☑" : "☐"} ` : ""}${option.label}`,
          `q:${question.token}:${index}`,
        ),
      ]);
    });
    if (field.type === "multiselect") {
      rows.push([button("Submit", `q:${question.token}:submit`)]);
    }
    if (field.custom) rows.push([button("Other (type an answer)", `q:${question.token}:other`)]);
    if (!field.required) rows.push([button("Skip", `q:${question.token}:skip`)]);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

export function questionValue(
  field: TelegramQuestionField,
  index: number,
): TelegramFormValue | undefined {
  if (field.type === "boolean") return index === 0;
  const option = field.options[index];
  return option?.value;
}

export function externalQuestionUrl(field: TelegramQuestionField): string | undefined {
  return field.type === "external" ? field.options[0]?.value : undefined;
}
