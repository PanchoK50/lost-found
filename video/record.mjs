#!/usr/bin/env node
// Screen-recording pipeline for the Lost & Found pitch video.
//
//   node video/record.mjs                 # all enabled clips, all their viewports
//   node video/record.mjs A6-fire A6-water
//   node video/record.mjs A6-fire:phone   # one clip, one viewport
//   node video/record.mjs --list
//
// Needs the app running (Next.js on :3000, agent API on :8000). Does not start servers.
//
// How it records (desktop): a CDP screencast (Page.startScreencast, JPEG q=92) of a real Chrome
// (headless, WebGL works) writes timestamped frames; ffmpeg turns them into a constant
// 30 fps H.264 / yuv420p MP4. This is much sharper than Playwright's built-in 1 Mbit VP8
// recordVideo, and lets us trim exactly: a clip's steps call `h.mark('start')` and
// `h.mark('end')`, everything outside is dropped (page loading, sign-in).
// Phone (device scale 3): headless screencast frames are only 390 px wide, so the phone is captured with a
// Page.captureScreenshot loop instead (≈24 fps at 1170×2532), resampled to 30 fps.
//
// ── Adding a clip ────────────────────────────────────────────────────────────
// Add an object to CLIPS below:
//   name       file prefix: out/<name>-<viewport>.mp4
//   enabled    false = skipped unless named explicitly on the command line
//   viewports  any of 'phone' | 'desktop' (see VIEWPORTS)
//   style      'blocks' | 'detailed' (localStorage 'lf-scene-style', set before load)
//   signIn     sign in as the "Jury" demo account first (needed for chat)
//   url        path + query on the app (a function (vp) => string also works)
//   paid       number of Claude chat questions per take (guards the budget; needs --paid)
//   steps      async (page, h, vp) => { ... } — interact, call h.mark('start'|'end'),
//              h.still('name') for a PNG into out/stills/<clip>-<vp>-<name>.png.
// Helpers on h: h.wait(ms), h.floor(name) clicks a floor (sidebar on desktop, strip on
// phone), h.zoom(steps) wheel-zooms the 3D model, h.mark, h.still.
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from '/tmp/pwshot/node_modules/playwright-core/index.mjs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const STILLS = join(OUT, 'stills');
const APP = process.env.APP_URL ?? 'http://localhost:3000';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const B = 'proc-campus-test-005'; // Laborgebäude 029, CC0, 6 levels, server rooms in B1

const VIEWPORTS = {
  phone: {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    // Optional per-viewport CSS injected for recording (e.g. a temporary workaround). The phone layout
    // fixes are in the app since commit 4322ab7, so nothing is injected now.
    css: '',
  },
  desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
};

const sim = (kind, space) => `/?building=${B}&simulate=${kind}:${space}`;

