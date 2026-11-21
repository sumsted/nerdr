/**
 * Convert the Markdown that OpenCode emits into the HTML subset Telegram
 * supports. Telegram's MarkdownV2 is a different dialect and rejects ordinary
 * text containing `_`, `[`, `~`, and friends, so HTML is the safer target.
 */

const ESCAPED_MARKDOWN = /\\([\\`*_{}\[\]()#+\-.!~>|])/g;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "tg:", "mailto:"]);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function safeUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return SAFE_PROTOCOLS.has(url.protocol) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format one line of inline Markdown. HTML is escaped before any tags are
 * inserted, so assistant text cannot inject attributes or elements.
 */
function formatInline(source: string): string {
  const stash: string[] = [];
  const hold = (value: string): string => `\u0000${stash.push(value) - 1}\u0000`;

  let text = source;

  // Backslash escapes become literal characters and are protected from later
  // emphasis processing.
  text = text.replace(ESCAPED_MARKDOWN, (_, char: string) => hold(escapeHtml(char)));

  // Inline code before anything else so its contents stay literal.
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) =>
    hold(`<code>${escapeHtml(code)}</code>`),
  );

  // Links: keep the URL intact, validate the scheme, then protect the result.
  text = text.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (match, label: string, url: string) => {
      const safe = safeUrl(url);
      if (!safe) return hold(escapeHtml(match));
      return hold(`<a href="${escapeAttribute(safe)}">${escapeHtml(label)}</a>`);
    },
  );

  text = escapeHtml(text);

  // Bold, strikethrough, then italic. Handle the common nested forms first so
  // `**bold *italic***` does not produce crossed tags.
  text = text.replace(/\*\*\*([^\n]+?)\*\*\*/g, "<b><i>$1</i></b>");
  text = text.replace(/\*\*([^\n]+?)\*\*\*/g, (_, inner: string) => {
    const body = `${inner}*`;
    const italic = body.replace(
      /(^|[^\w*])\*(?!\s)([^\n]+?)(?<!\s)\*(?![\w*])/g,
      "$1<i>$2</i>",
    );
    return `<b>${italic}</b>`;
  });
  text = text.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/(^|[^\w])__([^\n]+?)__(?!\w)/g, "$1<b>$2</b>");
  text = text.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");
  text = text.replace(
    /(^|[^\w*])\*(?!\s)([^\n]+?)(?<!\s)\*(?![\w*])/g,
    "$1<i>$2</i>",
  );
  text = text.replace(
    /(^|[^\w])_(?!\s)([^\n]+?)(?<!\s)_(?!\w)/g,
    "$1<i>$2</i>",
  );

  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => stash[Number(index)] ?? "");
}

function codeBlock(content: string[], language?: string): string {
  const body = escapeHtml(content.join("\n"));
  const cls = language ? ` class="language-${language}"` : "";
  return `<pre><code${cls}>${body}</code></pre>`;
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let fence: { open: string; close: string; language?: string; content: string[] } | undefined;
  let quote: string[] | undefined;

  const flushQuote = (): void => {
    if (!quote) return;
    output.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = undefined;
  };

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);

    if (fence) {
      const marker = fenceMatch?.[1] ?? "";
      if (marker && marker[0] === fence.close[0] && marker.length >= fence.close.length) {
        output.push(codeBlock(fence.content, fence.language));
        fence = undefined;
      } else {
        fence.content.push(line);
      }
      continue;
    }

    if (fenceMatch) {
      flushQuote();
      const marker = fenceMatch[1] ?? "```";
      const info = (fenceMatch[2] ?? "").trim().split(/\s+/)[0] ?? "";
      const language = /^[A-Za-z0-9_+-]+$/.test(info) ? info : undefined;
      fence = {
        open: line,
        close: marker,
        language,
        content: [],
      };
      continue;
    }

    const quoteMatch = /^\s*>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      if (!quote) quote = [];
      quote.push(formatInline(quoteMatch[1] ?? ""));
      continue;
    }
    flushQuote();

    const headingMatch = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      output.push(`<b>${formatInline(headingMatch[2] ?? "")}</b>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      output.push("──────────");
      continue;
    }

    const taskMatch = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (taskMatch) {
      const mark = (taskMatch[2] ?? "").toLowerCase() === "x" ? "☑" : "☐";
      output.push(`${taskMatch[1] ?? ""}${mark} ${formatInline(taskMatch[3] ?? "")}`);
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const rawMarker = listMatch[2] ?? "";
      const marker = /^\d/.test(rawMarker) ? rawMarker : "•";
      output.push(`${listMatch[1] ?? ""}${marker} ${formatInline(listMatch[3] ?? "")}`);
      continue;
    }

    output.push(formatInline(line));
  }

  if (fence) output.push(codeBlock(fence.content, fence.language));
  flushQuote();
  return output.join("\n");
}

/**
 * Split Markdown into chunks that are individually balanced around fenced code
 * blocks, so tags are never cut in half.
 */
export function chunkMarkdown(text: string, max = 3000): string[] {
  if (text.length <= max) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  let fenceOpen: string | undefined;
  let fenceClose: string | undefined;

  const flush = (): void => {
    if (current.length === 0) return;
    if (fenceOpen) current.push(fenceClose ?? "```");
    chunks.push(current.join("\n"));
    current = fenceOpen ? [fenceOpen] : [];
    length = current.length > 0 ? (current[0]?.length ?? 0) : 0;
  };

  for (const line of lines) {
    const add = (current.length > 0 ? 1 : 0) + line.length;
    if (length + add > max && current.length > 0) flush();

    current.push(line);
    length += (current.length > 1 ? 1 : 0) + line.length;

    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fenceOpen) {
        fenceOpen = undefined;
        fenceClose = undefined;
      } else {
        fenceOpen = line;
        fenceClose = fenceMatch[1];
      }
    }
  }

  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.filter((chunk) => chunk.length > 0);
}
