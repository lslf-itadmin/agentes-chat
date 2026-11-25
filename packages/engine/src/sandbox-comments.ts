import { type ContentBlock, textOf } from "@agenteschat/providers";

/**
 * Comments between sandbox steps. An endpoint whose provider runs its own tools inside one call (Anthropic's
 * `server_tool_use` with its `*_tool_result`, such as the code sandbox or web search) answers with those blocks in
 * order between its text. The Anthropic adapter keeps them as `opaque` blocks (`fromContentBlock` in
 * `packages/providers/src/anthropic.ts`), so the text written before and after each step can be told apart here. A
 * Chat Completions endpoint answers with one text and no such blocks: nothing to split there.
 */

/** Whether a reply's block is a step the provider ran itself: its call or its result. */
export function isServerToolBlock(block: ContentBlock): boolean {
  if (block.type !== "opaque") return false;
  const kind = block.data.type;
  if (typeof kind !== "string") return false;
  return kind === "server_tool_use" || kind === "mcp_tool_use" || kind.endsWith("_tool_result");
}

/**
 * A reply's text split at its last step the provider ran itself: `before` is what it wrote up to and between those
 * steps, `after` what it wrote after the last one. Null when the reply holds no such step (nothing to split).
 */
export function splitAtServerTools(content: ContentBlock[]): { before: string; after: string } | null {
  let last = -1;
  content.forEach((b, i) => {
    if (isServerToolBlock(b)) last = i;
  });
  if (last < 0) return null;
  return { before: textOf(content.slice(0, last)).trim(), after: textOf(content.slice(last + 1)).trim() };
}

/**
 * The text of a reply as it may be posted. `activity`: only what came after the last step the provider ran itself;
 * the text before is activity, like narration before Agentes' own tool calls. `post` (the default): all of it.
 */
export function postableText(content: string | ContentBlock[], mode: "post" | "activity"): string {
  const split = mode === "activity" && typeof content !== "string" ? splitAtServerTools(content) : null;
  return split ? split.after : textOf(content);
}
