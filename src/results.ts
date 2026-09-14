/**
 * MCP call results as Pi tool results.
 *
 * Text and images pass through. Embedded resources become labelled text. Oversized output is
 * truncated in place with the full text spilled to a file the model can `read`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
export type ContentBlock = TextBlock | ImageBlock;

export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2000;

export function convertContent(content: unknown[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const raw of content) {
    const c = raw as { type?: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string }; uri?: string; name?: string };
    switch (c?.type) {
      case "text":
        out.push({ type: "text", text: c.text ?? "" });
        break;
      case "image":
        out.push({ type: "image", data: c.data ?? "", mimeType: c.mimeType ?? "image/png" });
        break;
      case "resource": {
        const r = c.resource ?? {};
        if (typeof r.text === "string") out.push({ type: "text", text: `[Resource: ${r.uri ?? "unknown"}]\n${r.text}` });
        else out.push({ type: "text", text: `[Resource: ${r.uri ?? "unknown"}] (${r.mimeType ?? "binary"}, ${r.blob ? Math.round((r.blob.length * 3) / 4) : 0} bytes)` });
        break;
      }
      case "resource_link":
        out.push({ type: "text", text: `[Resource link: ${c.name ?? c.uri ?? "unknown"}]\nURI: ${c.uri ?? "(none)"}` });
        break;
      case "audio":
        out.push({ type: "text", text: `[Audio content: ${c.mimeType ?? "audio/*"}]` });
        break;
      default:
        out.push({ type: "text", text: JSON.stringify(raw) });
    }
  }
  return out;
}

export function stringifyStructured(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface GuardedResult {
  blocks: ContentBlock[];
  truncated: boolean;
  spillPath?: string;
}

/** Cap the text volume that reaches the model; spill the full text to disk when it is cut. */
export function guardOutput(blocks: ContentBlock[], label: string, spillDir = join(tmpdir(), "pid-mcp")): GuardedResult {
  const text = blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text.split("\n").length;
  if (bytes <= MAX_RESULT_BYTES && lines <= MAX_RESULT_LINES) return { blocks, truncated: false };
  let spillPath: string | undefined;
  try {
    mkdirSync(spillDir, { recursive: true });
    spillPath = join(spillDir, `${label.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}.txt`);
    writeFileSync(spillPath, text);
  } catch {
    spillPath = undefined;
  }
  const cutLines = text.split("\n").slice(0, MAX_RESULT_LINES);
  let cut = cutLines.join("\n");
  if (Buffer.byteLength(cut, "utf8") > MAX_RESULT_BYTES) cut = Buffer.from(cut, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
  const note = spillPath
    ? `\n\n[pid-mcp: output truncated (${bytes} bytes, ${lines} lines). Full output: ${spillPath}]`
    : `\n\n[pid-mcp: output truncated (${bytes} bytes, ${lines} lines)]`;
  const images = blocks.filter((b): b is ImageBlock => b.type === "image");
  return { blocks: [{ type: "text", text: cut + note }, ...images], truncated: true, spillPath };
}
