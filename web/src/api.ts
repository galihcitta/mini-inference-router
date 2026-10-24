// Non-2xx responses are plain JSON: {error, ...}. Turn one into a readable message.
export async function describeHttpError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  const code = typeof body?.error === "string" ? body.error : null;
  let msg = `HTTP ${res.status}`;
  if (code) msg += ` ${code}`;
  if (res.status === 401) msg += " (missing, unknown or revoked key)";
  if (res.status === 429 && body && "remaining_usd" in body) {
    msg += `: remaining_usd ${fmtUsd(body.remaining_usd)}`;
  }
  if (res.status === 503) msg += " (service unavailable, failed closed)";
  if (body && Array.isArray(body.issues) && body.issues.length) {
    msg += "\nissues:\n" + body.issues.map((i) => "  - " + (typeof i === "string" ? i : JSON.stringify(i))).join("\n");
  }
  if (!code && text) msg += `\n${text.slice(0, 500)}`;
  return msg;
}

export function fmtUsd(v: unknown, digits = 6): string {
  return typeof v === "number" && Number.isFinite(v) ? "$" + v.toFixed(digits) : "–";
}

export function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
