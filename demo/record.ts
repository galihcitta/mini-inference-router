// Records each shot against the live console in its own browser context (one video file per shot),
// holding every shot as long as its narration. Writes demo/out/timeline.json for assemble and verify.
// Usage: npx tsx demo/record.ts [shot ids...]   (real model calls: about a cent per full take)
import { chromium, type Browser, type Page } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { LIVE_URL, SHOTS, type Shot } from "./shots.ts";
import { GAP_S, type Manifest, type Segment } from "./narrate.ts";

const OUT = "demo/out";
const manifest: Manifest = JSON.parse(readFileSync(`${OUT}/audio/manifest.json`, "utf8"));
const FAKE_KEY = "mir_notarealkey000000000000000000000000";

export interface Cue { file: string; text: string; at: number; dur: number } // at: seconds from clip start
export interface ShotTimeline {
  id: string; video: string; trimStart: number; length: number;
  cues: Cue[]; requestIds: string[]; httpStatuses: number[]; leaks: string[]; attempts: number;
}

// Visible cursor, click ripple, captions and highlight ring: Playwright's video shows none of these by itself.
const OVERLAY = `
addEventListener("DOMContentLoaded", () => {
  const css = document.createElement("style");
  css.textContent = \`
    #__cur{position:fixed;left:-40px;top:-40px;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;
      background:#ffffffe6;border:2px solid #18212d;box-shadow:0 2px 8px #0005;z-index:2147483647;pointer-events:none}
    .__rip{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:3px solid #2f6fdf;
      z-index:2147483646;pointer-events:none;animation:__rip .55s ease-out forwards}
    @keyframes __rip{to{transform:scale(3.2);opacity:0}}
    #__cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);max-width:1560px;width:max-content;
      padding:14px 26px;border-radius:14px;background:#18212dee;color:#fff;font:500 32px/1.35 "IBM Plex Sans",system-ui,sans-serif;
      text-align:center;z-index:2147483645;pointer-events:none;opacity:0;transition:opacity .15s}
    #__ring{position:fixed;border:4px solid #b7791f;border-radius:16px;box-shadow:0 0 0 8px #b7791f33;
      z-index:2147483644;pointer-events:none;opacity:0;transition:opacity .25s}\`;
  document.head.appendChild(css);
  // Zoom the page, not the overlays: they live outside <body> so they use plain viewport pixels.
  document.body.style.zoom = "1.5";
  const mk = (id) => { const e = document.createElement("div"); e.id = id; document.documentElement.appendChild(e); return e; };
  const cur = mk("__cur"), cap = mk("__cap"), ring = mk("__ring");
  addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", (e) => {
    const r = document.createElement("div"); r.className = "__rip";
    r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
    document.documentElement.appendChild(r); setTimeout(() => r.remove(), 600);
  }, true);
  let target = null;
  const follow = () => {
    if (target) { const b = target.getBoundingClientRect();
      Object.assign(ring.style, { left: b.left - 9 + "px", top: b.top - 9 + "px", width: b.width + 18 + "px", height: b.height + 18 + "px" }); }
    requestAnimationFrame(follow);
  };
  follow();
  window.__demo = {
    caption(text) { cap.textContent = text; cap.style.opacity = text ? "1" : "0"; },
    highlight(sel) {
      target = sel ? document.querySelector(sel) : null;
      if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
      ring.style.opacity = target ? "1" : "0";
    },
  };
});`;

