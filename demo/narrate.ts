// Narration first: one clip per sentence, measured, so the recorder can hold each shot exactly as
// long as its words. Replace the WAVs in demo/out/audio with your own recording (same file names)
// and re-run assemble; nothing else needs to change as long as each clip is no longer than before.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { SHOTS } from "./shots.ts";

const OUT = "demo/out/audio";
const VOICE = process.env.DEMO_VOICE ?? "Samantha";
const RATE = process.env.DEMO_RATE ?? "182";
export const GAP_S = 0.3;

export interface Line { file: string; text: string; dur: number }
export interface Segment { lines: Line[]; dur: number }
export type Manifest = Record<string, { setup: Segment; payoff?: Segment }>;

const sentences = (t: string) => t.match(/[^.!?]+[.!?]+/g)!.map((s) => s.trim());

function clip(file: string, text: string): Line {
  const aiff = `${OUT}/${file}.aiff`, wav = `${OUT}/${file}.wav`;
  execFileSync("say", ["-v", VOICE, "-r", RATE, "-o", aiff, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ar", "48000", "-ac", "1", wav]);
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).toString());
  return { file: wav, text, dur };
}

function segment(prefix: string, text: string): Segment {
  const lines = sentences(text).map((s, i) => clip(`${prefix}-${String(i).padStart(2, "0")}`, s));
  return { lines, dur: lines.reduce((n, l) => n + l.dur, 0) + GAP_S * (lines.length - 1) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT, { recursive: true });
  const m: Manifest = {};
  for (const s of SHOTS) m[s.id] = { setup: segment(`${s.id}-setup`, s.setup), ...(s.payoff && { payoff: segment(`${s.id}-payoff`, s.payoff) }) };
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(m, null, 2));
  let total = 0;
  for (const [id, v] of Object.entries(m)) {
    const t = v.setup.dur + (v.payoff?.dur ?? 0);
    total += t;
    console.log(`${id.padEnd(9)} setup ${v.setup.dur.toFixed(1)}s  payoff ${(v.payoff?.dur ?? 0).toFixed(1)}s`);
  }
  console.log(`narration total ${total.toFixed(1)}s`);
}