/** @type {Array<{name:string, enabled:boolean, viewports:string[], style?:string, signIn?:boolean, url:string|((vp:string)=>string), paid?:number, steps:(page:any,h:any,vp:string)=>Promise<void>}>} */
const CLIPS = [
  {
    // Fire in Seminar room 3.25 spreads along the floor-3 corridor; evacuees walk out.
    name: 'A6-fire', enabled: true, viewports: ['phone', 'desktop'], style: 'detailed', signIn: true,
    url: sim('fire', `${B}-F3-S025`),
    async steps(page, h, vp) {
      await h.waitForSim();
      // Gentle push-in toward the fire room (Seminar room 3.25) before the clip starts.
      if (vp !== 'phone') await h.zoom(30, 0.66, 0.43); // the phone framing is already tight since the layout fix
      // Floor 3's people walk out between about +1.0 and +2.2 min; the big spread is after +6 min (fast clock).
      // Whole take ~20 s, plus two short cuts: A6-fire-walk (people) and A6-fire-spread (fire takes the floor).
      await h.waitSimTime(0.9);
      h.mark('start');
      h.cut('A6-fire-walk');
      await h.waitSimTime(1.45);
      await h.still('walking');
      await h.waitSimTime(2.3);
      h.cutEnd();
      await h.waitSimTime(4.3);
      h.cut('A6-fire-spread');
      await h.waitSimTime(10.5);
      await h.still('spread');
      await h.wait(1200);
      h.cutEnd();
      h.mark('end');
    },
  },
  {
    // Water leak in Toilet 0.18 (ground floor) runs down into Basement 1 (server rooms).
    name: 'A6-water', enabled: true, viewports: ['phone', 'desktop'], style: 'detailed', signIn: true,
    url: sim('water', `${B}-F0-S018`),
    async steps(page, h) {
      await h.waitForSim();
      await h.waitSimTime(4.5); // a few spaces wet; at +6 min the clock speeds up
      h.mark('start');
      await h.waitSimTime(12.5);
      await h.still('ground');
      await h.floor('Basement 1'); // water reaches Server room -1.09 directly below at about +15 min
      await h.waitSimTime(22);
      await h.still('basement');
      await h.wait(1500);
      h.mark('end');
    },
  },
  {
    // Electrical fault in Meeting room 2.25: the power-cut zone is tinted yellow.
    name: 'A6-power', enabled: true, viewports: ['phone', 'desktop'], style: 'detailed', signIn: true,
    url: sim('electrical', `${B}-F2-S025`),
    async steps(page, h) {
      await h.waitForSim();
      h.mark('start');
      await h.wait(6000);
      await h.still('zone');
      await h.wait(4000);
      h.mark('end');
    },
  },
  {
    // Occupant asks the assistant for a way out. PAID: one Claude question per take.
    name: 'A1-route', enabled: true, viewports: ['phone'], style: 'detailed', signIn: true, paid: 1,
    url: `/?building=${B}`,
    async steps(page, h) {
      // Keep the raw /api/chat reply for checking the route against the text.
      page.on('response', async res => {
        if (!res.url().includes('/api/chat')) return;
        await writeFile(join(OUT, 'A1-route-api.txt'), await res.text().catch(e => `unreadable: ${e.message}`)).catch(() => {});
      });
      const input = page.getByLabel('Ask about the building');
      await input.waitFor();
      await h.wait(800);
      h.mark('start');
      await input.click();
      await input.pressSequentially('Power is out in Meeting room 2.25 and the lifts are down. How do we get out?', { delay: 28 });
      await h.wait(400);
      await input.press('Enter');
      // Wait for the answer (assistant text) and give the route time to draw.
      // Agent latency varies; record a fixed window and keep stills along the way.
      await h.wait(6000);
      await h.still('waiting');
      await h.wait(12000);
      await h.still('route');
      await h.wait(4000);
      await h.still('route-late');
      h.mark('end');
      await writeFile(join(OUT, 'A1-route-answer.txt'), await page.locator('.shell-panel').first().innerText().catch(() => page.locator('body').innerText()));
    },
  },

  {
    // A2 → A5 as one continuous take; each step is also written as its own cut:
    //   A2-notify    push-style alert slides in ("Power loss · Laborgebäude 029 / Meeting room 2.25 · Floor 2")
    //   A3-overview  tap the alert: live incident, amber power-cut zone on floor 2, lifts Closed, Situation panel
    //   A4-technician "Call technician": ticket Reported → On the way · ETA 15 min → Fixed
    //   A5-resolve   key "f": "Status: fixed", tracker complete, amber zone fades out, lift locks disappear
    name: 'A2-A5-incident', enabled: true, viewports: ['phone', 'desktop'], style: 'detailed', signIn: true,
    url: `/?building=${B}&notify=electrical:${B}-F2-S025`,
    async steps(page, h, vp) {
      await h.wait(300);
      h.mark('start');
      h.cut('A2-notify');
      const toast = page.locator('.incident-toast');
      await toast.waitFor({ timeout: 30000 });
      await h.wait(2200);
      await h.still('A2-notify');
      h.cut('A3-overview');
      await toast.click();
      await h.wait(3000);
      await h.still('A3-overview');
      await h.wait(2800);
      h.cut('A4-technician');
      await page.locator('button:visible', { hasText: 'Call technician' }).first().click();
      await h.wait(700);
      // Phone: the ticket card sits below the fold of the panel; scroll it into view.
      if (vp === 'phone') await page.getByText('Ticket', { exact: true }).first().evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' })).catch(() => {});
      await h.wait(1300);
      await h.still('A4-technician');
      await h.wait(1500);
      h.cut('A5-resolve');
      await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
      await page.keyboard.press('f');
      await h.wait(250);
      // Phone: bring the "Status: fixed" banner (top of the panel) back into view.
      if (vp === 'phone') await page.getByText(/Status: fixed/).first().evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'start' })).catch(() => {});
      await h.wait(1250);
      await h.still('A5-resolve');
      await h.wait(1800);
      h.cutEnd();
      h.mark('end');
    },
  },
];

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const allowPaid = args.includes('--paid');
const keepFrames = args.includes('--keep-frames');
const names = args.filter(a => !a.startsWith('--'));
if (args.includes('--list')) {
  for (const c of CLIPS) console.log(`${c.enabled ? '✓' : '·'} ${c.name.padEnd(14)} ${c.viewports.join(',')}${c.paid ? `  (paid: ${c.paid} question/take)` : ''}`);
  process.exit(0);
}
const jobs = [];
for (const c of CLIPS) {
  const wanted = names.length ? names.filter(n => n.split(':')[0] === c.name) : (c.enabled ? [c.name] : []);
  for (const w of wanted) {
    const vp = w.split(':')[1];
    for (const v of vp ? [vp] : c.viewports) jobs.push([c, v]);
  }
}
if (!jobs.length) { console.error('No clips selected. --list shows them.'); process.exit(1); }
const paid = jobs.reduce((n, [c]) => n + (c.paid ?? 0), 0);
if (paid && !allowPaid) {
  console.error(`Selected clips ask Claude ${paid} question(s) (~$${(paid * 0.02).toFixed(2)}). Re-run with --paid to allow, or leave them out.`);
  process.exit(1);
}

