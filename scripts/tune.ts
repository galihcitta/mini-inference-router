// Retrieval-only accuracy on data/dev.jsonl and the out-of-domain score threshold, tuned on dev
// data only (never data/eval.jsonl). Usage: npx tsx scripts/tune.ts
import { readFileSync } from "node:fs";
import { loadKb, Retriever } from "../server/src/support/kb.ts";

const read = (p: string) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const r = new Retriever(loadKb());
const dev = read("data/dev.jsonl"), ood = read("data/ood_dev.jsonl");

const dres = dev.map((d) => ({ d, s: r.search(d.question) }));
const acc = dres.filter((x) => x.s.majority === x.d.intent).length / dev.length;
console.log(`dev retrieval-only intent accuracy: ${(acc * 100).toFixed(1)}% (n=${dev.length})`);
for (const v of [5, 4, 3, 2, 1]) {
  const g = dres.filter((x) => (x.s.votes[x.s.majority!] ?? 0) === v);
  if (g.length) console.log(`  votes ${v}/5: ${g.length} cases, ${((g.filter((x) => x.s.majority === x.d.intent).length / g.length) * 100).toFixed(1)}% correct`);
}
const inScores = dres.map((x) => x.s.topScore).sort((a, b) => a - b);
const oodScores = ood.map((o) => ({ q: o.question, s: r.search(o.question).topScore }));
const pct = (p: number) => inScores[Math.floor(p * (inScores.length - 1))].toFixed(2);
console.log(`in-domain topScore p1=${pct(0.01)} p5=${pct(0.05)} p10=${pct(0.1)} median=${pct(0.5)}`);
for (const o of oodScores) console.log(`  ood ${o.s.toFixed(2)}  ${o.q}`);
for (const t of [2, 3, 4, 5, 6, 7, 8, 9]) {
  const fr = inScores.filter((s) => s < t).length / inScores.length;
  const caught = oodScores.filter((o) => o.s < t).length;
  console.log(`  threshold ${t}: false refusals ${(fr * 100).toFixed(1)}%, ood caught ${caught}/${ood.length}`);
}
