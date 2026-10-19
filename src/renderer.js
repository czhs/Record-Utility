const $ = (id) => document.getElementById(id);

const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

let selected = null; // { id, name }
let mediaRecorder = null;
let streams = [];
let audioCtx = null;
let analyser = null;
let appAudioPort = null; // worklet port fed with the tapped app's PCM
let audioLabel = '';
let recordingFile = null;
let bytesWritten = 0;
let writeQueue = Promise.resolve();
let timerHandle = null;
let lastSaved = null;

function show(view) {
  for (const v of ['pickerView', 'recordingView', 'doneView']) $(v).hidden = v !== view;
}

function setStatus(text) { $('status').textContent = text || ''; }

async function checkPermissions() {
  const { screen } = await window.recorder.permissionStatus();
  $('permission').hidden = screen === 'granted';
}

async function loadWindows() {
  if (!$('grid').children.length) setStatus('Loading windows…');
  let windows;
  try {
    windows = await window.recorder.getWindows();
  } catch (err) {
    // Usually means Screen Recording permission hasn't been granted yet.
    console.error(err);
    windows = [];
    $('permission').hidden = false;
  }
  setStatus('');
  $('screenGrid').replaceChildren();
  $('grid').replaceChildren();
  $('empty').hidden = windows.length > 0;

  for (const w of windows) {
    // Screens record the whole display, which is how you capture full-screen apps.
    const grid = w.kind === 'screen' ? $('screenGrid') : $('grid');
    const card = document.createElement('div');
    card.className = 'card' + (selected?.id === w.id ? ' selected' : '');
    card.tabIndex = 0;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (w.thumbnail) thumb.style.backgroundImage = `url(${w.thumbnail})`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (w.appIcon) {
      const icon = document.createElement('img');
      icon.src = w.appIcon;
      meta.append(icon);
    }
    const name = document.createElement('span');
    name.textContent = w.name;
    name.title = w.name;
    meta.append(name);

    card.append(thumb, meta);
    const pick = () => {
      selected = { id: w.id, name: w.name };
      for (const c of document.querySelectorAll('.card')) c.classList.remove('selected');
      card.classList.add('selected');
      $('record').disabled = false;
      updateMuteToggle();
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') pick(); });
    grid.append(card);
  }

  if (selected && !windows.some((w) => w.id === selected.id)) {
    selected = null;
    $('record').disabled = true;
  }
}

async function getWindowStream(audioMode) {
  await window.recorder.selectSource(selected.id, audioMode);
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: !!audioMode,
  });
}

// System-wide loopback is the fallback (and what Screens use); null means video only.
async function openDisplay(useSystemAudio) {
  if (useSystemAudio) {
    try {
      return { stream: await getWindowStream('loopback'), mode: 'loopback' };
    } catch (err) {
      console.warn('System audio capture failed, recording without it:', err.name, err.message);
    }
  }
  return { stream: await getWindowStream(null), mode: null };
}