await mkdir(STILLS, { recursive: true });
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
  for (const [clip, vp] of jobs) await record(clip, vp).catch(err => console.error(`✗ ${clip.name}-${vp}: ${err.message}`));
} finally {
  await browser.close();
}

// ── Recorder ─────────────────────────────────────────────────────────────────
async function record(clip, vp) {
  const tag = `${clip.name}-${vp}`;
  console.log(`● ${tag}`);
  const { css: extraCss = '', ...options } = VIEWPORTS[vp];
  const ctx = await browser.newContext({ ...options, colorScheme: 'light' });
  await ctx.addInitScript(([style, extra]) => {
    if (style) localStorage.setItem('lf-scene-style', style);
    // Hide the Next.js dev-tools badge (bottom left) for clean footage.
    const css = 'nextjs-portal{display:none!important}' + extra;
    const add = () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
    if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
  }, [clip.style ?? null, extraCss]);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`  page error: ${e.message.slice(0, 160)}`));

  if (clip.signIn) await signIn(page);
  else await page.goto(`${APP}/?building=${B}`, { waitUntil: 'domcontentloaded' });
  // Fresh incident list per take (key 'lf-incidents'), so old incidents don't pile up.
  await page.evaluate(() => localStorage.removeItem('lf-incidents'));

  // Start the screencast, then load the clip URL.
  const frameDir = join(OUT, '.frames', tag);
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = []; // { file, t } t = seconds (monotonic, from screencast metadata)
  let writes = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    frames.push({ file, t: metadata.timestamp });
    writes.push(writeFile(file, Buffer.from(data, 'base64')));
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  const { width, height } = VIEWPORTS[vp].viewport;
  const scale = VIEWPORTS[vp].deviceScaleFactor;
  // Headless Chrome's screencast always delivers CSS-pixel frames (390 px wide on the phone), ignoring the
  // device scale factor. For scale > 1 we instead grab screenshots in a loop with clip.scale (≈24 fps at
  // 1170×2532, real 3× rendering); each frame is stamped with the wall-clock time of the capture.
  let shooting = scale > 1;
  let inFlight = Promise.resolve(); // the capture in progress; stills wait for it (parallel captures garble frames)
  let paused = false;
  const shotLoop = shooting && (async () => {
    while (shooting) {
      if (paused) { await new Promise(r => setTimeout(r, 10)); continue; }
      const t = Date.now() / 1000;
      const res = await (inFlight = Promise.race([
        cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, optimizeForSpeed: true, clip: { x: 0, y: 0, width, height, scale } }).catch(() => null),
        new Promise(r => setTimeout(() => r(null), 3000)), // a capture can stall during navigation
      ]));
      if (!res) { await new Promise(r => setTimeout(r, 30)); continue; }
      const file = join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
      frames.push({ file, t: (t + Date.now() / 1000) / 2 });
      writes.push(writeFile(file, Buffer.from(res.data, 'base64')));
    }
  })();
  if (!shooting) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: width * scale, maxHeight: height * scale, everyNthFrame: 1 });

  const marks = {};
  const now = () => Date.now() / 1000;
  const cuts = []; // extra outputs from the same take: { name, t0, t1 }
  const closeCut = () => { const open = cuts.at(-1); if (open && open.t1 == null) open.t1 = now(); };
  const h = {
    /** Start a named cut (out/<name>-<vp>.mp4) from this take; closes the previous cut. */
    cut: name => { closeCut(); cuts.push({ name, t0: now(), t1: null }); },
    cutEnd: closeCut,
    wait: ms => page.waitForTimeout(ms),
    mark: name => { marks[name] = now(); },
    still: async name => {
      paused = true;
      await inFlight;
      await page.screenshot({ path: join(STILLS, `${tag}-${name}.png`) }).finally(() => { paused = false; });
    },
    async waitForSim() {
      // The scenario clock ("at +M:SS" in the panel) appears once the simulation has loaded.
      await page.waitForFunction(() => /at \+\d+:\d\d/.test(document.body.innerText), null, { timeout: 30000, polling: 100 }).catch(() => {});
      await page.waitForTimeout(400);
    },
    /** Wait until the scenario clock ("at +M:SS" in the panel) reaches `min` simulated minutes. */
    async waitSimTime(min, timeout = 60000) {
      await page.waitForFunction(m => {
        const hit = /at \+(\d+):(\d\d)/.exec(document.body.innerText);
        return hit && +hit[1] + +hit[2] / 60 >= m;
      }, min, { timeout, polling: 100 });
    },
    async floor(name) {
      // Desktop: sidebar button text. Phone: floor strip buttons (aria-label starts with floor name).
      const btn = page.locator(`button[aria-label^="${name}"]:visible, button:visible:has-text("${name}")`).first();
      await btn.click();
    },
    /** Zoom the 3D model toward a point (fractions of the canvas). The controls are very sensitive:
     *  one wheel notch of 120 flies into the floor; 25-40 is a gentle push-in. */
    async zoom(delta = 30, fx = 0.5, fy = 0.5) {
      const box = await page.locator('canvas').first().boundingBox();
      if (!box) return;
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.mouse.wheel(0, -delta);
      await page.waitForTimeout(300);
      // Park the pointer off the model so no room hover tooltip shows in the shot.
      await page.mouse.move(2, (VIEWPORTS[vp].viewport.height) - 2);
      await page.waitForTimeout(600);
    },
  };

  const startedAt = now();
  const url = typeof clip.url === 'function' ? clip.url(vp) : clip.url;
  await page.goto(APP + url, { waitUntil: 'domcontentloaded' });
  await page.locator('canvas').first().waitFor({ timeout: 30000 });
  let failed;
  try { await clip.steps(page, h, vp); } catch (e) { failed = e; }
  marks.end ??= now();
  shooting = false;
  await shotLoop;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await Promise.all(writes);
  await ctx.close();
  if (failed) throw failed;

  // Map wall-clock marks to screencast timestamps (both are epoch seconds in Chrome).
  closeCut();
  await encode(frames, marks.start ?? startedAt, marks.end, join(OUT, `${tag}.mp4`), join(frameDir, 'frames.txt'));
  for (const c of cuts) await encode(frames, c.t0, c.t1, join(OUT, `${c.name}-${vp}.mp4`), join(frameDir, `cut-${c.name}.txt`));
  if (!keepFrames) await rm(frameDir, { recursive: true, force: true });
}

