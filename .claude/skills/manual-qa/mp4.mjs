// The annotated MP4: one video per PASS or FAIL `web` scenario with
// `Capture: video` that stands alone, next to its Storyboard (SKILL.md step 6,
// ADAPTER.md "The MP4", DESIGN.md "One file that stands alone").
//
// WHAT IT DOES
//   Builds `s<n>.mp4` from what a run saved: the Storyboard's scenario file
//   (`s<n>-storyboard.json`), the step files and the per-Session `webm`
//   recordings `web.mjs --video` wrote. Nothing is run again, so the MP4 can be
//   built again at any time from the same files.
//
//   - The steps play in order across Sessions, split into Scenes at each Cut,
//     where the story moves to another Session; both sides switch Session
//     there, full frame. A role's Session first plays from its recording's
//     start, so its sign-in is on camera (ADR 0020); a Scenario account's
//     from its first step. A later Scene plays from the previous step's time.
//     `proves` only sets the highlight.
//   - Before beside After when Before has a recording of a Session shown, a
//     Scene whose Session it lacks showing the no-recording frame on Before;
//     After alone otherwise (a feature scenario, a Before not run or not
//     observed, or no recording of any Session shown).
//   - Each side holds on each step's frame for `HOLD_SECONDS`, and plays the
//     stretch between two steps at `BETWEEN_SPEED`; the side whose stretch is
//     shorter waits on its step's frame, so both sides reach each step together.
//   - Overlaid: the Storyboard's band across the top, and under each side the
//     step's caption with a timing line beneath it (the wall-clock time with its
//     zone, in whole seconds, the time since the side started, and on After its
//     difference from Before). The band and captions are images from the Storyboard's renderer;
//     ffmpeg only scales, pads, stacks and joins them.
//   - The caption privacy check runs first, over everything the Storyboard
//     shows and every text the MP4 adds: on a refusal nothing is written, each
//     field is named (never its value), and it is kept as `[withheld]` in the
//     file it came from, as the Storyboard does.
//
//   ffmpeg and ffprobe are found on `PATH`, Playwright is the repository's own;
//   Agent-kit takes no dependency on either. The raw `webm` recordings stay in
//   `working_dir`, and are never the row's evidence.
//
// CLI (run from the repository root)
//   node mp4.mjs build <s<n>-storyboard.json> [--out <file.mp4>]
//
//   Exit 0: the MP4 was written. Exit 1: refused (the privacy check, a problem
//   in the files, a variable not given); no MP4 written.
//   Exit 2: usage, no ffmpeg or ffprobe on `PATH`, no Playwright with Chromium,
//   no recording of a Session on After, or ffmpeg did not build it: no MP4, the row
//   keeps its Storyboard, and `reason` is what its note says. Stdout is a JSON
//   summary.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findPlaywright, onPath } from "./adapter.mjs";
import {
  NO_CHROMIUM,
  bandHtml,
  escapeHtml,
  knownFromEnv,
  layout,
  loadScenario,
  pageHtml,
  privacyCheck,
  renderPages,
  shownFields,
  withholdRefused,
} from "./storyboard.mjs";

/** How long each side holds on each step's frame, in seconds of the MP4. */
export const HOLD_SECONDS = 2;
/** The speed each side plays at between two steps: 0.5 is half speed. */
export const BETWEEN_SPEED = 0.5;
/** Frames per second of the MP4; every piece is a whole number of frames. */
export const FPS = 25;
/** The size each side's recording is scaled to: the 1280×720 viewport at three quarters. */
export const SIDE = Object.freeze({ width: 960, height: 540 });

export const NO_FFMPEG = "no MP4: no ffmpeg with ffprobe on PATH; the row keeps its Storyboard";
export const NO_CHROMIUM_MP4 =
  "no MP4: no Playwright with Chromium in this repository, so no band or captions to overlay";

