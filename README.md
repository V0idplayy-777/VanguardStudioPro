# Vanguard Studio Pro

A professional non-linear video editor that runs entirely in the browser. WebGL2 compositing, WebCodecs decode and encode, Web Audio mixing. Nothing is uploaded anywhere; your media stays on your machine.

🍔 Built under the terms of the LICENSE, hamburger requirement included.

## Run it

```
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production bundle in dist/
npm run preview    # serve the production bundle
```

Chrome or Edge 120+ is recommended (WebCodecs, File System Access). Firefox and Safari work with the browser-element decode fallback and MediaRecorder export.

## Deploy to GitHub Pages

The app is a static bundle with no server-side code and no special headers, so GitHub Pages can host it directly. The production build uses relative asset paths, which means it works from a project sub-path such as `https://<user>.github.io/VanguardStudioPro/` as well as from a domain root or a custom domain, without any repo-specific configuration.

`.github/workflows/deploy-pages.yml` builds the app and publishes `dist/` on every push to `main`. It can also be run by hand from the Actions tab via *Run workflow*.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Leaving it on *Deploy from a branch* publishes the raw source tree instead of the build; `index.html` then points at `/src/main.tsx`, which only the Vite dev server can serve, and the page stays blank.

To host somewhere else, run `npm run build` and copy `dist/` to any static file server.

## What is in the box

**Editing**
- Dockable workspace: drag tabs between groups, split, float, maximise (backtick), nine preset workspaces plus your own saved layouts.
- Timeline with unlimited video and audio tracks, insert/overwrite, three-point editing from the Source monitor, lift/extract, ripple/rolling/slip/slide/rate-stretch tools, razor, snapping, track targeting, sync lock, linked selection, grouping, nesting, gap closing, clip markers.
- **Cut to Beats**: razor every clip on the beat markers (detecting them first when needed) so edits land on the rhythm.
- **Pan & Zoom (Ken Burns)**: one click writes eased scale/position keyframes - Auto mode gives every photo a different move.
- Frame-accurate transport: J/K/L shuttle, loop, In/Out, sequence markers, chapter markers, timecode/frames/seconds display, drop-frame timecode. Playback is flicker-free: render jobs are serialized and each finished frame is presented from a private snapshot, so thumbnails, source-monitor and export renders can never blank or tear the Program Monitor. It is also smooth under load: sequential decoding fast-forwards instead of re-seeking, the next frame decodes ahead while the current one renders, thumbnails and scrubbing use a separate decode session, and the playhead glides over coarse audio clocks (long Bluetooth buffers).
- Speed/duration with reverse and pitch preservation, frame hold, time remapping with speed ramps.
- Full undo history with a browsable History panel.

**Effects and colour**
- 60+ GPU video effects (blur, sharpen, keying, distortion, stylise, generate, transitions) with keyframes, bezier easing, masks and track mattes.
- Lumetri Color: basic correction, creative looks, curves, colour wheels, HSL secondary, vignette, plus scopes (waveform, vectorscope, parade, histogram) and one-click Color Match.
- **Auto Reframe**: reframe a sequence to 9:16 / 1:1 / 4:5 / 16:9 - every clip is scaled to fill and keyframed to follow the action.
- Adjustment layers, colour mattes, bars and tone, universal counting leader.
- Effect presets, saved per browser, importable and exportable.

**Audio**
- Track mixer and clip mixer with faders, pans, mutes, solos, per-track effect inserts, master fader, true-peak and loudness meters.
- Audio effects: EQ, compressor, limiter, gate, reverb, delay, chorus, de-esser, and more. Auto-ducking writes volume keyframes under dialogue.
- Rubber-band volume and pan keyframes drawn straight on the clip.
- **Remove Silence**: detect and cut out silent spans (adaptive noise-floor threshold, adjustable padding) with the gaps rippled closed - linked audio/video cut together, one undo step.
- **Normalize Audio**: measures integrated LUFS (K-weighted, gated) per clip and trims clip gain to hit -14 LUFS.

**Graphics and captions**
- Essential Graphics: text, shapes, layer stacks, transforms with keyframes, in/out animations, a template browser.
- Captions: import SRT/WebVTT, create from a transcript, style them, export SRT/WebVTT, burn in on export.

**Media and project**
- Import by drag and drop or the Media Browser (local folders). Thumbnails, waveforms, metadata, bins, search, labels, interpret footage, scene edit detection.
- Capture straight into the project: **Record Voiceover** (microphone to an audio track at the playhead, with count-in and a live level meter while the timeline rolls), **Record Screen** and **Record Webcam** with live preview.
- **Beat detection**: analyse any music clip, drop beat markers on the timeline and cut to the rhythm - snapping locks to them automatically.
- Autosave to IndexedDB, media cache for reload, `.vsproj` project files with optional embedded media, relink missing media.

**Colour**
- **Auto Color**: one-click level and white-balance fix per clip (Lumetri panel or Clip menu) - analyses the frame and writes conservative Basic Correction values.

**Find anything**
- **Command palette** (`Ctrl+Shift+P`): fuzzy-search every command, panel, effect, asset, sequence and setting, and run it from the keyboard.

**Settings**
- Categorized, searchable settings (`Ctrl+,`): General, Appearance (scale, accent color, brightness), Timeline, Playback, Audio, Accessibility (reduce motion, high contrast, larger text, strong focus rings, disable flashing effects), Performance (thumbnails, decode cache, FPS overlay), Auto Save and Experimental (half-float pipeline, snapshot presentation, low-latency canvas). Everything applies live and persists per browser.


**Export**
- H.264, HEVC, VP9, AV1 in MP4/MOV/WebM/MKV via WebCodecs; GIF; PNG/JPEG/WebP image sequences; WAV; EDL, marker CSV, YouTube chapters, single frame export.

## Keyboard

`Ctrl+Alt+K` (or Help, Keyboard Shortcuts) lists everything. The important ones follow Premiere: `V A B N R C Y U P H Z` tools, `I O` mark, `, .` insert/overwrite, `Q W` ripple trim to playhead, `Ctrl+K` razor, `Ctrl+M` export, `Shift+E` enable/disable, `` ` `` maximise panel.

## Undocumented behaviour

There are a few. They are not listed here. Some of them do things.

## Stack

Vite, React 19, TypeScript, zustand, immer, mediabunny (container demux/mux), WebGL2, WebCodecs, Web Audio, IndexedDB. Inter Variable via `@fontsource-variable/inter`.
