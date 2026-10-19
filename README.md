# Window Recorder

A small macOS app (Electron + a Swift helper) that records **one window or one screen**, with its audio, to MP4.

- **Per-app audio.** When you record a window, only that app's audio is captured (e.g. just Zoom), not everything playing on your Mac.
- **Mute while recording.** Optionally silence that app on your speakers while it's still recorded. Other apps keep playing.
- **Screens.** Record a whole display, which is the way to capture full-screen apps.
- **Microphone.** Optionally mix your mic in.
- **Live view.** Shows the latest frame, a scrolling audio waveform, resolution, size on disk and audio source while recording.
- **Background recording.** Close the window and recording keeps going; click the Dock icon to come back. Quitting stops and saves first.
- **Recordings library.** Thumbnails, duration and size; play in-app, show in Finder, move to Trash, choose the save folder.
- **Long recordings are safe.** Video is written to disk as it records, so length is limited only by free space.

## Requirements

- macOS 14.2+ on Apple silicon (per-app audio uses Core Audio process taps). Developed on macOS 26.
- Node.js 22+ and npm
- Xcode Command Line Tools (`swiftc`) to build the audio helper

## Build and run

```bash
npm install
```

```bash
npm start
```

`npm start` compiles the Swift helper and launches the app in development. To build a standalone app:

```bash
npm run package
```

That produces `dist/Window Recorder-darwin-arm64/Window Recorder.app`. `npm run install:desktop` builds it and copies it to your Desktop.

## First run: permissions

macOS will ask for:

| Permission | Why | Where to fix it |
| --- | --- | --- |
| Screen Recording | List and capture windows/screens | System Settings → Privacy & Security → Screen & System Audio Recording. Quit and reopen the app after enabling. |
| Audio capture ("capture audio from other apps") | Per-app audio and muting | Prompted the first time you record a window with audio |
| Microphone | Only if you tick Microphone | Prompted on first use |

Rebuilt apps are ad-hoc signed, so macOS may ask again after a rebuild.

## Using it

1. **Record** tab: pick a screen or a window. Full-screen windows and windows on other desktops only appear once they're on the current desktop; to capture a full-screen app, pick its screen instead.
2. Choose **Audio**, **Mute while recording** (windows only) and **Microphone**, then press **Record**.
3. Press **Stop** or Esc. The file is in the **Recordings** tab and in `~/Movies/Window Recorder/` (changeable via **Change Folder…**).

## Notes and limits

- Muting is **per app, not per window**. macOS mixes audio per process, so muting one Zoom window mutes all of Zoom.
- When recording a **screen**, audio is all system audio and can't be muted.
- If per-app audio can't start (e.g. the app hasn't played any sound yet), recording falls back to all system audio and the status line says so.
- Files are fragmented MP4 (H.264 + AAC) at up to 8 Mbps.

## For contributors and agents

See [AGENTS.md](AGENTS.md) for the architecture, IPC contract, audio pipeline, testing approach and the pitfalls found while building this.
