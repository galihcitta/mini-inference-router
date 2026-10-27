// Cuts each recorded shot to its narrated span, joins them, lays every narration clip at the moment
// its caption appeared, normalises loudness, and writes the final MP4 plus a sidecar SRT.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ShotTimeline } from "./record.ts";

type Timed = ShotTimeline & { cut?: { at: number; dur: number } }; // a static stretch removed after recording

const OUT = "demo/out";
const FINAL = `${OUT}/mini-inference-router-demo.mp4`;
const run = (args: string[]) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "pipe"] });
const probe = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

const timeline: Timed[] = JSON.parse(readFileSync(`${OUT}/timeline.json`, "utf8"));
mkdirSync(`${OUT}/clips`, { recursive: true });

// 1. One constant-frame-rate clip per shot, starting when the page was ready.
const offsets: Record<string, number> = {};
let t = 0;
const list: string[] = [];
timeline.forEach((s, i) => {
  const clip = `${OUT}/clips/${String(i).padStart(2, "0")}-${s.id}.mp4`;
  const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-an"];
  const parts = s.cut ? [[0, s.cut.at], [s.cut.at + s.cut.dur, s.length]] : [[0, s.length]];
  const filter = parts.map(([a, b], k) => `[0:v]trim=start=${(s.trimStart + a).toFixed(3)}:end=${(s.trimStart + b).toFixed(3)},setpts=PTS-STARTPTS[p${k}]`).join(";")
    + `;${parts.map((_, k) => `[p${k}]`).join("")}concat=n=${parts.length}:v=1:a=0,fps=30,scale=1920:1080[v]`;
  run(["-i", s.video, "-filter_complex", filter, "-map", "[v]", ...enc, clip]);
  offsets[s.id] = t;
  t += probe(clip);
  list.push(`file '${clip.replace(`${OUT}/`, "")}'`);
});
writeFileSync(`${OUT}/clips.txt`, list.join("\n"));
run(["-f", "concat", "-safe", "0", "-i", `${OUT}/clips.txt`, "-c", "copy", `${OUT}/video.mp4`]);
const videoDur = probe(`${OUT}/video.mp4`);

// 2. Narration: each sentence placed at its caption time on the joined timeline.
const cues = timeline.flatMap((s) => s.cues.map((c) => {
  const at = s.cut && c.at >= s.cut.at + s.cut.dur ? c.at - s.cut.dur : c.at;
  return { ...c, shot: s.id, abs: offsets[s.id] + at };
}));
const inputs = cues.flatMap((c) => ["-i", c.file]);
const mix = cues.map((c, i) => `[${i}:a]adelay=${Math.round(c.abs * 1000)}:all=1[a${i}]`).join(";")
  + `;${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad,atrim=end=${videoDur.toFixed(3)}`;
run([...inputs, "-filter_complex", `${mix}[out]`, "-map", "[out]", "-ar", "48000", "-ac", "1", `${OUT}/narration-raw.wav`]);

// Two-pass loudnorm to -16 LUFS: measure, then apply with the measured values.
const stderr = execFileSync("sh", ["-c", `ffmpeg -hide_banner -i ${OUT}/narration-raw.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1`]).toString();
const meas = JSON.parse(stderr.match(/\{[^{}]*\}/g)!.at(-1)!);
run(["-i", `${OUT}/narration-raw.wav`, "-af",
  `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true`,
  "-ar", "48000", `${OUT}/narration.wav`]);

// 3. Mux, plus captions as a sidecar SRT for viewers who watch muted (they're also burned in).
run(["-i", `${OUT}/video.mp4`, "-i", `${OUT}/narration.wav`, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", FINAL]);
const ts = (x: number) => new Date(Math.round(x * 1000)).toISOString().slice(11, 23).replace(".", ",");
writeFileSync(FINAL.replace(".mp4", ".srt"), cues.map((c, i) => `${i + 1}\n${ts(c.abs)} --> ${ts(c.abs + c.dur)}\n${c.text}\n`).join("\n"));
writeFileSync(`${OUT}/final-timeline.json`, JSON.stringify({ videoDur, offsets, cues }, null, 2));
console.log(`${FINAL}  ${videoDur.toFixed(1)}s  ${cues.length} narration clips`);