async function startRecording() {
  const wantAudio = $('sysAudio').checked;
  const isWindow = selected.id.startsWith('window:');
  const wantMute = wantAudio && isWindow && $('muteOut').checked;
  const wantMic = $('mic').checked;
  const notes = [];
  setStatus('Starting…');

  // For a window, capture just its app's audio (optionally silenced on the speakers).
  let appAudio = null;
  if (wantAudio && isWindow) {
    await window.recorder.selectSource(selected.id, null);
    try {
      appAudio = await window.recorder.startAppAudio(wantMute);
    } catch (err) {
      console.warn('App audio capture failed, falling back to system audio:', err.message);
      notes.push(`app audio unavailable (${err.message.split('\n')[0]}), using all system audio${wantMute ? ', not muted' : ''}`);
    }
  }

  const { stream: display, mode } = await openDisplay(wantAudio && !appAudio);
  streams.push(display);
  if (wantAudio && !appAudio && !mode) notes.push('system audio unavailable');

  const audioTracks = [...display.getAudioTracks()];
  if (wantMic) {
    if (await window.recorder.askMic()) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
      streams.push(mic);
      audioTracks.push(...mic.getAudioTracks());
    } else {
      notes.push('microphone permission denied');
    }
  }

  // Mix app/system audio + mic into one track, and tap it for the waveform.
  // Nothing is connected to audioCtx.destination, so this never plays out loud.
  const tracks = [...display.getVideoTracks()];
  if (audioTracks.length || appAudio) {
    audioCtx = new AudioContext(appAudio ? { sampleRate: appAudio.sampleRate } : {});
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    const dest = audioCtx.createMediaStreamDestination();
    for (const t of audioTracks) {
      const src = audioCtx.createMediaStreamSource(new MediaStream([t]));
      src.connect(dest);
      src.connect(analyser);
    }
    if (appAudio) {
      await audioCtx.audioWorklet.addModule('tap-worklet.js');
      const player = new AudioWorkletNode(audioCtx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
      player.connect(dest);
      player.connect(analyser);
      appAudioPort = player.port;
    }
    tracks.push(...dest.stream.getAudioTracks());
  }
  const combined = new MediaStream(tracks);

  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  recordingFile = await window.recorder.openRecording(ext, selected.name);
  bytesWritten = 0;
  writeQueue = Promise.resolve();

  // Write each chunk to disk as it arrives so long recordings never sit in memory.
  mediaRecorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 8_000_000 });
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    writeQueue = writeQueue.then(async () => {
      const buf = await e.data.arrayBuffer();
      await window.recorder.writeChunk(recordingFile, buf);
      bytesWritten += buf.byteLength;
    });
  };
  mediaRecorder.onstop = finishRecording;
  mediaRecorder.start(1000);
  window.recorder.setRecording(true);

  // If the recorded window closes, stop cleanly.
  display.getVideoTracks()[0].addEventListener('ended', stopRecording);

  $('preview').srcObject = display;
  show('recordingView');
  $('record').classList.add('recording');
  $('recordLabel').textContent = 'Stop';
  $('sysAudio').disabled = $('muteOut').disabled = $('mic').disabled = true;
  setStatus(notes.length ? `Recording — ${notes.join(', ')}` : selected.name);

  const sources = [];
  if (appAudio) sources.push(`${appAudio.app || 'app'} only${appAudio.muted ? ' (muted for you)' : ''}`);
  else if (mode) sources.push('all system audio');
  if (audioTracks.length > (mode ? 1 : 0)) sources.push('mic');
  audioLabel = sources.join(' + ') || 'none';
  startMeters();

  const started = Date.now();
  $('timer').hidden = false;
  $('timer').textContent = '00:00';
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    const h = Math.floor(s / 3600);
    const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    $('timer').textContent = h ? `${h}:${mmss}` : mmss;
  }, 250);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

async function finishRecording() {
  clearInterval(timerHandle);
  stopMeters();
  for (const s of streams) s.getTracks().forEach((t) => t.stop());
  streams = [];
  window.recorder.stopAppAudio();
  appAudioPort = null;
  audioCtx?.close();
  audioCtx = analyser = null;
  $('preview').srcObject = null;
  $('timer').hidden = true;
  $('record').classList.remove('recording');
  $('recordLabel').textContent = 'Record';
  $('sysAudio').disabled = $('mic').disabled = false;
  updateMuteToggle();
  mediaRecorder = null;
  setStatus('Saving…');

  // The final chunk arrives just before onstop; let every queued write land first.
  await new Promise((r) => setTimeout(r, 0));
  try {
    await writeQueue;
  } finally {
    lastSaved = await window.recorder.closeRecording(recordingFile);
    recordingFile = null;
    window.recorder.setRecording(false);
  }

  setStatus('');
  $('savedName').textContent = lastSaved.split('/').pop();
  show('doneView');
  loadLibrary();
}

// ---- Live waveform + stats while recording ----

const WAVE_BAR = 3; // px per bar, including gap
let peaks = [];
let sampleHandle = null;
let drawHandle = null;
let lastSoundAt = 0;

