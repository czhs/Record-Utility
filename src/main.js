const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, protocol, session, shell, systemPreferences } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

// wr-media://rec/<file name> serves recordings to the in-app library (with seeking).
protocol.registerSchemesAsPrivileged([
  { scheme: 'wr-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// System-audio loopback on macOS (Core Audio taps / ScreenCaptureKit) sits behind these Chromium features.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacLoopbackAudioForScreenShare,MacCatapLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'
  );
}

app.setName('Window Recorder');
if (process.env.WR_HIDDEN) app.dock?.hide(); // automated UI checks: no Dock icon, no focus change

let mainWindow;
let knownSources = new Map(); // id -> DesktopCapturerSource from the last listing
let selectedSource = null;
let audioMode = 'loopback'; // 'loopback' (all system audio) | null
let isRecording = false;
let quitAfterSave = false;
const openFiles = new Map(); // path -> FileHandle for recordings in progress
let tapProc = null; // wr-audiotap child capturing one app's audio

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    title: 'Window Recorder',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#14161a',
    show: !process.env.WR_HIDDEN, // hidden launch for automated UI checks
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep recording, timers and the waveform running at full speed while hidden.
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Closing the window mid-recording just hides it; recording carries on in the background.
  mainWindow.on('close', (e) => {
    if (isRecording && !quitAfterSave) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

app.whenReady().then(() => {
  // In dev (`npm start`) the dock shows the stock Electron icon; swap in ours.
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  if (process.platform === 'darwin' && !app.isPackaged && !process.env.WR_HIDDEN && fs.existsSync(iconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // getDisplayMedia() in the renderer lands here; hand back the source the user picked.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    // Reuse the exact source the user clicked: a fresh getSources() can come back
    // without it (e.g. Zoom windows), which made capture fail.
    const source = selectedSource;
    if (!source) return callback(null);
    callback(audioMode ? { video: source, audio: audioMode } : { video: source });
  });

  protocol.handle('wr-media', serveRecording);
  createWindow();
});

// Clicking the Dock icon brings a hidden window back.
app.on('activate', () => mainWindow?.show());

// Quitting mid-recording: stop and save first, then quit.
app.on('before-quit', (e) => {
  if (!isRecording) return;
  e.preventDefault();
  quitAfterSave = true;
  mainWindow.webContents.send('stop-recording');
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('get-windows', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
  knownSources = new Map(sources.map((s) => [s.id, s]));
  return sources
    .filter((s) => s.name && !s.name.startsWith('Window Recorder'))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('select-source', (_e, id, mode) => {
  selectedSource = knownSources.get(id) ?? null;
  audioMode = mode === 'loopback' ? 'loopback' : null;
});

ipcMain.handle('permission-status', () => {
  if (process.platform !== 'darwin') return { screen: 'granted', mic: 'granted' };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    mic: systemPreferences.getMediaAccessStatus('microphone'),
  };
});

ipcMain.handle('ask-mic', () =>
  process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true
);

ipcMain.handle('open-screen-settings', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
);

// Recordings are streamed to disk chunk by chunk, so length is limited only by disk space.
ipcMain.handle('open-recording', async (_e, ext, sourceName) => {
  const dir = recordingsDir();
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const safeName = (sourceName || 'window').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'window';
  const file = path.join(dir, `${safeName} ${stamp}.${ext === 'webm' ? 'webm' : 'mp4'}`);
  openFiles.set(file, await fs.promises.open(file, 'w'));
  return file;
});

ipcMain.handle('write-chunk', async (_e, file, buffer) => {
  const handle = openFiles.get(file);
  if (!handle) throw new Error('Recording file is not open');
  await handle.write(Buffer.from(buffer));
});

ipcMain.handle('close-recording', async (_e, file) => {
  await openFiles.get(file)?.close();
  openFiles.delete(file);
  return file;
});

ipcMain.on('recording-state', (_e, recording) => {
  isRecording = recording;
  if (!recording && quitAfterSave) app.quit();
});

ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));

// ---- Per-app audio (Core Audio process tap via the bundled wr-audiotap helper) ----

const tapBinary = app.isPackaged
  ? path.join(process.resourcesPath, 'wr-audiotap')
  : path.join(__dirname, '..', 'build', 'wr-audiotap');

function stopAppAudio() {
  if (!tapProc) return;
  tapProc.stdin.end(); // helper exits (and unmutes) when stdin closes
  tapProc.kill('SIGTERM');
  tapProc = null;
}

// Records only the selected window's app; with mute, that app goes silent on the speakers while
// we record it and everything else on the Mac keeps playing.
ipcMain.handle('start-app-audio', (e, mute) => new Promise((resolve, reject) => {
  stopAppAudio();
  const windowNumber = /^window:(\d+):/.exec(selectedSource?.id ?? '')?.[1];
  if (!windowNumber) return reject(new Error('Not a window source'));

  const proc = spawn(tapBinary, ['--window', windowNumber, ...(mute ? ['--mute'] : [])]);
  let stderr = '';
  let ready = false;
  let leftover = Buffer.alloc(0);

  proc.stderr.on('data', (d) => {
    stderr += d;
    if (ready || !stderr.includes('\n')) return;
    try {
      const info = JSON.parse(stderr.slice(0, stderr.indexOf('\n')));
      ready = true;
      tapProc = proc;
      resolve(info);
    } catch {
      // Not JSON: an error message; reported when the helper exits.
    }
  });
  proc.stdout.on('data', (chunk) => {
    // Only forward whole stereo Float32 frames (8 bytes each).
    const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = data.length - (data.length % 8);
    leftover = data.subarray(usable);
    if (usable && !e.sender.isDestroyed()) {
      e.sender.send('app-audio', data.buffer.slice(data.byteOffset, data.byteOffset + usable));
    }
  });
  proc.on('error', (err) => { if (!ready) reject(err); });
  proc.on('exit', (code) => {
    if (!ready) reject(new Error(stderr.trim() || `audio helper exited with code ${code}`));
    if (tapProc === proc) tapProc = null;
  });
}));

ipcMain.handle('stop-app-audio', () => stopAppAudio());
app.on('will-quit', stopAppAudio);

// ---- Recordings library ----

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function recordingsDir() {
  const dir = loadSettings().recordingsDir || path.join(app.getPath('videos'), 'Window Recorder');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Only plain video file names inside the recordings folder are ever served or touched.
function resolveRecording(name) {
  const base = path.basename(String(name));
  if (base !== name || !VIDEO_EXT.test(base)) throw new Error('Not a recording');
  return path.join(recordingsDir(), base);
}

async function serveRecording(request) {
  let file, size;
  try {
    file = resolveRecording(decodeURIComponent(new URL(request.url).pathname.slice(1)));
    size = (await fs.promises.stat(file)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = { 'Content-Type': file.endsWith('.webm') ? 'video/webm' : 'video/mp4', 'Accept-Ranges': 'bytes' };
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (!range || size === 0) {
    return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { ...headers, 'Content-Length': String(size) } });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
  });
}

ipcMain.handle('list-recordings', async () => {
  const dir = recordingsDir();
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const items = await Promise.all(
    entries
      .filter((e) => e.isFile() && VIDEO_EXT.test(e.name))
      .map(async (e) => {
        const full = path.join(dir, e.name);
        const st = await fs.promises.stat(full);
        return { name: e.name, size: st.size, mtime: st.mtimeMs, recording: openFiles.has(full) };
      })
  );
  return { dir, items: items.sort((a, b) => b.mtime - a.mtime) };
});

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Save recordings to',
    defaultPath: recordingsDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...loadSettings(), recordingsDir: result.filePaths[0] }, null, 2));
  return result.filePaths[0];
});

ipcMain.handle('open-folder', () => shell.openPath(recordingsDir()));
ipcMain.handle('reveal-recording', (_e, name) => shell.showItemInFolder(resolveRecording(name)));
ipcMain.handle('trash-recording', (_e, name) => {
  const file = resolveRecording(name);
  if (openFiles.has(file)) throw new Error('That recording is still in progress');
  return shell.trashItem(file);
});
