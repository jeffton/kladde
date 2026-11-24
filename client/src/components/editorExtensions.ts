import type { Slice } from "@tiptap/pm/model";
import type {
  JSONContent,
  MarkdownParseHelpers,
  MarkdownRendererHelpers,
  MarkdownToken,
} from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Link from "@tiptap/extension-link";
import CodeBlock from "@tiptap/extension-code-block";
import Strike from "@tiptap/extension-strike";
import Paragraph from "@tiptap/extension-paragraph";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";

// Preserve empty paragraphs through markdown round-trip using a literal nbsp.
const NBSP = "\u00A0";
const EMPTY_PARAGRAPH_HTML_ENTITY = "&nbsp;";

const PreservingParagraph = Paragraph.extend({
  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    const tokens = token.tokens || [];

    if (tokens.length === 1 && tokens[0].type === "image") {
      return helpers.parseChildren([tokens[0]]);
    }

    const content = helpers.parseInline(tokens);

    if (
      content.length === 1 &&
      content[0].type === "text" &&
      (content[0].text === EMPTY_PARAGRAPH_HTML_ENTITY || content[0].text === NBSP)
    ) {
      return helpers.createNode("paragraph", undefined, []);
    }

    return helpers.createNode("paragraph", undefined, content);
  },
  renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => {
    const content = Array.isArray(node.content) ? node.content : [];

    if (content.length === 0) {
      return NBSP;
    }

    return helpers.renderChildren(content);
  },
});
// Task item extension without forced focus on checkbox toggle.
// The upstream extension calls chain().focus() on change, which triggers
// virtual keyboard popup on touch devices when editor is currently blurred.
const FocusSafeTaskItem = TaskItem.extend({
  addNodeView() {
    return ({ node, HTMLAttributes, getPos, editor }) => {
      const listItem = document.createElement("li");
      const checkboxWrapper = document.createElement("label");
      const checkboxStyler = document.createElement("span");
      const checkbox = document.createElement("input");
      const content = document.createElement("div");

      const updateA11Y = () => {
        checkbox.ariaLabel =
          this.options.a11y?.checkboxLabel?.(node, checkbox.checked) ||
          `Task item checkbox for ${node.textContent || "empty task item"}`;
      };

      updateA11Y();

      checkboxWrapper.contentEditable = "false";
      checkbox.type = "checkbox";
      checkbox.addEventListener("mousedown", (event) => event.preventDefault());
      checkbox.addEventListener("change", (event) => {
        if (!editor.isEditable && !this.options.onReadOnlyChecked) {
          checkbox.checked = !checkbox.checked;
          return;
        }

        const { checked } = event.target as HTMLInputElement;

        if (editor.isEditable && typeof getPos === "function") {
          editor
            .chain()
            .command(({ tr }) => {
              const position = getPos();

              if (typeof position !== "number") {
                return false;
              }

              const currentNode = tr.doc.nodeAt(position);

              tr.setNodeMarkup(position, undefined, {
                ...currentNode?.attrs,
                checked,
              });

              return true;
            })
            .run();
        }

        if (!editor.isEditable && this.options.onReadOnlyChecked) {
          if (!this.options.onReadOnlyChecked(node, checked)) {
            checkbox.checked = !checkbox.checked;
          }
        }
      });

      Object.entries(this.options.HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });

      listItem.dataset.checked = String(node.attrs.checked);
      checkbox.checked = Boolean(node.attrs.checked);

      checkboxWrapper.append(checkbox, checkboxStyler);
      listItem.append(checkboxWrapper, content);

      Object.entries(HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });

      return {
        dom: listItem,
        contentDOM: content,
        update: (updatedNode) => {
          if (updatedNode.type !== this.type) {
            return false;
          }

          listItem.dataset.checked = String(updatedNode.attrs.checked);
          checkbox.checked = Boolean(updatedNode.attrs.checked);
          updateA11Y();

          return true;
        },
      };
    };
  },
});

export function createEditorExtensions() {
  return [
    StarterKit.configure({ strike: false, codeBlock: false, paragraph: false, link: false }),
    PreservingParagraph,
    Strike,
    CodeBlock,
    TaskList,
    FocusSafeTaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Link.configure({
      autolink: true,
      openOnClick: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
    }),
    Markdown.configure(),
  ];
}

export function serializeClipboardText(slice: Slice) {
  const text = slice.content.textBetween(0, slice.content.size, "\n\n");
  return text.replaceAll(NBSP, "");
}
