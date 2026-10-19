# AGENTS.md: Window Recorder

A guide for coding agents (and humans) working on this repo. Read this before changing capture, audio or packaging code: most of the non-obvious decisions below exist because the obvious approach failed in practice.

## What it is

A macOS-only Electron app that records one **window** or one **screen** to MP4, plus:

- **per-app audio**: only the recorded window's app, via a Core Audio process tap in a bundled Swift helper,
- an optional **mute while recording** for that app only,
- optional **mic** mixed in,
- a live **waveform + latest frame** view,
- a **Recordings** library with an in-app player.

Target: macOS 14.2+ on arm64. Developed and tested on macOS 26 with Electron 44.

## Layout

```
src/main.js          Main process: window, display-media handler, IPC, streaming file writes,
                     wr-audiotap child process, wr-media:// protocol, settings, quit/close guards
src/preload.js       contextBridge → window.recorder.* (the whole renderer↔main API)
src/renderer.js      All UI logic (classic script; globals are intentional, see Testing)
src/tap-worklet.js   AudioWorklet that plays raw PCM from the helper into the Web Audio graph
src/index.html       Markup: Record pane (picker / recording / done) + Library pane (grid / player)
src/styles.css       Dark theme; note the global `[hidden] { display: none !important }`
native/audiotap.swift  wr-audiotap: Core Audio process tap → raw PCM on stdout
build/               Icon sources (icon.svg → icon.png/.icns via `npm run icon`),
                     extend-info.plist (Info.plist usage strings), wr-audiotap (compiled, gitignored)
scripts/cdp.mjs      Drives a running app over DevTools Protocol for UI checks
```

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Compile the helper, run in dev (`electron .`). Dev runs have **no** Screen Recording permission unless your terminal has it. |
| `npm run build:native` | `swiftc` → `build/wr-audiotap` |
| `npm run package` | Helper + `electron-packager` → `dist/Window Recorder-darwin-arm64/Window Recorder.app` (helper goes to `Contents/Resources/wr-audiotap`) |
| `npm run install:desktop` | `package`, then copy the app to `~/Desktop` |
| `npm run icon` | Re-render `build/icon.svg` with Chromium → `icon.png` + `icon.icns` |
| `npm run ui-check -- <port> <steps.json>` | See Testing |

**`npm config get ignore-scripts` is `true` on the original dev machine**, so npm `pre*`/`post*` hooks never run. Chain steps explicitly with `&&` inside a script (as `package` and `install:desktop` do); don't add `postpackage`-style hooks.

## Architecture

### Picking a source

`get-windows` calls `desktopCapturer.getSources({ types: ['screen', 'window'] })`, caches the returned `DesktopCapturerSource` objects in `knownSources` (main), and sends serializable copies to the renderer with `kind: 'screen' | 'window'`. The renderer re-lists every 4 s and on window focus while the picker is visible.

When recording starts, the renderer calls `select-source(id, audioMode)`, which sets `selectedSource = knownSources.get(id)`, then calls `navigator.mediaDevices.getDisplayMedia()`. Main's `setDisplayMediaRequestHandler` answers with `{ video: selectedSource, audio: 'loopback' | undefined }`.

> **Pitfall: never re-query `getSources()` inside the display-media handler.** A second call can come back without the window the user just picked (this happened reliably with Zoom). The handler then has nothing to return and Chromium rejects with the misleading `AbortError: Invalid capture constraints`. Always reuse the cached source object.

> **Pitfall: Spaces and full screen.** Chromium only lists windows on the **current** Space. A full-screen app (its own Space) or a window on another desktop is missing from the list. That's why the UI has a **Screens** section; don't try to "fix" the window list.

### Audio paths

| Source | Audio mode | How |
| --- | --- | --- |
| Window, Audio on | **Per-app tap** (preferred) | `start-app-audio(mute)` spawns `wr-audiotap --window <CGWindowID> [--mute]`; PCM flows main → renderer → `AudioWorkletNode('pcm-player')` |
| Window, tap failed | System loopback (fallback) | `getDisplayMedia` with `audio: 'loopback'`; status line explains the fallback; mute is not possible |
| Screen, Audio on | System loopback | Same as above |
| Audio off | None | Video only |
| + Microphone | Mixed in | `getUserMedia` track added to the same mix |