function startMeters() {
  peaks = [];
  lastSoundAt = Date.now();
  const buf = new Float32Array(2048);
  // Sample on a timer (not rAF) so the history stays continuous while the window is hidden.
  sampleHandle = setInterval(() => {
    let peak = 0;
    if (analyser) {
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
    }
    if (peak > 0.003) lastSoundAt = Date.now();
    peaks.push(peak);
    if (peaks.length > 2000) peaks.splice(0, peaks.length - 2000);
  }, 50);
  const draw = () => {
    drawWave();
    drawStats();
    drawHandle = requestAnimationFrame(draw);
  };
  draw();
}

function stopMeters() {
  clearInterval(sampleHandle);
  cancelAnimationFrame(drawHandle);
}

function drawWave() {
  const canvas = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(0, h / 2 - 0.5, w, 1);

  const count = Math.floor(w / WAVE_BAR);
  const recent = peaks.slice(-count);
  const offset = count - recent.length;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff4d5e';
  recent.forEach((p, i) => {
    // sqrt makes quiet speech visible without clipping loud audio.
    const barH = Math.max(1, Math.min(1, Math.sqrt(p)) * (h - 4));
    ctx.fillRect((offset + i) * WAVE_BAR, (h - barH) / 2, WAVE_BAR - 1, barH);
  });
}

function drawStats() {
  const track = streams[0]?.getVideoTracks()[0];
  const s = track?.getSettings() ?? {};
  const parts = [];
  if (s.width) parts.push(`${s.width}×${s.height}`);
  parts.push(`${(bytesWritten / 1048576).toFixed(1)} MB saved`);
  parts.push(`audio: ${audioLabel}`);
  if (analyser && Date.now() - lastSoundAt > 3000) parts.push('silent');
  $('recStats').textContent = parts.join(' · ');
}

$('record').addEventListener('click', async () => {
  if (mediaRecorder) return stopRecording();
  if (!selected) return;
  $('record').disabled = true;
  try {
    await startRecording();
  } catch (err) {
    console.error(err.name, err.message);
    for (const s of streams) s.getTracks().forEach((t) => t.stop());
    streams = [];
    window.recorder.stopAppAudio();
    audioCtx?.close();
    audioCtx = analyser = appAudioPort = null;
    setStatus(`Couldn't start: ${err.message}`);
    checkPermissions();
  } finally {
    $('record').disabled = false;
  }
});

$('refresh').addEventListener('click', loadWindows);
$('openSettings').addEventListener('click', () => window.recorder.openScreenSettings());
$('reveal').addEventListener('click', () => lastSaved && window.recorder.reveal(lastSaved));
$('again').addEventListener('click', () => { show('pickerView'); loadWindows(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mediaRecorder) stopRecording();
});

checkPermissions();
loadWindows();

// Keep the list current: windows that were full screen or on another desktop
// only show up once they're on the current desktop.
let loading = false;
async function autoRefresh() {
  if (loading || mediaRecorder || $('pickerView').hidden) return;
  loading = true;
  try { await loadWindows(); } finally { loading = false; }
}
window.addEventListener('focus', autoRefresh);
setInterval(autoRefresh, 4000);

// Muting works per app, so it needs audio on and a window (not a whole screen) selected.
function updateMuteToggle() {
  $('muteOut').disabled = !$('sysAudio').checked || !!selected?.id.startsWith('screen:');
}
$('sysAudio').addEventListener('change', updateMuteToggle);

window.recorder.onAppAudio((buf) => appAudioPort?.postMessage(buf, [buf]));

// Quitting while recording asks us to stop and save first.
window.recorder.onStopRequest(stopRecording);

// ---- Tabs ----

let currentTab = 'record';

