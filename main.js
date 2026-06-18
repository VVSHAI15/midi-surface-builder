const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const WebSocket = require('ws');
const easymidi  = require('easymidi');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const { parseExpressionMap } = require('./src/expressionMapParser');

const MIDI_PORT_NAME = 'DAW Controller';
const NOTE_OFF_MS    = 100;
const WS_PORT        = 8080;
const HTTP_PORT      = 3000;

// ---- MIDI ----
let midiOut = null;
try {
  midiOut = new easymidi.Output(MIDI_PORT_NAME, true);
  console.log(`MIDI port "${MIDI_PORT_NAME}" created`);
} catch (e) {
  console.error('MIDI port creation failed:', e.message);
}

function sendMidi(msg) {
  if (!midiOut) return;
  try {
    const ch = msg.channel ?? 0;
    switch (msg.type) {
      case 'note':
        midiOut.send('noteon',  { channel: ch, note: msg.data1 ?? 60, velocity: msg.data2 ?? 127 });
        setTimeout(() => midiOut.send('noteoff', { channel: ch, note: msg.data1 ?? 60, velocity: 0 }), NOTE_OFF_MS);
        break;
      case 'cc':
        midiOut.send('cc', { channel: ch, controller: msg.data1 ?? 0, value: msg.data2 ?? 0 });
        break;
      case 'pc':
        midiOut.send('program', { channel: ch, number: msg.data1 ?? 0 });
        break;
      case 'pitchbend':
        midiOut.send('pitch', { channel: ch, value: (msg.data1 ?? 0) - 8192 });
        break;
    }
  } catch (e) {
    console.error('MIDI send error:', e.message);
  }
}

// ---- State ----
const instrumentMaps = new Map(); // filePath -> InstrumentObject
const folderWatchers = new Map(); // folderPath -> FSWatcher

function defaultLayout() {
  return {
    version: 1,
    watchedFolders: [],
    instruments: {},
    macros: [],
    transport: {
      rewind: { type: 'cc', data1: 109, data2: 127, channel: 0 },
      play:   { type: 'cc', data1: 110, data2: 127, channel: 0 },
      stop:   { type: 'cc', data1: 111, data2: 127, channel: 0 },
      record: { type: 'cc', data1: 112, data2: 127, channel: 0 },
      loop:   { type: 'cc', data1: 113, data2: 127, channel: 0 },
    },
  };
}
let layout = defaultLayout();

// ---- Layout Persistence ----
let LAYOUT_PATH;

function loadLayoutFromDisk() {
  LAYOUT_PATH = path.join(app.getPath('userData'), 'daw-controller-layout.json');
  try {
    if (fs.existsSync(LAYOUT_PATH)) {
      layout = { ...defaultLayout(), ...JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8')) };
    }
  } catch (e) {
    console.error('Layout load failed:', e.message);
  }
}

function saveLayoutToDisk(newLayout) {
  layout = newLayout;
  try { fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 2), 'utf8'); }
  catch (e) { console.error('Layout save failed:', e.message); }
}

// ---- Folder Watching (built-in fs.watch) ----
function tryParseAndStore(filePath, event) {
  if (!filePath.endsWith('.expressionmap')) return;
  try {
    const instrument = parseExpressionMap(filePath);
    instrumentMaps.set(filePath, instrument);
    broadcastWS({ type: `map:${event}`, payload: instrument });
    sendToRenderer(`map:${event}`, instrument);
  } catch (e) {
    console.error(`Parse error (${event}):`, e.message);
    sendToRenderer('error:show', { title: 'Parse Error', message: e.message });
  }
}

// Debounce rapid fs.watch events (editors often fire multiple events on save)
const debounceTimers = new Map();
function debouncedParseAndStore(filePath, event, delay = 400) {
  const key = filePath + event;
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    tryParseAndStore(filePath, event);
  }, delay));
}

