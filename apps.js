// --- Elements & State ---
const statusText = document.getElementById("status");
const toggleBtn = document.getElementById("mode-toggle-btn");
const midiPads = document.querySelectorAll(".midi-pad");
let isEditMode = false;

// --- WebSocket Setup ---
const socket = new WebSocket("ws://192.168.1.51:8080");

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
  if (isEditMode) return; // Prevent sending MIDI while moving things

  if (socket.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({
      type: "cc",
      channel: channel,
      controller: controller,
      value: value,
    });
    socket.send(payload);
  }
}

// Attach MIDI events to pads based on their HTML data attributes
midiPads.forEach((pad) => {
  const ccValue = parseInt(pad.getAttribute("data-cc"), 10);
  
  pad.addEventListener("mousedown", () => sendMidiCC(1, ccValue, 127));
  pad.addEventListener("mouseup", () => sendMidiCC(1, ccValue, 0));
  pad.addEventListener("mouseleave", () => sendMidiCC(1, ccValue, 0)); // Catch dragged-off-pad states
});

// --- Edit Mode Logic ---
toggleBtn.addEventListener("click", () => {
  isEditMode = !isEditMode;
  
  if (isEditMode) {
    document.body.classList.add('edit-mode');
    toggleBtn.innerText = "Exit Edit Mode";
    toggleBtn.style.backgroundColor = "#ff9800";
    console.log("Edit Mode ON: MIDI is disabled.");
  } else {
    document.body.classList.remove('edit-mode');
    toggleBtn.innerText = "Enter Edit Mode";
    toggleBtn.style.backgroundColor = "#444";
    console.log("Edit Mode OFF: MIDI is live.");
  }

  // Toggle interact.js behaviors
  interact(".midi-pad").draggable({ enabled: isEditMode });
  interact(".midi-pad").resizable({ enabled: isEditMode });
});

// --- Interact.js Movement Functions ---
function dragMoveListener(event) {
  const target = event.target;
  // keep the dragged position in the data-x/data-y attributes
  const x = (parseFloat(target.getAttribute("data-x")) || 0) + event.dx;
  const y = (parseFloat(target.getAttribute("data-y")) || 0) + event.dy;

  // translate the element
  target.style.transform = `translate(${x}px, ${y}px)`;

  // update the position attributes
  target.setAttribute("data-x", x);
  target.setAttribute("data-y", y);
}

function resizeMoveListener(event) {
  const target = event.target;
  let x = parseFloat(target.getAttribute("data-x")) || 0;
  let y = parseFloat(target.getAttribute("data-y")) || 0;

  // update the element's style
  target.style.width = event.rect.width + "px";
  target.style.height = event.rect.height + "px";

  // translate when resizing from top or left edges
  x += event.deltaRect.left;
  y += event.deltaRect.top;

  target.style.transform = `translate(${x}px, ${y}px)`;

  target.setAttribute("data-x", x);
  target.setAttribute("data-y", y);
  
  // Optional: Update text to show size while editing
  // target.textContent = `${Math.round(event.rect.width)} × ${Math.round(event.rect.height)}`;
}

// --- Interact.js Initialization ---
// We initialize them globally but default them to enabled: false
interact(".midi-pad")
  .draggable({
    enabled: false, // Disabled until Edit Mode is true
    inertia: true,
    modifiers: [
      interact.modifiers.restrictRect({
        restriction: "parent",
        endOnly: true,
      }),
    ],
    listeners: { move: dragMoveListener },
  })
  .resizable({
    enabled: false, // Disabled until Edit Mode is true
    edges: { left: true, right: true, bottom: true, top: true },
    inertia: true,
    modifiers: [
      interact.modifiers.restrictEdges({ outer: "parent" }),
      interact.modifiers.restrictSize({ min: { width: 100, height: 50 } }),
    ],
    listeners: { move: resizeMoveListener },
  });