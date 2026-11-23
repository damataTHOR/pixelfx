#!/usr/bin/env node
// Export effects for a video editor: real alpha, at delivery size.
//
//   node tools/export.mjs transitions/glitch-wipe --fit 1920x1080
//   node tools/export.mjs weather/snow --fit 1080x1920 --loops 6
//   node tools/export.mjs ui/countdown --png --scale 6
//   node tools/export.mjs fire/torch --chroma --opts '{"palette":["#01326D","#1638E8","#F28C12","#ffffff"]}'
//   node tools/export.mjs transitions --fit 1920x1080            a whole category
//
// Formats (default --mov):
//   --mov      ProRes 4444 .mov, straight alpha      Premiere, Final Cut, Resolve, AE
//   --png      numbered PNG sequence, RGBA           any NLE, lossless
//   --chroma   H.264 .mp4 on green (#00B140)         CapCut and apps with no alpha
//
// There is deliberately no VP9/WebM option: libvpx-vp9 writes the alpha as a side channel that
// ffmpeg's own decoder would not give back (checked 23/11/2026), so it looks transparent and is not.
//
// Options:
//   --fit WxH    deliver at exactly this canvas: integer upscale, centred, transparent padding
//   --cover      with --fit, fill the canvas instead of fitting inside it (crops, bigger pixels).
//                What you want putting a 16:9 effect into a 9:16 delivery.
//   --scale N    nearest-neighbour upscale (default 6; with --fit, it is worked out for you)
//   --loops N    repeat the animation N times (loops only; default 1)
//   --fps N --seed N --opts JSON --out DIR
//   --body       include the stock character (default: the effect alone)
//   --act        the acted-out version: character, target, hit-stop and shake
//
// Pixel art is only ever scaled nearest-neighbour here, never interpolated.

import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ROOT, resolveIds, loadEffect, renderFrames, renderAct, upscale, save } from "./lib/fxlib.mjs";
import { encodePNG } from "./lib/png.mjs";

const FORMATS = ["mov", "png", "chroma"];
const GREEN = [0, 177, 64];

const SWITCHES = [...FORMATS, "body", "act", "cover"];
const VALUED = ["fit", "scale", "loops", "fps", "seed", "opts", "out"];

const args = process.argv.slice(2), flags = {}, ids = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) ids.push(a);
  else if (SWITCHES.includes(a.slice(2))) flags[a.slice(2)] = true;
  else if (VALUED.includes(a.slice(2))) flags[a.slice(2)] = args[++i];
  else {
    // Swallowing an unknown option's argument would quietly eat an effect id.
    console.error(`unknown option ${a}. Switches: --${SWITCHES.join(" --")}. With a value: --${VALUED.join(" --")}.`);
    process.exit(1);
  }
}
if (!ids.length) {
  console.error("usage: node tools/export.mjs <id|category|pattern>... [--mov|--png|--webm|--chroma] [--fit WxH] [--scale N]");
  process.exit(1);
}

const want = FORMATS.filter((f) => flags[f]);
if (!want.length) want.push("mov");
const fit = flags.fit ? flags.fit.toLowerCase().split("x").map(Number) : null;
if (fit && (fit.length !== 2 || !fit.every((n) => Number.isFinite(n) && n > 0))) {
  console.error(`--fit wants WxH, e.g. --fit 1080x1920 (got "${flags.fit}")`);
  process.exit(1);
}

/** Centre src on a w x h canvas, padding with `pad` (transparent by default) and cropping any overflow. */
function place(src, sw, sh, w, h, pad = [0, 0, 0, 0]) {
  const out = new Uint8ClampedArray(w * h * 4);
  if (pad[3]) for (let i = 0; i < w * h; i++) out.set(pad, i * 4);
  const ox = Math.round((w - sw) / 2), oy = Math.round((h - sh) / 2);
  for (let y = Math.max(0, -oy); y < Math.min(sh, h - oy); y++) {
    const row = (y + oy) * w + ox;
    for (let x = Math.max(0, -ox); x < Math.min(sw, w - ox); x++) {
      const s = (y * sw + x) * 4, d = (row + x) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return out;
}

/** Straight-alpha RGBA flattened onto a solid colour, for the chroma key version. */
function onColour(src, rgb) {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    out[i] = src[i] * a + rgb[0] * (1 - a);
    out[i + 1] = src[i + 1] * a + rgb[1] * (1 - a);
    out[i + 2] = src[i + 2] * a + rgb[2] * (1 - a);
    out[i + 3] = 255;
  }
  return out;
}

function encode(file, frames, w, h, fps, format) {
  const args = ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-"];
  if (format === "mov") args.push("-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-vendor", "apl0");
  else args.push("-c:v", "libx264", "-crf", "12", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  args.push(file);
  mkdirSync(join(file, ".."), { recursive: true });
  const res = spawnSync("ffmpeg", args, { input: Buffer.concat(frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.length))), maxBuffer: 1 << 30 });
  if (res.error) throw new Error("ffmpeg is not installed, so only --png can be written");
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
  return file;
}

