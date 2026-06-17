const { app, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const easymidi = require('easymidi');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 1. Temporary midi port initialization
const midiOut = new easymidi.Output('MCU_To_OSC', true); 

// 2. Initialize the WebSocket Bridge
const wss = new WebSocket.Server({ host: '0.0.0.0', port: 8080 });


wss.on('connection', function connection(ws) {
  ws.on('message', function incoming(message) {
    try {
      // 1. Convert Buffer to string before parsing
      const data = JSON.parse(message.toString()); 
      
      if (data.type === 'cc') {
          midiOut.send('cc', {
              channel: data.channel,
              controller: data.controller,
              value: data.value
          });
          console.log(`Sent CC: ${data.controller} Val: ${data.value}`);
      }
    } catch (err) {
      // 2. Catch invalid JSON so the app doesn't crash
      console.log('Received non-JSON message or malformed data:', message.toString());
    }
  });
});
// 3. Fixed HTTP Web Server to properly serve HTML, CSS, and JS files
const webServer = http.createServer((req, res) => {
    // Default to index.html if root path is requested
    let filePath = req.url === '/' ? '/index.html' : req.url;
    let fullPath = path.join(__dirname, filePath);

    // Basic Content-Type mapping
    const extname = path.extname(fullPath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
    }

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("404 Not Found");
        }
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data); 
    });
});

webServer.listen(3000, '0.0.0.0', () => {
    console.log('Web server running! Open http://192.168.1.51:3000 on your iPad.');
});

// 4. Initialize the Electron Window
function createWindow () {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    // Critical flags for a non-activating touchscreen UI:
    focusable: false,       
    acceptFirstMouse: true, 
    alwaysOnTop: true,      
    webPreferences: {
      nodeIntegration: false, 
      contextIsolation: true
    }
  });

  // Load your existing builder UI
  win.loadFile('index.html');
  
  // Show the window without stealing focus from the active DAW
  win.showInactive();
}

app.whenReady().then(createWindow);

// Cleanup MIDI ports when the app closes
app.on('window-all-closed', () => {
  midiOut.close();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});