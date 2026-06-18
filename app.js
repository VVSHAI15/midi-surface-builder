// --- Elements & State ---
const statusText = document.getElementById("status");
const toggleBtn = document.getElementById("mode-toggle-btn");
const canvas = document.getElementById("canvas");
let isEditMode = false;
let widgetCount = 0;
let currentSelectedPad = null;

// --- WebSocket Setup ---
// NOTE: Make sure this IP matches your Mac's current local IP
const socket = new WebSocket("ws://192.168.1.166:8080");

socket.onopen = () => {
  console.log("UI successfully connected to MIDI Bridge!");
  statusText.innerText = "Connected to Bridge • Ready to send MIDI";
  statusText.style.color = "#4CAF50";
};

socket.onerror = (error) => {
  statusText.innerText = "Error connecting to Bridge";
  statusText.style.color = "#f44336";
};

// --- MIDI Logic ---
function sendMidiCC(channel, controller, value) {
  if (isEditMode) return; 
  if (socket.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({ type: "cc", channel: channel, controller: controller, value: value });
    socket.send(payload);
  }
}

// --- Edit Mode Logic ---
toggleBtn.addEventListener("click", () => {
  isEditMode = !isEditMode;
  
  if (isEditMode) {
    document.body.classList.add('edit-mode');
    toggleBtn.innerText = "Exit Edit Mode";
    toggleBtn.style.backgroundColor = "#ff9800";
  } else {
    document.body.classList.remove('edit-mode');
    toggleBtn.innerText = "Enter Edit Mode";
    toggleBtn.style.backgroundColor = "#444";
    currentSelectedPad = null; // Clear selection on exit
    document.querySelectorAll('.widget').forEach(p => p.style.borderColor = "#666");
  }

  interact(".widget").draggable({ enabled: isEditMode });
  interact(".widget").resizable({ enabled: isEditMode });
});

// --- Widget Spawner Logic ---
document.getElementById("add-pad-btn").addEventListener("click", () => spawnWidget('pad'));
document.getElementById("add-fader-btn").addEventListener("click", () => spawnWidget('fader'));
document.getElementById("clear-btn").addEventListener("click", () => {
    canvas.innerHTML = '';
    currentSelectedPad = null;
});

function spawnWidget(type) {
  widgetCount++;
  const el = document.createElement("div");
  el.id = `widget_${widgetCount}`;
  el.style.transform = "translate(10px, 10px)";
  el.setAttribute("data-x", "10");
  el.setAttribute("data-y", "10");

  if (type === 'pad') {
    el.className = "midi-pad widget";
    el.setAttribute("data-cc", "14");
    el.setAttribute("data-label", `Pad ${widgetCount}`);
    el.setAttribute("data-color", "#444444");
    el.style.backgroundColor = "#444444";
    
    // Using robust spans so the inspector can update text safely
    el.innerHTML = `
      <span class="widget-label">Pad ${widgetCount}</span><br/>
      <span class="widget-cc">(CC 14)</span>
    `;

    el.addEventListener("mousedown", () => { if (!isEditMode) sendMidiCC(1, parseInt(el.getAttribute("data-cc"), 10), 127); });
    el.addEventListener("mouseup", () => { if (!isEditMode) sendMidiCC(1, parseInt(el.getAttribute("data-cc"), 10), 0); });
    el.addEventListener("mouseleave", () => { if (!isEditMode) sendMidiCC(1, parseInt(el.getAttribute("data-cc"), 10), 0); });

  } else if (type === 'fader') {
    el.className = "midi-fader widget";
    el.setAttribute("data-cc", "1"); 
    el.setAttribute("data-label", `Fader ${widgetCount}`);
    el.setAttribute("data-color", "#333333");
    el.style.backgroundColor = "#333333";
    
    el.innerHTML = `
      <span class="widget-label">Fader ${widgetCount}</span>
      <input type="range" min="0" max="127" value="0">
      <span class="widget-cc">(CC 1)</span>
    `;

    const slider = el.querySelector("input");
    slider.addEventListener("input", (e) => {
      if (!isEditMode) sendMidiCC(1, parseInt(el.getAttribute("data-cc"), 10), parseInt(e.target.value, 10));
    });
  }

  // Inspector Selection Listener
  el.addEventListener("mousedown", (e) => {
    if (isEditMode && e.target.tagName !== 'INPUT') selectPad(el);
  });

  canvas.appendChild(el);

  // Initialize interact.js for the new widget
  interact(el).draggable({
    enabled: isEditMode,
    modifiers: [ interact.modifiers.restrictRect({ restriction: "parent", endOnly: true }) ],
    listeners: { move: dragMoveListener }
  }).resizable({
    enabled: isEditMode,
    edges: { left: true, right: true, bottom: true, top: true },
    modifiers: [
      interact.modifiers.restrictEdges({ outer: "parent" }),
      interact.modifiers.restrictSize({ min: { width: 60, height: 60 } })
    ],
    listeners: { move: resizeMoveListener }
  });
}

// --- Property Inspector Logic ---
const propText = document.getElementById('prop-text');
const propColor = document.getElementById('prop-color');
const propCc = document.getElementById('prop-cc');

function selectPad(widgetElement) {
  currentSelectedPad = widgetElement;
  document.querySelectorAll('.widget').forEach(p => p.style.borderColor = "#666");
  widgetElement.style.borderColor = "#ff9800";

  propText.value = widgetElement.getAttribute("data-label") || "";
  propColor.value = widgetElement.getAttribute("data-color") || "#444444";
  propCc.value = widgetElement.getAttribute("data-cc") || "0";
}

propText.addEventListener("input", (e) => {
  if (!currentSelectedPad) return;
  const newText = e.target.value;
  currentSelectedPad.setAttribute("data-label", newText);
  const labelSpan = currentSelectedPad.querySelector(".widget-label");
  if (labelSpan) labelSpan.innerText = newText;
});

propColor.addEventListener("input", (e) => {
  if (!currentSelectedPad) return;
  const newColor = e.target.value;
  currentSelectedPad.setAttribute("data-color", newColor);
  currentSelectedPad.style.backgroundColor = newColor;
});

propCc.addEventListener("input", (e) => {
  if (!currentSelectedPad) return;
  const newCc = e.target.value;
  currentSelectedPad.setAttribute("data-cc", newCc);
  const ccSpan = currentSelectedPad.querySelector(".widget-cc");
  if (ccSpan) ccSpan.innerText = `(CC ${newCc})`;
});

// --- Interact.js Movement Functions ---
function dragMoveListener(event) {
  const target = event.target;
  const x = (parseFloat(target.getAttribute("data-x")) || 0) + event.dx;
  const y = (parseFloat(target.getAttribute("data-y")) || 0) + event.dy;
  target.style.transform = `translate(${x}px, ${y}px)`;
  target.setAttribute("data-x", x);
  target.setAttribute("data-y", y);
}

function resizeMoveListener(event) {
  const target = event.target;
  let x = parseFloat(target.getAttribute("data-x")) || 0;
  let y = parseFloat(target.getAttribute("data-y")) || 0;

  target.style.width = event.rect.width + "px";
  target.style.height = event.rect.height + "px";

  x += event.deltaRect.left;
  y += event.deltaRect.top;

  target.style.transform = `translate(${x}px, ${y}px)`;
  target.setAttribute("data-x", x);
  target.setAttribute("data-y", y);
}