const out = flags.out ?? join(ROOT, "exports");
let failed = 0;

for (const id of resolveIds(ids)) {
  try {
    const fx = await loadEffect(id);
    const common = {
      fps: flags.fps ? +flags.fps : undefined,
      seed: flags.seed ? +flags.seed : undefined,
      options: flags.opts ? JSON.parse(flags.opts) : undefined,
    };
    // Every source is composited over nothing, so the frames carry straight (non-premultiplied) alpha.
    const r = flags.act ? renderAct(fx, { ...common, bg: "none" }) : renderFrames(fx, { ...common, bg: "none", actor: flags.body ? undefined : false });
    const pick = flags.act || flags.body ? "color" : "clear";

    // How many times to upscale: what was asked, else what --fit needs (inside it, or covering it), else 6.
    const inside = Math.max(1, Math.floor(Math.min(fit?.[0] / r.w, fit?.[1] / r.h)) || 1);
    const covers = Math.max(1, Math.ceil(Math.max(fit?.[0] / r.w, fit?.[1] / r.h)) || 1);
    let k = flags.scale ? +flags.scale : fit ? (flags.cover ? covers : inside) : 6;
    if (fit && flags.scale && !flags.cover) k = Math.max(1, Math.min(k, inside));

    // Canvas: --fit as asked, else the upscaled effect, rounded up to even for the codecs.
    let W = fit ? fit[0] : r.w * k, H = fit ? fit[1] : r.h * k;
    const loops = Math.max(1, +(flags.loops ?? 1));
    if (loops > 1 && !fx.meta.loop) console.error(`${id}: --loops on a one-shot just repeats it`);

    const base = flags.act ? `${id.split("/")[1]}-act` : id.split("/")[1];
    const dir = join(out, id.split("/")[0]), made = [];

    const build = (pad) => {
      const fs = [];
      for (let l = 0; l < loops; l++)
        for (const f of r.frames) fs.push(place(upscale(f[pick], r.w, r.h, k), r.w * k, r.h * k, W, H, pad));
      return fs;
    };

    if (want.includes("png")) {
      const seq = join(dir, base), fs = build();
      mkdirSync(seq, { recursive: true });
      fs.forEach((f, i) => save(join(seq, `${base}_${String(i).padStart(4, "0")}.png`), encodePNG(W, H, f)));
      made.push(`${seq}/  (${fs.length} png)`);
    }
    for (const fmt of want.filter((f) => f !== "png")) {
      const evenW = W + (W % 2), evenH = H + (H % 2);
      const pad = fmt === "chroma" ? [...GREEN, 255] : [0, 0, 0, 0];
      let fs = build(pad);
      if (evenW !== W || evenH !== H) fs = fs.map((f) => place(f, W, H, evenW, evenH, pad));
      if (fmt === "chroma") fs = fs.map((f) => onColour(f, GREEN));
      const name = fmt === "chroma" ? `${base}-green.mp4` : `${base}.mov`;
      made.push(encode(join(dir, name), fs, evenW, evenH, r.fps, fmt));
    }

    console.log(`${id}  ${r.n * loops} frames  ${r.w}x${r.h} x${k} -> ${W}x${H} @${r.fps}  ->  ${made.join("  ")}`);
  } catch (e) {
    failed++;
    console.error(`${id}  FAILED: ${e.message ?? e}`);
  }
}
process.exit(failed ? 1 : 0);