const SCENARIO = /^S\d+$/;
/** The recording names `web.mjs` writes: a plain file name, so nothing outside its folder is read. */
const VIDEO_NAME = /^video-[a-z]\.webm$/;
/** A start time with its zone: ISO 8601, to the millisecond at most, `Z` or an offset. */
const STARTED_AT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
const BEFORE_UNSEEN = ["not run", "not observed"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Seconds rounded to whole frames. */
const frames = (seconds) => Math.round(seconds * FPS) / FPS;
const tenths = (ms) => (ms / 1000).toFixed(1);

// ── The timing line ─────────────────────────────────────────────────────────

/**
 * A wall-clock time in a start time's own zone, to the second: `10:04:15 UTC+11:00`.
 * Whole seconds only: `startedAt` is the runner's note of when it started
 * `web.mjs`, which counts `atMs` from its own start a moment later, so the
 * wall clock is as close as that start-up and no closer. The time since the
 * side started and the difference from Before are exact. The machine's zone
 * plays no part.
 * @param {string} startedAt ISO 8601 with `Z` or an offset
 * @param {number} atMs milliseconds after it
 */
export function wallClock(startedAt, atMs) {
  const zone = /(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(startedAt);
  if (!zone || !STARTED_AT.test(startedAt)) throw new Error(`not a start time: ${startedAt}`);
  const offsetMin = zone[1] ? (zone[1] === "-" ? -1 : 1) * (+zone[2] * 60 + +zone[3]) : 0;
  const local = Math.floor((Date.parse(startedAt) + atMs + offsetMin * 60_000) / 1000) * 1000;
  const d = new Date(local);
  const two = (n) => String(n).padStart(2, "0");
  const clock = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
  return `${clock} ${offsetMin === 0 ? "UTC" : `UTC${zone[1]}${zone[2]}:${zone[3]}`}`;
}

/**
 * The line under a step's caption: its wall-clock time with the zone, the time
 * since its side started (`atMs`, which `web.mjs` counts from its own start),
 * and on After its difference from Before's same step: `After +1.3 s`.
 * @param {{side: "Before" | "After", startedAt: string, atMs: number, beforeAtMs?: number | null}} step
 */
export function timingLine({ side, startedAt, atMs, beforeAtMs = null }) {
  const parts = [wallClock(startedAt, atMs), `${tenths(atMs)} s since ${side} started`];
  if (side === "After" && Number.isFinite(beforeAtMs)) {
    const ms = atMs - /** @type {number} */ (beforeAtMs);
    // Rounded half away from zero, so a lead and a lag of the same size read the same.
    const diff = Math.round(Math.abs(ms) / 100);
    parts.push(`After ${ms < 0 && diff ? "-" : "+"}${(diff / 10).toFixed(1)} s`);
  }
  return parts.join(" · ");
}

// ── The timeline ────────────────────────────────────────────────────────────

/** A side's recording of a Session, by the name `web.mjs` gives it, or null. */
function videoOf(file, session) {
  const name = file?.sessions?.[session]?.video;
  return typeof name === "string" && VIDEO_NAME.test(name) ? name : null;
}

/** When a side's recording of a Session began, in `atMs` terms: 0 when not given. */
function startOf(file, session) {
  const ms = file?.sessions?.[session]?.startedAtMs;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The Scenes: After's steps in order, a new Scene at each Cut, where a step's
 * Session is not the previous step's. A single-session scenario is one Scene.
 * @param {any[]} afterSteps
 */
function scenesOf(afterSteps) {
  const scenes = [];
  for (const step of afterSteps) {
    const last = scenes.at(-1);
    if (last && last.session === step.session) last.steps.push(step.index);
    else scenes.push({ number: scenes.length + 1, session: step.session, steps: [step.index] });
  }
  return scenes;
}

/**
 * Whether Before plays beside After, and why not: Before ran and has a
 * recording of at least one Session shown, named in its step file and, by
 * `recorded`, there on disk. `missing` lists the Sessions it has none of.
 * @param {(side: "Before" | "After", name: string) => boolean} recorded
 * @returns {{two: boolean, note: string | null, missing: Set<string>}}
 */
function beforePlays(meta, raw, sessions, recorded) {
  const before = isObject(meta.before) ? meta.before : null;
  const none = (note) => ({ two: false, note, missing: new Set(sessions) });
  if (!before) return none("Before: not run, a feature scenario runs After only");
  if (BEFORE_UNSEEN.includes(before.state))
    return none(`Before ${before.state}: ${before.observed}`);
  const missing = new Set(
    sessions.filter((session) => {
      const name = videoOf(raw.before, session);
      return !name || !recorded("Before", name);
    }),
  );
  if (missing.size < sessions.length) return { two: true, note: null, missing };
  return none(
    `Before: no recording of Session${sessions.length > 1 ? "s" : ""} ${sessions.join(", ")}`,
  );
}

/** The Sessions After's steps show, in the order they first appear. */
const sessionsOf = (records) => [...new Set(records.after.map((r) => r.session))];

/**
 * Whether a Session's first Scene opens on its recording's start: a role's
 * or a signed-out Session's does, so its sign-in plays (ADR 0020). A
 * Scenario account's, or one the run context does not say, opens on its
 * first step: its values never go into the evidence.
 */
function opensAtStart(meta, session) {
  const sessions = isObject(meta.context) ? meta.context.sessions : null;
  const entry = Array.isArray(sessions) ? sessions.find((s) => s?.session === session) : null;
  return entry?.kind === "role" || entry?.kind === "nobody";
}

/**
 * What the MP4 shows, from the saved files: pure data, so it is tested
 * without ffmpeg and is the same on every re-build.
 *
 * The steps play in After's order across Sessions, split into Scenes at each
 * Cut; each side switches to the Scene's Session there, so Before and After
 * Cut together, paired by index and Session. A step's time in its recording
 * is its `atMs` less its Session's `startedAtMs`. Each Scene plays its
 * Session's recording from a window's start to each of its steps in turn,
 * the stretch at `BETWEEN_SPEED`, then held for `HOLD_SECONDS`; a stretch
 * lasts as long as the longer side's, the shorter side waiting on its step's
 * frame. A Session's first Scene starts at its recording's start for a role
 * (its sign-in plays) and at its first step for a Scenario account; a later
 * Scene starts at the previous step's time, so the Session's idle time while
 * another acted is not replayed. Nothing of a Session plays before its first
 * Scene. `proves` only says which step is highlighted.
 *
 * @param {{after: any[], before: any[] | null}} records
 * @param {any} meta the scenario file
 * @param {{after: any, before: any}} raw the step files as read (their `sessions`)
 * @param {{recorded?: (side: "Before" | "After", name: string) => boolean}} [options]
 *   whether a side's recording is on disk (`main` looks; every recording counts as there by default)
 * @returns {{sessions: string[], scenes: Scene[], sides: Side[], beforeNote: string | null,
 *   pieces: {kind: "hold" | "between", index: number, session: string, scene: number, seconds: number}[],
 *   seconds: number}}
 *
 * @typedef {{number: number, session: string, steps: number[], beforeNote: string | null}} Scene
 *   `beforeNote`: why Before shows the no-recording frame in this Scene, or null
 * @typedef {{side: "Before" | "After", startedAt: string, videos: Record<string, string>,
 *   steps: {index: number, session: string, scene: number, recorded: boolean, caption: string,
 *     atMs: number | null, at: number, from: number}[],
 *   overlays: {field: string, heading: string, caption: string, timing: string, proves: boolean}[]}} Side
 *   `at`: the step's time in its Session's recording, in seconds; `from`: where its stretch starts;
 *   `recorded`: whether this side plays the Session's recording here (else the no-recording frame)
 */
export function timeline(records, meta, raw, { recorded = () => true } = {}) {
  const afterSteps = records.after;
  if (!afterSteps.length) throw new Error("After has no steps to show");
  const sessions = sessionsOf(records);
  const plays = beforePlays(meta, raw, sessions, recorded);
  const scenes = scenesOf(afterSteps).map((c) => ({
    ...c,
    beforeNote:
      plays.two && plays.missing.has(c.session)
        ? `Before: no recording of Session ${c.session}`
        : null,
  }));
  const sceneOf = new Map(scenes.flatMap((c) => c.steps.map((i) => [`${c.session}:${i}`, c])));
  const key = (r) => `${r.session}:${r.index}`;
  const last = afterSteps.at(-1);
  const proves = meta.proves ?? { session: last.session, index: last.index };
  const proving = (a) => a.session === proves.session && a.index === proves.index;
  const before = isObject(meta.before) ? meta.before : null;
  const beforeBy = new Map((plays.two ? (records.before ?? []) : []).map((r) => [key(r), r]));
  const n = afterSteps.length;

  const side = (name, file, startedAt, pick, has) => {
    const time = (record) => (record.atMs - startOf(file, record.session)) / 1000;
    /** Each Session's place in its recording, once its first Scene has started. */
    const place = new Map();
    /** The previous step's `atMs` this side reached, in any Session. */
    let prevAtMs = null;
    const steps = afterSteps.map((a, k) => {
      const scene = /** @type {Scene} */ (sceneOf.get(key(a)));
      const record = pick(a);
      const first = !place.has(a.session);
      let from;
      if (first) {
        // A role's first Scene from its recording's start; a Scenario account's at its
        // first step this side reached, so no stretch before it plays its sign-in.
        const reached = afterSteps
          .slice(k)
          .filter((b) => sceneOf.get(key(b)) === scene)
          .map(pick)
          .find(Boolean);
        const start = startOf(file, a.session);
        from = opensAtStart(meta, a.session)
          ? 0
          : Math.max(reached ? time(reached) : ((prevAtMs ?? start) - start) / 1000, 0);
      } else {
        from = /** @type {number} */ (place.get(a.session));
        // A later Scene from the previous step's time, never back past where the Session was.
        if (scene.steps[0] === a.index && prevAtMs !== null)
          from = Math.max((prevAtMs - startOf(file, a.session)) / 1000, from);
      }
      // A step this side lacks takes no time: it waits where it was.
      const at = record ? Math.max(time(record), from) : from;
      place.set(a.session, at);
      const prev = prevAtMs;
      if (record) prevAtMs = record.atMs;
      return {
        index: a.index,
        session: a.session,
        scene: scene.number,
        recorded: has(a.session),
        caption: record ? record.caption : `No ${name} step ${a.index}`,
        atMs: record ? record.atMs : null,
        at,
        from,
        // Where its stretch starts, for its line: the recording's start, or the previous step.
        fromStart: first && opensAtStart(meta, a.session),
        prev: k ? { index: afterSteps[k - 1].index, atMs: prev } : null,
      };
    });
    const videos = Object.fromEntries(
      sessions.filter(has).map((s) => [s, /** @type {string} */ (videoOf(file, s))]),
    );
    return { side: name, file, startedAt, videos, steps };
  };

  const sidesRaw = [
    ...(plays.two
      ? [
          side(
            "Before",
            raw.before,
            before.startedAt,
            (a) => beforeBy.get(key(a)),
            (s) => !plays.missing.has(s),
          ),
        ]
      : []),
    side(
      "After",
      raw.after,
      meta.after.startedAt,
      (a) => a,
      () => true,
    ),
  ];

  const pieces = [];
  afterSteps.forEach((a, k) => {
    const stretch = Math.max(
      ...sidesRaw.map((s) => (s.steps[k].recorded ? s.steps[k].at - s.steps[k].from : 0)),
    );
    const scene = sceneOf.get(key(a)).number;
    const seconds = frames(stretch / BETWEEN_SPEED);
    if (seconds > 0)
      pieces.push({ kind: "between", index: a.index, session: a.session, scene, seconds });
    pieces.push({
      kind: "hold",
      index: a.index,
      session: a.session,
      scene,
      seconds: frames(HOLD_SECONDS),
    });
  });

  const sides = sidesRaw.map(({ side: name, file, startedAt, videos, steps }) => {
    const overlays = pieces.map((piece) => {
      const k = afterSteps.findIndex((a) => a.index === piece.index && a.session === piece.session);
      const s = steps[k];
      const where = `${name} step ${s.index} (${s.session})`;
      const heading = `${name} · ${piece.kind === "between" ? "on to " : ""}step ${s.index} of ${n}, Session ${s.session}`;
      const unrecorded = `no recording of Session ${s.session} on ${name}`;
      if (piece.kind === "between") {
        const fromLabel = s.fromStart
          ? `the start of Session ${s.session}'s recording (${tenths(startOf(file, s.session))} s)`
          : `step ${s.prev.index}${s.prev.atMs !== null ? ` (${tenths(s.prev.atMs)} s)` : ""}`;
        return {
          field: `${where}: MP4 lead-in`,
          heading,
          caption: s.caption,
          timing: !s.recorded
            ? unrecorded
            : `played at ${BETWEEN_SPEED}× speed from ${fromLabel}` +
              (s.atMs !== null
                ? ` to step ${s.index} (${tenths(s.atMs)} s since ${name} started)`
                : ""),
          proves: false,
        };
      }
      const paired = beforeBy.get(key(afterSteps[k]));
      return {
        field: `${where}: MP4 timing line`,
        heading,
        caption: s.caption,
        timing: !s.recorded
          ? unrecorded
          : s.atMs === null
            ? "not reached on this side"
            : timingLine({
                side: name,
                startedAt,
                atMs: s.atMs,
                beforeAtMs: name === "After" && paired ? paired.atMs : null,
              }),
        proves: proving(afterSteps[k]),
      };
    });
    return {
      side: name,
      startedAt,
      videos,
      steps: steps.map(({ fromStart, prev, ...s }) => s),
      overlays,
    };
  });
  const seconds = frames(pieces.reduce((sum, p) => sum + p.seconds, 0));
  return { sessions, scenes, sides, beforeNote: plays.note, pieces, seconds };
}

/**
 * The texts the MP4 adds over what the Storyboard shows: each overlay's
 * heading and timing line, and each note on Before. Its captions are the
 * step records', which the Storyboard's fields already hold.
 * @param {ReturnType<typeof timeline>} laid
 */
export function overlayFields(laid) {
  const fields = laid.sides.flatMap((s) =>
    s.overlays.flatMap((o) => [
      { field: `${o.field} (heading)`, text: o.heading },
      { field: o.field, text: o.timing },
    ]),
  );
  if (laid.beforeNote) fields.push({ field: "MP4 Before note", text: laid.beforeNote });
  for (const c of laid.scenes)
    if (c.beforeNote)
      fields.push({ field: `MP4 Before note, Scene ${c.number}`, text: c.beforeNote });
  return fields;
}

/** The notes on Before the summary gives: the one for the MP4, or each Scene's. */
function notesOf(laid) {
  if (laid.beforeNote) return laid.beforeNote;
  const each = laid.scenes.filter((c) => c.beforeNote);
  return each.length ? each.map((c) => `Scene ${c.number}: ${c.beforeNote}`).join("; ") : null;
}

// ── Overlay pages ───────────────────────────────────────────────────────────

/**
 * The pages each overlay image is rendered from, in the Storyboard's style:
 * the band for each Scene, with its note on Before; each side's caption for
 * each piece; and on Before the no-recording frame for each Scene it lacks.
 * @returns {{kind: "band" | "caption" | "frame", scene?: number, html: string, width: number, height: number}[]}
 */
export function overlayPages(laid, meta, records) {
  const width = SIDE.width * laid.sides.length;
  const failed = meta.result.startsWith("FAIL");
  const style = { cellWidth: SIDE.width - 32, failed };
  const band = layout(records, meta).band;
  const noteHtml = (note) =>
    note
      ? `<div class="meta" style="padding:0 24px 12px;margin:0;background:#f6f7f9">${escapeHtml(note)}</div>`
      : "";
  const pages = laid.scenes.map((c) => ({
    kind: /** @type {const} */ ("band"),
    scene: c.number,
    html: pageHtml(`${bandHtml(band)}${noteHtml(laid.beforeNote ?? c.beforeNote)}`, {
      pageWidth: width,
      ...style,
    }),
    width,
    height: 1,
  }));
  for (const s of laid.sides)
    for (const o of s.overlays)
      pages.push({
        kind: "caption",
        width: SIDE.width,
        height: 1,
        html: pageHtml(
          `<div${o.proves ? ' class="row proves"' : ""} style="display:block;padding:8px 16px 12px">` +
            `<div class="meta" style="margin:0;font-weight:600">${escapeHtml(o.heading)}</div>` +
            `<div class="caption" style="font-size:16px">${escapeHtml(o.caption)}</div>` +
            `<div class="meta" style="margin-top:2px">${escapeHtml(o.timing)}</div>` +
            (o.proves ? `<div class="proves-label">Proves the result</div>` : "") +
            `</div>`,
          { pageWidth: SIDE.width, ...style },
        ),
      });
  for (const c of laid.scenes)
    if (c.beforeNote)
      pages.push({
        kind: "frame",
        scene: c.number,
        width: SIDE.width,
        height: SIDE.height,
        html: pageHtml(
          `<div class="frame empty" style="width:${SIDE.width}px;height:${SIDE.height}px">${escapeHtml(c.beforeNote)}</div>`,
          { pageWidth: SIDE.width, ...style },
        ),
      });
  return pages;
}

/** A PNG's width and height, from its IHDR chunk. @param {Buffer} png */
function pngSize(png) {
  if (png.subarray(1, 4).toString() !== "PNG") throw new Error("an overlay is not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const even = (n) => Math.ceil(n / 2) * 2;

// ── ffmpeg ──────────────────────────────────────────────────────────────────

/**
 * The ffmpeg arguments that build the MP4: pure, from the timeline, each
 * recording's length, and the overlay images already rendered.
 * @param {ReturnType<typeof timeline>} laid
 * @param {{videos: Record<string, string>[], durations: Record<string, number>[],
 *   bands: {file: string, height: number}[], captions: {file: string, height: number}[][],
 *   frames: Record<number, {file: string}>, encoder: string, out: string}} files
 *   `videos` and `durations` are per side, in `laid.sides` order, by Session; `bands` per
 *   Scene; `captions` per side and piece; `frames` Before's no-recording frame, by Scene number
 */
export function ffmpegArgs(
  laid,
  { videos, durations, bands, captions, frames: shown, encoder, out },
) {
  const width = SIDE.width * laid.sides.length;
  const captionHeight = even(Math.max(...captions.flat().map((c) => c.height)));
  const bandHeight = even(Math.max(...bands.map((b) => b.height)));
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const filters = [];
  let input = 0;
  const image = (file, seconds) => {
    args.push("-loop", "1", "-framerate", String(FPS), "-t", seconds.toFixed(3), "-i", file);
    return input++;
  };
  const still = (pad, h) =>
    `fps=${FPS},scale=${pad}:-1,pad=${pad}:${h}:0:0:white,setsar=1,format=yuv420p`;
  const sceneSeconds = (number) =>
    frames(laid.pieces.filter((p) => p.scene === number).reduce((sum, p) => sum + p.seconds, 0));

  // The band: one image per Scene, each with that Scene's note on Before.
  const bandParts = laid.scenes.map((c, j) => {
    const seconds = sceneSeconds(c.number);
    const at = image(bands[j].file, seconds);
    filters.push(
      `[${at}:v]${still(width, bandHeight)},trim=duration=${seconds},setpts=PTS-STARTPTS[b${j}]`,
    );
    return `[b${j}]`;
  });
  filters.push(`${bandParts.join("")}concat=n=${bandParts.length}:v=1:a=0[band]`);

  laid.sides.forEach((s, i) => {
    const tag = `s${i}`;
    const chunks = [];
    for (const c of laid.scenes) {
      const first = s.steps.findIndex((step) => step.scene === c.number);
      if (!s.steps[first].recorded) {
        // No recording of the Scene's Session on this side: its frame, for the whole Scene.
        const seconds = sceneSeconds(c.number);
        const at = image(shown[c.number].file, seconds);
        filters.push(
          `[${at}:v]fps=${FPS},scale=${SIDE.width}:${SIDE.height}:force_original_aspect_ratio=decrease,` +
            `pad=${SIDE.width}:${SIDE.height}:0:0:white,setsar=1,format=yuv420p,` +
            `trim=duration=${seconds},setpts=PTS-STARTPTS[${tag}f${c.number}]`,
        );
        chunks.push(`[${tag}f${c.number}]`);
        continue;
      }
      const video = videos[i][c.session];
      const last = Math.max(durations[i][c.session] - 2 / FPS, 0);
      const clamp = (t) => Math.min(Math.max(t, 0), last);
      // The recording: one piece per step, its stretch with its hold, each its own input.
      s.steps.forEach((step, k) => {
        if (step.scene !== c.number) return;
        const between = laid.pieces.find(
          (p) => p.kind === "between" && p.index === step.index && p.session === step.session,
        );
        const seconds = frames((between?.seconds ?? 0) + HOLD_SECONDS);
        const from = clamp(step.from);
        const length = Math.max(clamp(step.at) - from, 2 / FPS);
        args.push("-ss", from.toFixed(3), "-t", length.toFixed(3), "-i", video);
        const at = input++;
        filters.push(
          `[${at}:v]setpts=(PTS-STARTPTS)/${BETWEEN_SPEED},fps=${FPS},` +
            `scale=${SIDE.width}:${SIDE.height},setsar=1,format=yuv420p,` +
            `tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds},setpts=PTS-STARTPTS[${tag}v${k}]`,
        );
        chunks.push(`[${tag}v${k}]`);
      });
    }
    filters.push(`${chunks.join("")}concat=n=${chunks.length}:v=1:a=0[${tag}v]`);
    // The captions: one image per piece, in the same order as the pieces.
    const parts = laid.pieces.map((piece, j) => {
      const at = image(captions[i][j].file, piece.seconds);
      filters.push(
        `[${at}:v]${still(SIDE.width, captionHeight)},trim=duration=${piece.seconds},setpts=PTS-STARTPTS[${tag}c${j}]`,
      );
      return `[${tag}c${j}]`;
    });
    filters.push(`${parts.join("")}concat=n=${parts.length}:v=1:a=0[${tag}c]`);
    filters.push(`[${tag}v][${tag}c]vstack=inputs=2[${tag}]`);
  });
  const sides = laid.sides.map((_, i) => `[s${i}]`).join("");
  filters.push(
    laid.sides.length === 2 ? `${sides}hstack=inputs=2[sides]` : `${sides}null[sides]`,
    `[band][sides]vstack=inputs=2,format=yuv420p[out]`,
  );
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-an", "-r", String(FPS));
  args.push(
    ...(encoder === "libx264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]
      : ["-c:v", "mpeg4", "-q:v", "4"]),
  );
  args.push("-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", out);
  return args;
}

/** A recording's length in seconds, from ffprobe: the container's, else its last frame's time. */
function probeSeconds(run, file) {
  const format = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const seconds = Number.parseFloat(format.stdout);
  if (format.status === 0 && Number.isFinite(seconds) && seconds > 0) return seconds;
  const packets = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
    file,
  ]);
  const times = String(packets.stdout).split(/\s+/).map(Number.parseFloat).filter(Number.isFinite);
  if (packets.status !== 0 || !times.length)
    throw new Error(`ffprobe could not read ${basename(file)}`);
  return Math.max(...times);
}

const spawn = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.error ? -1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? String(result.error.message) : (result.stderr ?? ""),
  };
};

// ── The scenario file's start times ─────────────────────────────────────────

/** Problems with the start times the timing line reads, each naming its field. */
function checkStartTimes(meta, two) {
  const problems = [];
  const check = (value, where) => {
    if (typeof value !== "string" || !STARTED_AT.test(value) || Number.isNaN(Date.parse(value)))
      problems.push(
        `${where} is not the time ${where.split(".")[0]}'s web.mjs run started, ISO 8601 with its zone ` +
          "(2026-11-16T10:04:12.000+11:00, or Z): the MP4's timing line needs it",
      );
  };
  check(meta.after?.startedAt, "after.startedAt");
  if (two) check(meta.before?.startedAt, "before.startedAt");
  return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = "usage: node mp4.mjs build <s<n>-storyboard.json> [--out <file.mp4>]\n";

/**
 * @param {string[]} argv the arguments after the script
 * @param {{env?: Record<string, string | undefined>, cwd?: string,
 *   renderer?: (pages: {html: string, width: number, height?: number}[]) => Promise<Buffer[]>,
 *   run?: (command: string, args: string[]) => {status: number | null, stdout: string, stderr: string}}} [io]
 *   `renderer` turns overlay pages into PNG bytes (a seam for tests; Chromium's by default);
 *   `run` runs ffmpeg and ffprobe (found on `env.PATH`)
 * @returns {Promise<{code: number, out: string}>}
 */
export async function main(argv, io = {}) {
  const usage = { code: 2, out: USAGE };
  const [command, target, ...rest] = argv;
  if (command !== "build" || target === undefined || target.startsWith("--")) return usage;
  let out;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--out" && rest[i + 1] !== undefined && out === undefined) out = rest[++i];
    else return usage;
  }
  if (out !== undefined && !out.endsWith(".mp4")) return usage;
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const env = io.env ?? process.env;
  const run = io.run ?? spawn;

  const loaded = loadScenario(target);
  const { meta, records } = loaded;
  // Known before any check, so every refusal removes an older MP4 at its path:
  // one left from an earlier run would show what this run no longer says.
  const named = typeof meta?.scenario === "string" && SCENARIO.test(meta.scenario);
  const mp4 =
    out !== undefined || named
      ? resolve(out ?? join(dirname(resolve(target)), `${meta.scenario.toLowerCase()}.mp4`))
      : null;
  const none = (code, body) => {
    if (mp4) rmSync(mp4, { force: true });
    return { code, out: json({ written: false, ...body }) };
  };
  // Without ffmpeg there is no MP4 to check or refuse: the row keeps its Storyboard.
  if (!onPath("ffmpeg", env) || !onPath("ffprobe", env)) return none(2, { reason: NO_FFMPEG });
  if (loaded.problems.length) return none(1, { problems: loaded.problems });
  const unset = (meta.variables ?? []).filter((name) => !env[name]);
  if (unset.length)
    return none(1, {
      problems: unset.map(
        (name) => `${name} is not set: give each variable the run used as this command's own`,
      ),
    });

  const dirs = { Before: loaded.records.beforeDir, After: loaded.records.afterDir };
  const recorded = (side, name) => Boolean(dirs[side]) && existsSync(join(dirs[side], name));
  const { two } = beforePlays(meta, loaded.raw, sessionsOf(records), recorded);
  const times = checkStartTimes(meta, two);
  if (times.length) return none(1, { problems: times });
  let laid;
  try {
    layout(records, meta); // the Storyboard's own checks: `proves` names an After step
    laid = timeline(records, meta, loaded.raw, { recorded });
  } catch (error) {
    return none(1, { problems: [String(error.message)] });
  }

  // The privacy check comes before anything is drawn: the Storyboard's fields, and the MP4's own.
  const fields = shownFields(records, meta);
  const refused = privacyCheck(
    [...fields, ...overlayFields(laid)],
    knownFromEnv(env, meta.variables),
  );
  if (refused.length) {
    withholdRefused(loaded, fields, refused);
    return none(1, { refused });
  }

  // Before plays a Session only with its recording there, so only After can lack one here.
  const after = /** @type {Side} */ (laid.sides.at(-1));
  const lacking = laid.sessions.find(
    (session) => !after.videos[session] || !existsSync(join(dirs.After, after.videos[session])),
  );
  if (lacking)
    return none(2, {
      reason:
        `no MP4: no recording of Session ${lacking} on After ` +
        "(web.mjs ran without --video, or its file is gone); the row keeps its Storyboard",
    });
  const videos = laid.sides.map((s) =>
    Object.fromEntries(
      Object.entries(s.videos).map(([session, name]) => [session, join(dirs[s.side], name)]),
    ),
  );

  let renderer = io.renderer;
  if (!renderer) {
    const found = findPlaywright(io.cwd ?? process.cwd());
    if (!found.chromium) return none(2, { reason: NO_CHROMIUM_MP4 });
    renderer = (pages) => renderPages(pages, { playwright: found.module });
  }

  const work = mkdtempSync(join(tmpdir(), "qa-mp4-"));
  // Built beside its place, then moved in, so a failed build leaves nothing behind.
  const partial = join(
    dirname(/** @type {string} */ (mp4)),
    `.${basename(/** @type {string} */ (mp4))}.partial`,
  );
  const failed = (why) => {
    rmSync(partial, { force: true });
    return none(2, { reason: `no MP4: ${why}; the row keeps its Storyboard` });
  };
  try {
    const durations = videos.map((bySession) =>
      Object.fromEntries(
        Object.entries(bySession).map(([session, file]) => [session, probeSeconds(run, file)]),
      ),
    );
    const pages = overlayPages(laid, meta, records);
    let pngs;
    try {
      pngs = await renderer(pages);
    } catch (error) {
      return failed(`Chromium did not render its overlays (${firstLine(error)})`);
    }
    const files = pngs.map((png, i) => {
      const file = join(work, `overlay-${i}.png`);
      writeFileSync(file, png);
      return { file, height: pngSize(png).height, page: pages[i] };
    });
    const bands = files.filter((f) => f.page.kind === "band");
    const rest = files.filter((f) => f.page.kind === "caption");
    const per = laid.pieces.length;
    const captions = laid.sides.map((_, i) => rest.slice(i * per, (i + 1) * per));
    const frameFiles = Object.fromEntries(
      files.filter((f) => f.page.kind === "frame").map((f) => [f.page.scene, f]),
    );
    const encoders = run("ffmpeg", ["-hide_banner", "-encoders"]);
    if (encoders.status !== 0) return failed(`ffmpeg did not run (${firstLine(encoders.stderr)})`);
    const encoder = /\blibx264\b/.test(encoders.stdout) ? "libx264" : "mpeg4";
    const built = run(
      "ffmpeg",
      ffmpegArgs(laid, {
        videos,
        durations,
        bands,
        captions,
        frames: frameFiles,
        encoder,
        out: partial,
      }),
    );
    if (built.status !== 0 || !existsSync(partial))
      return failed(`ffmpeg did not build it (${firstLine(built.stderr)})`);
    renameSync(partial, /** @type {string} */ (mp4));
  } catch (error) {
    return failed(firstLine(error));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return {
    code: 0,
    out: json({
      written: true,
      mp4: out ?? join(dirname(target), basename(/** @type {string} */ (mp4))),
      session: laid.sessions,
      sides: laid.sides.map((s) => s.side),
      steps: laid.sides[0].steps.length,
      seconds: laid.seconds,
      ...(notesOf(laid) ? { note: notesOf(laid) } : {}),
    }),
  };
}

const firstLine = (error) =>
  String(error?.message ?? error)
    .trim()
    .split("\n")[0]
    .slice(0, 300);

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(process.argv[1])) {
  const { code, out } = await main(process.argv.slice(2));
  process.stdout.write(out);
  process.exitCode = code;
}
