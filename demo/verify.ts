// Checks the finished video against things other than the recorder's own say-so:
// the stored request rows, the assessment rubric, ffprobe/ebur128, and the on-screen text.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { LIVE_URL, SHOTS, type Area } from "./shots.ts";
import type { ShotTimeline } from "./record.ts";

const OUT = "demo/out";
const FINAL = `${OUT}/mini-inference-router-demo.mp4`;
const timeline: ShotTimeline[] = JSON.parse(readFileSync(`${OUT}/timeline.json`, "utf8"));
const final: { videoDur: number; offsets: Record<string, number>; cues: { shot: string; abs: number; dur: number }[] } =
  JSON.parse(readFileSync(`${OUT}/final-timeline.json`, "utf8"));
const out: string[] = [];
let failures = 0;
const check = (ok: boolean, line: string) => { if (!ok) failures++; out.push(`- ${ok ? "PASS" : "FAIL"} ${line}`); };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// 1. Each narrated claim against the row Postgres stored for that request.
out.push("## Claims vs stored requests");
type Row = { id: string; created_at: string; outcome: string; backend: string | null; attempts: { backend: string; outcome: string }[] };
const rows = async (tenant: string): Promise<Row[]> => (await (await fetch(`${LIVE_URL}/admin/requests?tenant=${tenant}&limit=100`)).json()).requests;
for (const shot of SHOTS.filter((s) => s.expect)) {
  const tl = timeline.find((t) => t.id === shot.id)!;
  let byId = 0;
  for (const e of shot.expect!) {
    if (e.tenant === "(none)") { check(tl.httpStatuses.includes(e.http!), `${shot.id}: HTTP ${e.http} (got ${tl.httpStatuses.join(",")})`); continue; }
    const all = await rows(e.tenant);
    let row: Row | undefined;
    if (e.http) {
      // Rejected before streaming, so the console never shows its id: take the tenant's newest row of that outcome.
      row = all.find((r) => r.outcome === e.outcome);
      check(tl.httpStatuses.includes(e.http) && !!row, `${shot.id}: HTTP ${e.http} and a stored ${e.outcome} row`);
      continue;
    }
    const id = tl.requestIds[byId++];
    row = all.find((r) => r.id === id);
    const attempts = row?.attempts.map((a) => `${a.backend}:${a.outcome}`) ?? [];
    const ok = !!row && row.outcome === e.outcome && (e.backend === undefined || row.backend === e.backend)
      && (!e.attempts || JSON.stringify(attempts) === JSON.stringify(e.attempts));
    check(ok, `${shot.id}: ${row ? `${row.outcome}, backend ${row.backend}, attempts [${attempts.join(" → ")}]` : "row not found"}`);
  }
}

// 2. Every assessment area is shown somewhere, with timestamps.
out.push("", "## Rubric coverage", "", "| Area | Shown at |", "|---|---|");
const areas: Area[] = ["Request path", "Routing and fallback", "Measurement", "Exception handling", "Judgement"];
for (const a of areas) {
  const at = SHOTS.filter((s) => s.areas.includes(a)).map((s) => `${mmss(final.offsets[s.id])} ${s.title}`);
  out.push(`| ${a} | ${at.join("; ") || "**missing**"} |`);
  if (!at.length) failures++;
}

// 3. Media: format, length, sync, loudness.
out.push("", "## Media");
const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", FINAL]).toString());
const v = p.streams.find((s: any) => s.codec_type === "video"), a = p.streams.find((s: any) => s.codec_type === "audio");
check(v.width === 1920 && v.height === 1080, `resolution ${v.width}x${v.height}`);
check(Number(p.format.duration) < 300, `length ${mmss(Number(p.format.duration))}`);
const drift = Math.abs(Number(v.duration) - Number(a.duration)) * 1000;
check(drift < 100, `audio/video end drift ${drift.toFixed(0)} ms`);
// Narration must stay inside its own shot, or it would talk over the next scene.
const ends = Object.entries(final.offsets).sort((x, y) => x[1] - y[1]);
const spill = final.cues.filter((c) => {
  const i = ends.findIndex(([id]) => id === c.shot);
  const next = ends[i + 1]?.[1] ?? final.videoDur;
  return c.abs + c.dur > next + 0.02;
});
check(spill.length === 0, `narration stays within its shot (${spill.length} clips spill over)`);
const overlap = final.cues.slice(1).filter((c, i) => c.abs < final.cues[i].abs + final.cues[i].dur - 0.02);
check(overlap.length === 0, `no two narration clips overlap (${overlap.length})`);
const r128 = execFileSync("sh", ["-c", `ffmpeg -hide_banner -nostats -i ${FINAL} -map 0:a -af ebur128 -f null - 2>&1 | grep -A1 'Integrated loudness' | tail -1`]).toString();
const lufs = Number(/I:\s+(-?[\d.]+)/.exec(r128)?.[1]);
check(Math.abs(lufs + 16) <= 1, `integrated loudness ${lufs} LUFS`);

// 4. No key readable on screen (checked in the DOM at the end of each shot).
out.push("", "## Secrets");
const leaks = timeline.flatMap((t) => t.leaks.map((l) => `${t.id}: ${l}`));
check(leaks.length === 0, `no demo API key in any shot's rendered text or inputs${leaks.length ? `: ${leaks.join(", ")}` : ""}`);

out.unshift(`# Demo video verification`, ``, `${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`, ``);
writeFileSync(`${OUT}/verify.md`, out.join("\n") + "\n");
console.log(out.join("\n"));
process.exitCode = failures ? 1 : 0;