function startWatchingFolder(folderPath) {
  if (folderWatchers.has(folderPath)) return;

  // Initial scan
  try {
    fs.readdirSync(folderPath)
      .filter(f => f.endsWith('.expressionmap'))
      .forEach(f => tryParseAndStore(path.join(folderPath, f), 'added'));
  } catch (e) {
    console.error('Folder scan failed:', e.message);
    return;
  }

  const watcher = fs.watch(folderPath, { persistent: true }, (eventType, filename) => {
    if (!filename?.endsWith('.expressionmap')) return;
    const fp = path.join(folderPath, filename);
    if (fs.existsSync(fp)) {
      const ev = instrumentMaps.has(fp) ? 'updated' : 'added';
      debouncedParseAndStore(fp, ev);
    } else {
      instrumentMaps.delete(fp);
      broadcastWS({ type: 'map:removed', payload: fp });
      sendToRenderer('map:removed', fp);
    }
  });

  watcher.on('error', e => console.error('Watcher error:', e.message));
  folderWatchers.set(folderPath, watcher);
}

function stopWatchingFolder(folderPath) {
  const w = folderWatchers.get(folderPath);
  if (!w) return;
  w.close();
  folderWatchers.delete(folderPath);
  for (const [fp] of instrumentMaps) {
    if (fp.startsWith(folderPath + path.sep)) {
      instrumentMaps.delete(fp);
      sendToRenderer('map:removed', fp);
    }
  }
}

// ---- Electron Window ----
let win;
function sendToRenderer(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    backgroundColor: '#16161a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile('index.html');

  win.webContents.on('did-finish-load', () => {
    sendToRenderer('state:sync', {
      instruments: Array.from(instrumentMaps.values()),
      layout,
    });
  });
}

// ---- IPC Handlers ----
ipcMain.handle('map:open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Import Cubase Expression Maps',
    filters: [{ name: 'Cubase Expression Maps', extensions: ['expressionmap'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled) return [];
  const instruments = [];
  for (const fp of result.filePaths) {
    try {
      const inst = parseExpressionMap(fp);
      instrumentMaps.set(fp, inst);
      instruments.push(inst);
    } catch (e) {
      sendToRenderer('error:show', { title: 'Parse Error', message: e.message });
    }
  }
  return instruments;
});

ipcMain.handle('folder:open-dialog', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Watch Folder for Expression Maps',
    properties: ['openDirectory'],
  });
  return (result.canceled || !result.filePaths.length) ? null : result.filePaths[0];
});

ipcMain.handle('map:load-file', async (_, fp) => {
  const inst = parseExpressionMap(fp);
  instrumentMaps.set(fp, inst);
  return inst;
});

ipcMain.handle('map:remove', async (_, fp) => {
  instrumentMaps.delete(fp);
});

ipcMain.handle('folder:watch', async (_, fp) => {
  startWatchingFolder(fp);
});

ipcMain.handle('folder:unwatch', async (_, fp) => {
  stopWatchingFolder(fp);
});

ipcMain.handle('midi:send', async (_, msg) => {
  sendMidi(msg);
});

ipcMain.handle('layout:save', async (_, newLayout) => {
  saveLayoutToDisk(newLayout);
});

ipcMain.handle('layout:load', async () => layout);

// ---- WebSocket Server ----
const wss = new WebSocket.Server({ host: '0.0.0.0', port: WS_PORT });

function broadcastWS(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(str);
  });
}

wss.on('connection', ws => {
  console.log('Remote client connected');
  ws.send(JSON.stringify({
    type: 'state:full',
    payload: { instruments: Array.from(instrumentMaps.values()), layout },
  }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'midi:send')    sendMidi(msg.payload);
      if (msg.type === 'layout:save')  saveLayoutToDisk(msg.payload);
    } catch (e) { console.error('WS message error:', e.message); }
  });

  ws.on('close', () => console.log('Remote client disconnected'));
});

console.log(`WebSocket server on port ${WS_PORT}`);

// ---- HTTP Server (serves UI to tablet browser) ----
const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
};

const webServer = http.createServer((req, res) => {
  const urlPath    = req.url.split('?')[0];
  const filePath   = urlPath === '/' ? '/index.html' : urlPath;
  const fullPath   = path.join(__dirname, filePath);
  const contentType = MIME[path.extname(fullPath)] || 'text/plain';

  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

webServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`HTTP server on port ${HTTP_PORT}`);
});

// ---- App Lifecycle ----
app.whenReady().then(() => {
  loadLayoutFromDisk();
  for (const folder of layout.watchedFolders || []) {
    startWatchingFolder(folder);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (midiOut) { try { midiOut.close(); } catch (_) {} }
  for (const w of folderWatchers.values()) { try { w.close(); } catch (_) {} }
  if (process.platform !== 'darwin') app.quit();
});