function cardHtml(c: NonNullable<Shot["card"]>) {
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
  body{margin:0;height:calc(100vh - 120px);display:flex;align-items:center;background:#f4f6f8;color:#18212d;font-family:"IBM Plex Sans",system-ui,sans-serif}
  main{margin:0 96px;max-width:1000px}
  h1{font-size:54px;font-weight:600;margin:0 0 18px;letter-spacing:-.01em}
  .route{display:flex;gap:10px;margin:0 0 30px}
  .route span{padding:6px 14px;border-radius:999px;color:#fff;font-weight:600;font-size:17px}
  p{font-size:23px;line-height:1.45;margin:0 0 10px;color:#3a4756}
  p:last-child{color:#5d6b7b}
</style></head><body><main>
<h1>${c.heading}</h1>
<div class="route"><span style="background:#0b8478">Haiku 5.5</span><span style="background:#5a47cf">Sonnet 5.5</span><span style="background:#6f7c8b">Backup</span></div>
${c.lines.map((l) => `<p>${l}</p>`).join("")}
</main></body></html>`;
}

const sleepUntil = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now())));

// Shows each sentence's caption at the moment its audio will play; returns the cues (relative to t0).
async function speak(page: Page, seg: Segment, at: number, t0: number, highlights: (string | null)[] = []): Promise<Cue[]> {
  const cues: Cue[] = [];
  let t = at;
  for (const l of seg.lines) { cues.push({ file: l.file, text: l.text, at: (t - t0) / 1000, dur: l.dur }); t += (l.dur + GAP_S) * 1000; }
  const events = [
    ...cues.map((c) => ({ at: t0 + c.at * 1000, run: () => page.evaluate((x) => (window as any).__demo.caption(x), c.text) })),
    ...highlights.map((sel, i) => ({ sel, at: t0 + (cues[i]?.at ?? 0) * 1000 })).filter((h) => h.sel && h.at > t0)
      .map((h) => ({ at: h.at, run: () => page.evaluate((x) => (window as any).__demo.highlight(x), h.sel) })),
  ].sort((a, b) => a.at - b.at);
  for (const e of events) { await sleepUntil(e.at); await e.run(); }
  await sleepUntil(t - GAP_S * 1000);
  await page.evaluate(() => (window as any).__demo.caption(""));
  return cues;
}

async function glideClick(page: Page, loc: ReturnType<Page["locator"]>) {
  await loc.scrollIntoViewIfNeeded();
  const b = (await loc.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 28 });
  await page.waitForTimeout(180);
  await page.mouse.down(); await page.mouse.up();
}

async function verdictIs(page: Page, re: RegExp, timeout = 60_000) {
  await page.locator(".verdict:not(.is-running)").filter({ hasText: re }).waitFor({ timeout });
}

async function takeShot(browser: Browser, shot: Shot, attempt: number, demoKeys: string[]): Promise<ShotTimeline> {
  const dir = `${OUT}/raw/${shot.id}-${attempt}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir, size: { width: 1920, height: 1080 } } });
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const httpStatuses: number[] = [];
  page.on("response", (r) => { if (/\/v1\//.test(r.url())) httpStatuses.push(r.status()); });
  const m = manifest[shot.id];
  const requestIds: string[] = [];
  const readId = async () => { const loc = page.locator(".request-id code"); if (await loc.count()) requestIds.push((await loc.textContent())!.trim()); };
  try {
    if (shot.kind === "card") {
      await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(cardHtml(shot.card!)), { waitUntil: "networkidle" });
    } else {
      await page.goto(LIVE_URL);
      await page.getByText("Demo mode").waitFor();
      await page.mouse.move(960, 540);
    }
    await page.waitForTimeout(600);
    const ready = Date.now();

    // Setup narration runs while the actions happen; scenario actions start on its last sentence.
    const lastLine = m.setup.lines.slice(0, -1).reduce((n, l) => n + (l.dur + GAP_S) * 1000, 0);
    const setupEnd = ready + m.setup.dur * 1000;
    const setupCues = speak(page, m.setup, ready, t0, shot.kind === "usage" ? [null, "table.tenants"] : []);
    let resultAt = ready;

    if (shot.kind === "scenario" || shot.kind === "auth") {
      await sleepUntil(ready + (shot.kind === "auth" ? 0 : lastLine));
      await glideClick(page, page.getByRole("button", { name: new RegExp(`^${shot.kind === "auth" ? "A normal question" : shot.scenario}`) }));
      if (shot.kind === "auth") {
        await glideClick(page, page.getByRole("button", { name: "Use my own key" }));
        await glideClick(page, page.getByLabel("Tenant API key"));
        await page.keyboard.type(FAKE_KEY, { delay: 25 });
      }
      await page.waitForTimeout(500);
      await glideClick(page, page.getByRole("button", { name: "Send", exact: true }));
      if (shot.id === "budget") {
        await verdictIs(page, /answered/);
        await readId();
        await sleepUntil(setupEnd + 300);
        await glideClick(page, page.getByRole("button", { name: "Send", exact: true }));
      }
      await page.mouse.move(1880, 620, { steps: 20 }); // park the cursor off the content
      await verdictIs(page, shot.verdict!);
      await readId();
      resultAt = Date.now();
    } else if (shot.kind === "usage") {
      await glideClick(page, page.getByRole("button", { name: "Usage" }));
      const tenantRow = page.locator("table.tenants tr.clickable", { hasText: "slow-haiku" });
      await tenantRow.waitFor();
      await sleepUntil(setupEnd);
      await glideClick(page, tenantRow);
      const row = page.locator("table.request-table tr.clickable").first();
      await row.waitFor();
      await glideClick(page, row);
      await page.locator("tr.detail").filter({ hasText: "Sent nothing before its time limit" }).waitFor({ timeout: 20_000 });
      resultAt = Date.now();
    }

    const cues = await setupCues;
    let end = setupEnd + 1000;
    if (m.payoff) {
      const payoffAt = Math.max(setupEnd + 400, resultAt + 700);
      await sleepUntil(payoffAt);
      cues.push(...(await speak(page, m.payoff, payoffAt, t0, shot.highlights)));
      end = payoffAt + m.payoff.dur * 1000 + 900;
    }
    await sleepUntil(end);
    await page.evaluate(() => (window as any).__demo.highlight(null));

    // No key should ever be readable on screen: check the rendered text and every input's value.
    const visible = await page.evaluate(() => document.body.innerText + " " + [...document.querySelectorAll("input,textarea,select")].map((e: any) => e.value).join(" "));
    const leaks = demoKeys.filter((k) => visible.includes(k)).map((k) => k.slice(0, 8) + "…");
    await ctx.close();
    const video = readdirSync(dir).find((f) => f.endsWith(".webm"))!;
    return { id: shot.id, video: `${dir}/${video}`, trimStart: (ready - t0) / 1000, length: (end - ready) / 1000,
      cues: cues.map((c) => ({ ...c, at: c.at - (ready - t0) / 1000 })), requestIds, httpStatuses, leaks, attempts: attempt };
  } catch (e) {
    await ctx.close();
    throw e;
  }
}

const only = process.argv.slice(2);
const browser = await chromium.launch();
const demoKeys: string[] = (await (await fetch(`${LIVE_URL}/demo`)).json()).tenants.map((t: { key: string }) => t.key);
await fetch(LIVE_URL); // wake the free instance before the first take
const path = `${OUT}/timeline.json`;
const timeline: ShotTimeline[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
for (const shot of SHOTS.filter((s) => !only.length || only.includes(s.id))) {
  // The budget shot can't be retried: the first take spends the tenant's only answer.
  const tries = shot.id === "budget" ? 1 : 3;
  for (let a = 1; a <= tries; a++) {
    try {
      const t = await takeShot(browser, shot, a, demoKeys);
      const i = timeline.findIndex((x) => x.id === shot.id);
      if (i >= 0) timeline[i] = t; else timeline.push(t);
      writeFileSync(path, JSON.stringify(SHOTS.map((s) => timeline.find((x) => x.id === s.id)).filter(Boolean), null, 2));
      console.log(`${shot.id.padEnd(9)} ok  take ${a}  ${t.length.toFixed(1)}s  requests ${t.requestIds.length}  http ${t.httpStatuses.join(",") || "-"}  leaks ${t.leaks.length}`);
      break;
    } catch (e) {
      console.log(`${shot.id.padEnd(9)} take ${a} failed: ${(e as Error).message.split("\n")[0]}`);
      if (a === tries) process.exitCode = 1;
    }
  }
}
await browser.close();
