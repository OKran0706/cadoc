/**
 * Incremental Server-Sent-Events parser for fetch() streams (POST-capable, unlike EventSource).
 * Feed it decoded text chunks; it returns the complete events and the unfinished remainder.
 */
export function parseSseChunk(buffer: string): { data: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const data: string[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.replace(/^data:\s?/, ""));
    if (lines.length > 0) data.push(lines.join("\n"));
  }
  return { data, rest };
}
