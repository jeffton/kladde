import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";
import { readableMarkdown } from "./markdown-source";

const manager = new MarkdownManager({ extensions: [StarterKit] });

describe("readable Markdown source", () => {
  it.each([
    ["a &gt; b &amp; c &lt; d &quot;ok&quot;", 'a > b & c < d "ok"'],
    ["&gt; not a quote\r\n\r\na &gt; b\r\n", "\\> not a quote\r\n\r\na > b\r\n"],
    ["> a &gt; b\n> c &gt; d\n\n- e &gt; f", "> a > b\n> c > d\n\n- e > f"],
    ["| a &gt; b |\n|---|\n| c &gt; d |", "| a > b |\n|---|\n| c > d |"],
    ["[a &gt; b](https://example.com/?a=1&amp;b=2)", "[a > b](https://example.com/?a=1&amp;b=2)"],
    [
      "a &gt; b and `&gt;`, &amp;gt;, &lt;https://example.com&gt;",
      "a > b and `&gt;`, &amp;gt;, &lt;https://example.com&gt;",
    ],
    ["a &gt; b\n\n```html\n&amp; &gt;\n```", "a > b\n\n```html\n&amp; &gt;\n```"],
    ['a &gt; b\n\n<span title="&gt;">&gt;</span>', 'a > b\n\n<span title="&gt;">&gt;</span>'],
  ])("keeps Markdown meaning: %s", (original, expected) => {
    const readable = readableMarkdown(original, manager);
    expect(readable).toBe(expected);
    expect(manager.instance.parse(readable)).toBe(manager.instance.parse(original));
    expect(readableMarkdown(readable, manager)).toBe(readable);
  });
});