Everything audible is mixed in one `AudioContext` into a `MediaStreamAudioDestinationNode` (recorded) and an `AnalyserNode` (waveform). **Nothing is ever connected to `audioCtx.destination`**, so the recorder never plays audio itself. When the tap is used, the `AudioContext` is created at the helper's sample rate to avoid resampling.

> **Pitfall: `audio: 'loopbackWithMute'` mutes the whole computer**, not one app. It was tried and removed. Per-app muting needs the process tap.

System loopback on macOS needs Chromium features enabled in main.js via `enable-features`: `MacLoopbackAudioForScreenShare`, `MacCatapLoopbackAudioForScreenShare`, `MacSckSystemAudioLoopbackOverride`. Electron's typings still say loopback is Windows-only; on macOS 26 + Electron 44 it works with these flags (verified with real audio).

### wr-audiotap (native/audiotap.swift)

Protocol:
- `--window <id> --list`: print JSON `{ ownerPID, ownerBundleID, ownerName, processes[] }` and exit. Needs no permissions, so it's safe for dry runs.
- `--window <id> [--mute]`: on success the **first stderr line is JSON** `{ sampleRate, channels: 2, muted, app, processes }`, then **stdout is raw interleaved stereo Float32 PCM** until stdin closes or SIGTERM/SIGINT. On failure it prints an error to stderr and exits 1.

How it works:
1. Window → owner PID via `CGWindowListCopyWindowInfo` (works without Screen Recording permission).
2. Enumerate Core Audio process objects (`kAudioHardwarePropertyProcessObjectList`). Keep the owner PID, plus any process whose **executable path is inside the owner's `.app` bundle** (finds helpers like Zoom's `caphost`, Chrome's renderers).
   > **Pitfall: don't match by bundle-ID prefix.** Electron apps that keep the default `com.github.Electron` ID would sweep in unrelated apps. This was observed: an unrelated "Lecture Desk" app matched.
3. `CATapDescription(stereoMixdownOfProcesses:)`, private, `muteBehavior = .mutedWhenTapped` when `--mute` (silent on the speakers only while the tap is read; other apps unaffected), else `.unmuted`.
4. Private aggregate device with the tap and the default **output** device as the clock (`kAudioHardwarePropertyDefaultOutputDevice`, not the *system* (alert) output device).
5. IOProc block interleaves to stereo Float32 and writes to stdout.

The tap and aggregate device are private and die with the process, so a crash can't leave an app muted. Main forwards stdout to the renderer (`app-audio` events) in **whole 8-byte frames only** (it buffers the remainder).

Limits: muting is per **app**, not per window (Core Audio mixes per process); processes that start playing audio *after* the tap is created aren't added; Safari's audio comes from WebKit processes outside Safari.app, so it won't be captured per-app.

Permission: the first tap triggers the macOS "capture audio from other apps" prompt, attributed to the **responsible process**. Launch the app via LaunchServices (`open`) so the prompt names Window Recorder; running the helper from a terminal attributes it to the terminal.

### Writing recordings

`MediaRecorder` (prefers `video/mp4;codecs=avc1.640028,mp4a.40.2`, 8 Mbps, `timeslice` 1000 ms) → each chunk goes through a promise queue → `write-chunk` → `FileHandle.write` on a file opened by `open-recording`. `close-recording` runs after the queue drains. The output is fragmented MP4 (`ftyp`, `moov`, then `moof`/`mdat` pairs).

> **Pitfall: never accumulate chunks and save at the end.** The first version did `new Blob(chunks).arrayBuffer()` → one IPC call. That fails around 2 GB (`Array buffer allocation failed`; 1.5 GB worked in testing), and a 45-minute Zoom recording was lost to it. Chunks are now streamed to disk.

Recovery note (old builds only): Chromium pages large blobs to `~/Library/Application Support/Window Recorder/blob_storage/<uuid>/0..N`. Those files are the MediaRecorder bytes in order, so concatenating them numerically (`0` starts with `ftyp`) rebuilds a playable MP4. Copy the folder out *before* quitting the app. This is how the lost recording was recovered.

File names: `<source name> YYYY-MM-DD at HH.MM.SS.mp4` (local time), in the recordings folder.

### Background recording and quitting

- `backgroundThrottling: false`, so recording, timers and waveform sampling (a 50 ms `setInterval`, not rAF) keep running while hidden.
- The renderer reports `recording-state`. While recording, closing the window **hides** it (`app.on('activate')` re-shows it), and `before-quit` sends `stop-recording` to the renderer and quits after `recording-state(false)`.