async function encode(frames, t0, t1, mp4, list) {
  const kept = frames.filter(f => f.t >= t0 - 0.05 && f.t <= t1 + 0.05);
  if (kept.length < 2) throw new Error(`only ${kept.length} frames in the marked range (${frames.length} total)`);
  const lines = [];
  for (let i = 0; i < kept.length; i++) {
    const dur = i + 1 < kept.length ? kept[i + 1].t - kept[i].t : 1 / 30;
    lines.push(`file '${kept[i].file}'`, `duration ${Math.max(dur, 0.001).toFixed(4)}`);
  }
  lines.push(`file '${kept.at(-1).file}'`);
  await writeFile(list, lines.join('\n'));
  // Even dimensions for yuv420p.
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  const span = kept.at(-1).t - kept[0].t;
  console.log(`  ✓ ${mp4}  ${span.toFixed(1)} s, ${kept.length} frames (${(kept.length / span).toFixed(1)} fps captured)`);
}

async function signIn(page) {
  await page.goto(`${APP}/?building=${B}`, { waitUntil: 'domcontentloaded' });
  const jury = page.locator('button:has-text("Jury")').first();
  const account = page.locator('.shell-account');
  // The "Who are you?" sheet opens on first visit; if not, open it from the account button.
  await Promise.race([jury.waitFor({ timeout: 15000 }), account.waitFor({ timeout: 15000 })]).catch(() => {});
  if (!(await jury.isVisible().catch(() => false))) {
    if ((await account.getAttribute('aria-label').catch(() => ''))?.includes('Jury')) return;
    await account.click().catch(() => {});
    await jury.waitFor({ timeout: 10000 });
  }
  await jury.click();
  await page.waitForFunction(() => /Signed in as/.test(document.querySelector('.shell-account')?.getAttribute('aria-label') ?? ''), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  // Close the sheet if it stayed open.
  if (await jury.isVisible().catch(() => false)) await page.keyboard.press('Escape');
}
