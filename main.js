const { app, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const easymidi  = require('easymidi');
const http      = require('http');
const dgram     = require('dgram');
const fs        = require('fs');
const path      = require('path');

// ── MIDI ─────────────────────────────────────────────────────────────────────
const midiOut = new easymidi.Output('MCU_To_OSC', true);

// ── OSC via raw UDP (no external packages needed) ─────────────────────────────
const udpClient = dgram.createSocket('udp4');
let oscTarget = { ip: '127.0.0.1', port: 9000, enabled: false };

function padTo4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

function encodeString(str) {
  return padTo4(Buffer.from(str + '\0', 'ascii'));
}

function buildOSCMessage(address, value) {
  const addrBuf = encodeString(address);
  const tagBuf  = encodeString(',i');           // int32 argument
  const valBuf  = Buffer.alloc(4);
  valBuf.writeInt32BE(Math.round(value), 0);
  return Buffer.concat([addrBuf, tagBuf, valBuf]);
}

function sendOSCPacket(address, value) {
  if (!oscTarget.enabled) return;
  try {
    const msg = buildOSCMessage(address, value);
    udpClient.send(msg, 0, msg.length, oscTarget.port, oscTarget.ip);
  } catch (e) {
    console.error('OSC send error:', e.message);
  }
}

// ── WebSocket Bridge ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ host: '0.0.0.0', port: 8080 });

wss.on('connection', (ws) => {
  console.log('UI connected');

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const ch   = parseInt(data.channel)    - 1;  // frontend 1-16 → easymidi 0-15
      const ctrl = parseInt(data.controller);
      const val  = parseInt(data.value);

      if (data.type === 'cc') {
        midiOut.send('cc', { channel: ch, controller: ctrl, value: val });
        console.log(`CC  ch:${ch + 1}  ctrl:${ctrl}  val:${val}`);

      } else if (data.type === 'note') {
        if (val > 0) {
          midiOut.send('noteon',  { channel: ch, note: ctrl, velocity: val });
        } else {
          midiOut.send('noteoff', { channel: ch, note: ctrl, velocity: 0   });
        }

      } else if (data.type === 'pitchbend') {
        // val 0-127 mapped to -8192..8191
        const pb = Math.round((val / 127) * 16383) - 8192;
        midiOut.send('pitch', { channel: ch, value: pb });

      } else if (data.type === 'osc') {
        sendOSCPacket(data.address, data.value);

      } else if (data.type === 'sync_layout') {
        // Broadcast layout to all OTHER clients so windows stay in sync
        const reply = JSON.stringify(data);
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN) c.send(reply);
        });

      } else if (data.type === 'config_osc') {
        oscTarget = {
          ip:      data.ip   || '127.0.0.1',
          port:    parseInt(data.port) || 9000,
          enabled: true,
        };
        console.log(`OSC target → ${oscTarget.ip}:${oscTarget.port}`);
        // Confirm back to all clients
        const reply = JSON.stringify({ type: 'osc_status', ip: oscTarget.ip, port: oscTarget.port });
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(reply); });
      }
    } catch (err) {
      console.warn('WS parse error:', err.message);
    }
  });
});

// ── HTTP Server (serves UI to iPad) ──────────────────────────────────────────
const webServer = http.createServer((req, res) => {
  const reqPath  = req.url.split('?')[0];
  const filePath = reqPath === '/' ? '/index.html' : reqPath;
  const fullPath = path.join(__dirname, filePath);
  const ext      = path.extname(fullPath);

  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

webServer.listen(3000, '0.0.0.0', () => {
  console.log('Web server → http://192.168.1.166:3000');
});

// ── Electron Window ───────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:          1280,
    height:         800,
    acceptFirstMouse: true,
    alwaysOnTop:    true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
  });
  win.loadURL('http://localhost:3000');
  win.showInactive();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  midiOut.close();
  udpClient.close();
  if (process.platform !== 'darwin') app.quit();
});