function showTab(tab) {
  currentTab = tab;
  $('recordPane').hidden = tab !== 'record';
  $('libraryPane').hidden = tab !== 'library';
  $('tabRecord').classList.toggle('active', tab === 'record');
  $('tabLibrary').classList.toggle('active', tab === 'library');
  $('refresh').style.visibility = tab === 'record' ? 'visible' : 'hidden';
  if (tab === 'library') loadLibrary();
  else closePlayer();
}

$('tabRecord').addEventListener('click', () => showTab('record'));
$('tabLibrary').addEventListener('click', () => showTab('library'));

// ---- Recordings library ----

const mediaUrl = (name) => `wr-media://rec/${encodeURIComponent(name)}`;
let playing = null; // name of the recording open in the player

function formatSize(bytes) {
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!isFinite(sec)) return '';
  const s = Math.round(sec);
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss}` : mmss;
}

async function loadLibrary() {
  const { dir, items } = await window.recorder.listRecordings();
  $('libFolder').textContent = dir.replace(/^\/Users\/[^/]+/, '~');
  $('libFolder').title = dir;
  $('libEmpty').hidden = items.length > 0;
  $('tabLibrary').innerHTML = items.length ? `Recordings<span class="count">${items.length}</span>` : 'Recordings';

  // Rebuild only when the set of files changed, so thumbnails don't flicker on refresh.
  const grid = $('libGrid');
  const signature = items.map((i) => `${i.name}|${i.recording}`).join('\n');
  if (grid.dataset.signature !== signature) {
    grid.dataset.signature = signature;
    grid.replaceChildren(...items.map(libraryCard));
  }
  for (const item of items) {
    const sub = grid.querySelector(`[data-name="${CSS.escape(item.name)}"] .size`);
    if (sub) sub.textContent = formatSize(item.size);
  }
}

function libraryCard(item) {
  const card = document.createElement('div');
  card.className = 'card' + (item.recording ? ' in-progress' : '');
  card.dataset.name = item.name;
  card.tabIndex = 0;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const sub = document.createElement('div');
  sub.className = 'sub';
  const when = new Date(item.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const duration = document.createElement('span');
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = formatSize(item.size);
  sub.append(`${when} · `, duration, size);

  if (item.recording) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'RECORDING';
    thumb.append(badge);
  } else {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.src = `${mediaUrl(item.name)}#t=0.5`;
    video.addEventListener('loadedmetadata', () => {
      const d = formatDuration(video.duration);
      if (d) duration.textContent = `${d} · `;
    });
    thumb.append(video);
    const open = () => openPlayer(item.name);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.textContent = item.name.replace(/\.\w+$/, '');
  name.title = item.name;
  meta.append(name);

  card.append(thumb, meta, sub);
  return card;
}

function openPlayer(name) {
  playing = name;
  $('libraryView').hidden = true;
  $('playerView').hidden = false;
  $('playerName').textContent = name.replace(/\.\w+$/, '');
  $('player').src = mediaUrl(name);
  $('player').play().catch(() => {});
}

function closePlayer() {
  if (!playing) return;
  playing = null;
  $('player').pause();
  $('player').removeAttribute('src');
  $('player').load();
  $('playerView').hidden = true;
  $('libraryView').hidden = false;
}

$('playerBack').addEventListener('click', () => { closePlayer(); loadLibrary(); });
$('playerReveal').addEventListener('click', () => playing && window.recorder.revealRecording(playing));
$('playerTrash').addEventListener('click', async () => {
  if (!playing || !confirm(`Move “${playing}” to the Trash?`)) return;
  const name = playing;
  closePlayer();
  await window.recorder.trashRecording(name);
  loadLibrary();
});
$('openFolder').addEventListener('click', () => window.recorder.openFolder());
$('changeFolder').addEventListener('click', async () => {
  if (await window.recorder.chooseFolder()) loadLibrary();
});
$('playSaved').addEventListener('click', () => {
  if (!lastSaved) return;
  showTab('library');
  openPlayer(lastSaved.split('/').pop());
});

// Keep sizes and in-progress items current while the library is open.
setInterval(() => { if (currentTab === 'library' && !playing) loadLibrary(); }, 3000);
loadLibrary();