### Library

- Settings live in `<userData>/settings.json` (`{ recordingsDir }`); default `~/Movies/Window Recorder`.
- `wr-media://rec/<file name>` is a privileged custom protocol (`stream`, `supportFetchAPI`) served by `serveRecording` with **HTTP Range support**, which `<video>` needs for seeking. `resolveRecording` only accepts a bare file name with a video extension inside the recordings folder (blocks path traversal).
- `list-recordings` marks files still being written (`recording: true`); the UI shows them as RECORDING and they can't be trashed.
- Delete = `shell.trashItem` (recoverable), with a confirm dialog.

## IPC contract (preload `window.recorder.*`)

| Bridge method | Channel | Notes |
| --- | --- | --- |
| `getWindows()` | `get-windows` | `[{ id, name, kind, thumbnail, appIcon }]`; filters out this app's own window |
| `selectSource(id, audioMode)` | `select-source` | `audioMode`: `'loopback'` or `null` |
| `permissionStatus()` | `permission-status` | `{ screen, mic }` |
| `askMic()` | `ask-mic` | |
| `openScreenSettings()` | `open-screen-settings` | |
| `openRecording(ext, name)` | `open-recording` | returns the full path |
| `writeChunk(file, buf)` | `write-chunk` | only files opened via `open-recording` |
| `closeRecording(file)` | `close-recording` | returns the path |
| `setRecording(bool)` | `recording-state` (send) | drives the close/quit guards |
| `onStopRequest(fn)` | `stop-recording` (event) | sent on quit while recording |
| `startAppAudio(mute)` | `start-app-audio` | resolves with the helper's JSON; rejects with its error |
| `stopAppAudio()` | `stop-app-audio` | |
| `onAppAudio(fn)` | `app-audio` (event) | `ArrayBuffer` of whole stereo Float32 frames |
| `listRecordings()` | `list-recordings` | `{ dir, items: [{ name, size, mtime, recording }] }` |
| `chooseFolder()` / `openFolder()` | `choose-folder` / `open-folder` | |
| `revealRecording(name)` / `trashRecording(name)` | `reveal-recording` / `trash-recording` | bare file names only |
| `reveal(path)` | `reveal` | full path (used by the done view) |

CSP in `index.html` allows `media-src 'self' blob: mediastream: wr-media:`; add sources there if you add new media origins.

## Testing

There's no unit-test suite; verification is done against the real app.

1. **Syntax**: `node --check src/*.js`.
2. **Helper dry run** (no permissions, nothing muted): `./build/wr-audiotap --window <CGWindowID> --list`.
3. **UI checks without touching a running instance**: launch an isolated, hidden dev instance and drive it over CDP:
   ```bash
   WR_HIDDEN=1 npx electron . --user-data-dir=/tmp/wr-test --remote-debugging-port=9333 &
   node scripts/cdp.mjs 9333 steps.json
   ```
   `WR_HIDDEN` hides the window and Dock icon (no focus stealing); `--user-data-dir` isolates settings, so you can point `recordingsDir` at a temp folder of ffmpeg-generated test videos. Dev instances have no Screen Recording permission, so the picker is empty. For the recording view, inject a canvas `captureStream()` and an oscillator into the renderer globals (`streams`, `analyser`, `audioCtx`, then `show('recordingView')`, `startMeters()`).
4. **End-to-end capture/mute**: needs the **packaged** app (it holds the permissions): `open -n "Window Recorder.app" --args --remote-debugging-port=9335`, then drive it with `scripts/cdp.mjs`. Use a harmless audio source with a window (e.g. a throwaway Electron window playing a tone), not a call someone is in. Check the output with `ffprobe` / `ffmpeg -af volumedetect`; whether the speakers actually went silent can only be confirmed by a person listening.

## Signing and permissions

- Builds are **ad-hoc signed** (bundle ID `com.hshi.windowrecorder`). macOS can treat a rebuild as a new app, so Screen Recording/audio prompts may reappear after `npm run package`.
- Don't rebuild or replace the installed `.app` while the user is recording: the running app loads helpers from its bundle.
- Usage strings (`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`) come from `build/extend-info.plist`.

## Conventions

- Plain JS, no bundler or framework; the renderer is a classic script so its globals stay reachable from CDP.
- Comment density: short "why" comments on non-obvious lines, as in the existing files.
- Keep all renderer↔main traffic in `preload.js`; never enable `nodeIntegration`.
