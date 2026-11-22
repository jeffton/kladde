import type { MarkdownToken } from "@tiptap/core";
import type { MarkdownManager } from "@tiptap/markdown";

const entity = /&(gt|lt|amp|quot);/g;

// Only rewrite Markdown text, never code, link destinations, or raw HTML.
function readableText(raw: string, prefix: string): string {
  return raw.replace(entity, (match: string, name: string, offset: number) => {
    const before = raw.slice(0, offset);
    const after = raw.slice(offset + match.length);
    if (name === "gt") {
      if (/(?:<|&lt;)\S*$/.test(prefix + before)) return match;
      return /(?:^|\n)[ \t]*$/.test(prefix + before) ? "\\>" : ">";
    }
    if (name === "lt") return /^\s/.test(after) ? "<" : match;
    if (name === "quot") return '"';
    // The encoded ampersand may protect intentionally literal entity text.
    return /^(?:#[xX]?[\da-fA-F]+|[a-zA-Z][\da-zA-Z]*);/.test(after) ? match : "&";
  });
}

function rewriteTokens(source: string, tokens: MarkdownToken[]): string {
  // Tiptap can parse an entire inline HTML span together, including its text.
  if (tokens.some((token) => token.type === "html" && !token.block)) return source;
  let cursor = 0;
  let result = "";
  for (const token of tokens) {
    const raw = token.raw;
    if (!raw) continue;
    const offset = source.indexOf(raw, cursor);
    // Some Markdown constructs strip prefixes/indentation from nested tokens.
    if (offset === -1) continue;
    result += source.slice(cursor, offset);
    if (token.type === "text" && !token.tokens) {
      result += readableText(raw, source.slice(0, offset));
    } else if (token.type === "list") {
      result += rewriteTokens(raw, token.items ?? []);
    } else if (token.type === "blockquote" && token.tokens) {
      const lines = raw.split("\n");
      const prefixes = lines.map((line) => line.match(/^ {0,3}>[ \t]?/)?.[0] ?? "");
      const body = lines.map((line, index) => line.slice(prefixes[index].length)).join("\n");
      result += rewriteTokens(body, token.tokens)
        .split("\n")
        .map((line, index) => prefixes[index] + line)
        .join("\n");
    } else if (token.type === "table") {
      const cells: MarkdownToken[] = [...token.header, ...token.rows.flat()];
      result += rewriteTokens(
        raw,
        cells.map((cell) => ({ ...cell, type: "text", raw: cell.text })),
      );
    } else if (
      token.tokens &&
      ["paragraph", "heading", "strong", "em", "del", "text", "link", "list_item"].includes(
        token.type ?? "",
      )
    ) {
      const start = token.text ? raw.indexOf(token.text) : -1;
      result +=
        start === -1
          ? rewriteTokens(raw, token.tokens)
          : raw.slice(0, start) +
            rewriteTokens(token.text!, token.tokens) +
            raw.slice(start + token.text!.length);
    } else {
      result += raw;
    }
    cursor = offset + raw.length;
  }
  return result + source.slice(cursor);
}

export function readableMarkdown(source: string, manager: MarkdownManager): string {
  if (!source.match(entity)) return source;
  const endings = source.match(/\r\n?|\n/g) ?? [];
  const normalized = source.replace(/\r\n?/g, "\n");
  const marked = manager.instance;
  // Tiptap adds lexer-only tokens (e.g. taskList) that Marked's HTML parser cannot render.
  const options = marked.getDefaults();
  const lex = (text: string) => new marked.Lexer(options).lex(text);
  const render = (tokens: ReturnType<typeof lex>) => marked.Parser.parse(tokens, options);
  const tokens = lex(normalized);
  const candidate = rewriteTokens(normalized, tokens);
  // Keep source unchanged if exposing punctuation would change the Markdown structure.
  if (candidate === normalized || render(tokens) !== render(lex(candidate))) return source;
  let index = 0;
  return candidate.replace(/\n/g, () => endings[index++]);
}
