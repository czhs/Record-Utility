const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorder', {
  getWindows: () => ipcRenderer.invoke('get-windows'),
  selectSource: (id, audioMode) => ipcRenderer.invoke('select-source', id, audioMode),
  permissionStatus: () => ipcRenderer.invoke('permission-status'),
  askMic: () => ipcRenderer.invoke('ask-mic'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  openRecording: (ext, sourceName) => ipcRenderer.invoke('open-recording', ext, sourceName),
  writeChunk: (file, buffer) => ipcRenderer.invoke('write-chunk', file, buffer),
  closeRecording: (file) => ipcRenderer.invoke('close-recording', file),
  setRecording: (recording) => ipcRenderer.send('recording-state', recording),
  onStopRequest: (fn) => ipcRenderer.on('stop-recording', () => fn()),
  startAppAudio: (mute) => ipcRenderer.invoke('start-app-audio', mute),
  stopAppAudio: () => ipcRenderer.invoke('stop-app-audio'),
  onAppAudio: (fn) => ipcRenderer.on('app-audio', (_e, buf) => fn(buf)),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  revealRecording: (name) => ipcRenderer.invoke('reveal-recording', name),
  trashRecording: (name) => ipcRenderer.invoke('trash-recording', name),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
});
