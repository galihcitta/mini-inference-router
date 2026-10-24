export interface SseEvent {
  event: string;
  data: unknown;
}

// Parses one raw event block (the text between blank lines).
function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { event, data };
}

// Reads an SSE byte stream and yields parsed events. Handles events split
// across chunks (and multi-byte characters split across chunks) by buffering
// until a blank line closes the event.
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Normalize CRLF/CR, but hold a trailing \r in case its \n is in the next chunk.
      const held = buf.endsWith("\r");
      buf = (held ? buf.slice(0, -1) : buf).replace(/\r\n?/g, "\n") + (held ? "\r" : "");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    buf += decoder.decode().replace(/\r\n?/g, "\n");
    const tail = parseBlock(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
