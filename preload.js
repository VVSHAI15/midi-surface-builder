const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFileDialog:   ()           => ipcRenderer.invoke('map:open-file-dialog'),
  openFolderDialog: ()           => ipcRenderer.invoke('folder:open-dialog'),
  loadFile:         (fp)         => ipcRenderer.invoke('map:load-file', fp),
  removeMap:        (fp)         => ipcRenderer.invoke('map:remove', fp),
  watchFolder:      (fp)         => ipcRenderer.invoke('folder:watch', fp),
  unwatchFolder:    (fp)         => ipcRenderer.invoke('folder:unwatch', fp),
  sendMidi:         (msg)        => ipcRenderer.invoke('midi:send', msg),
  saveLayout:       (layout)     => ipcRenderer.invoke('layout:save', layout),
  loadLayout:       ()           => ipcRenderer.invoke('layout:load'),

  onMapAdded:   (cb) => ipcRenderer.on('map:added',   (_, d) => cb(d)),
  onMapRemoved: (cb) => ipcRenderer.on('map:removed', (_, d) => cb(d)),
  onMapUpdated: (cb) => ipcRenderer.on('map:updated', (_, d) => cb(d)),
  onError:      (cb) => ipcRenderer.on('error:show',  (_, d) => cb(d)),
  onStateSync:  (cb) => ipcRenderer.on('state:sync',  (_, d) => cb(d)),
});
