// ── State ──────────────────────────────────────────────────────────────────
let isEditMode = false;
let widgetCount = 0;
let selectedWidget = null;
let snapEnabled = false;
const GRID_SIZE = 10;

// ── Drag State (module-level, single set of listeners) ─────────────────────
let activeFaderDrag = null; // { el, startY, startVal }
let activeKnobDrag = null;  // { el, startY, startVal }
let activeXYDrag = null;    // { el }

// ── WebSocket ──────────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
let socket = null;

function connectWebSocket() {
  try {
    socket = new WebSocket('ws://192.168.1.166:8080');
    socket.addEventListener('open', () => {
      statusEl.textContent = 'Connected';
      statusEl.className = 'status-connected';
    });
    socket.addEventListener('close', () => {
      statusEl.textContent = 'Disconnected';
      statusEl.className = 'status-error';
      setTimeout(connectWebSocket, 3000);
    });
    socket.addEventListener('error', () => {
      statusEl.textContent = 'Error';
      statusEl.className = 'status-error';
    });
  } catch (e) {
    statusEl.textContent = 'Error';
    statusEl.className = 'status-error';
  }
}

connectWebSocket();

function sendMidi(type, channel, controller, value) {
  if (isEditMode) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, channel: parseInt(channel), controller: parseInt(controller), value: parseInt(value) }));
}

// ── DOM Refs ───────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const toggleBtn = document.getElementById('mode-toggle-btn');
const inspectorPanels = document.getElementById('inspector-panels');
const noSelectionMsg = document.getElementById('no-selection-msg');
const inspectorTitle = document.getElementById('inspector-title');
const typeBadge = document.getElementById('widget-type-badge');
const xyCCRow = document.getElementById('xy-cc-row');

// ── Edit Mode Toggle ───────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  isEditMode = !isEditMode;
  document.body.classList.toggle('edit-mode', isEditMode);
  toggleBtn.classList.toggle('active', isEditMode);
  toggleBtn.textContent = isEditMode ? 'Exit Edit Mode' : 'Edit Mode';
  if (!isEditMode) deselectAll();
  // Update interact enabled state on all widgets
  document.querySelectorAll('.widget').forEach(el => {
    if (window.interact) {
      interact(el).draggable({ enabled: isEditMode && el.dataset.locked !== 'true' });
      interact(el).resizable({ enabled: isEditMode && el.dataset.locked !== 'true' });
    }
  });
});

// ── MIDI Channel Select ────────────────────────────────────────────────────
const channelSelect = document.getElementById('prop-channel');
for (let i = 1; i <= 16; i++) {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = `Ch ${i}`;
  channelSelect.appendChild(opt);
}

// ── Tab Switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Snap Toggle ───────────────────────────────────────────────────────────
document.getElementById('snap-toggle').addEventListener('change', e => {
  snapEnabled = e.target.checked;
});

// ── Canvas Click (deselect) ────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  if (e.target === canvas && isEditMode) deselectAll();
});

// ── Toolbar Buttons ────────────────────────────────────────────────────────
document.getElementById('add-pad-btn').addEventListener('click', () => spawnWidget('pad'));
document.getElementById('add-fader-btn').addEventListener('click', () => spawnWidget('fader'));
document.getElementById('add-knob-btn').addEventListener('click', () => spawnWidget('knob'));
document.getElementById('add-xy-btn').addEventListener('click', () => spawnWidget('xy'));
document.getElementById('add-toggle-btn').addEventListener('click', () => spawnWidget('toggle'));
document.getElementById('add-label-btn').addEventListener('click', () => spawnWidget('label'));
document.getElementById('duplicate-btn').addEventListener('click', duplicateSelected);
document.getElementById('delete-btn').addEventListener('click', deleteSelected);
document.getElementById('bring-forward-btn').addEventListener('click', () => adjustLayer(1));
document.getElementById('send-back-btn').addEventListener('click', () => adjustLayer(-1));
document.getElementById('align-left-btn').addEventListener('click', () => alignWidget('left'));
document.getElementById('align-center-btn').addEventListener('click', () => alignWidget('center-h'));
document.getElementById('align-right-btn').addEventListener('click', () => alignWidget('right'));
document.getElementById('align-top-btn').addEventListener('click', () => alignWidget('top'));
document.getElementById('align-middle-btn').addEventListener('click', () => alignWidget('center-v'));
document.getElementById('align-bottom-btn').addEventListener('click', () => alignWidget('bottom'));
document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('Clear all widgets?')) {
    canvas.innerHTML = '';
    selectedWidget = null;
    updateInspector();
  }
});

// ── Default Configs per Type ───────────────────────────────────────────────
const DEFAULTS = {
  pad:    { w: 150, h: 150, color: '#3a4a6b', radius: 12 },
  fader:  { w: 80,  h: 220, color: '#2d4a3e', radius: 8  },
  knob:   { w: 120, h: 120, color: '#4a3a6b', radius: 60 },
  xy:     { w: 200, h: 200, color: '#4a3d2d', radius: 8  },
  toggle: { w: 120, h: 80,  color: '#6b3a3a', radius: 8  },
  label:  { w: 150, h: 50,  color: '#1a1a1a', radius: 4  },
};

// ── Spawn Widget ───────────────────────────────────────────────────────────
function spawnWidget(type, config = {}) {
  const def = DEFAULTS[type];
  const el = document.createElement('div');
  widgetCount++;
  el.className = `widget widget-${type}`;
  el.id = `widget-${widgetCount}`;

  // Store dataset
  const cx = config.x !== undefined ? config.x : 20 + (widgetCount % 10) * 10;
  const cy = config.y !== undefined ? config.y : 20 + (widgetCount % 10) * 10;
  el.dataset.type        = type;
  el.dataset.x           = config.x !== undefined ? config.x : cx;
  el.dataset.y           = config.y !== undefined ? config.y : cy;
  el.dataset.cc          = config.cc !== undefined ? config.cc : (widgetCount % 128);
  el.dataset.ccY         = config.ccY !== undefined ? config.ccY : 15;
  el.dataset.channel     = config.channel || 1;
  el.dataset.label       = config.label || (type.charAt(0).toUpperCase() + type.slice(1));
  el.dataset.color       = config.color || def.color;
  el.dataset.labelColor  = config.labelColor || '#ffffff';
  el.dataset.fontSize    = config.fontSize || 14;
  el.dataset.borderColor = config.borderColor || '#666666';
  el.dataset.borderWidth = config.borderWidth !== undefined ? config.borderWidth : 2;
  el.dataset.borderRadius= config.borderRadius !== undefined ? config.borderRadius : def.radius;
  el.dataset.opacity     = config.opacity !== undefined ? config.opacity : 100;
  el.dataset.showLabel   = config.showLabel !== undefined ? config.showLabel : 'true';
  el.dataset.msgType     = config.msgType || 'cc';
  el.dataset.valMin      = config.valMin !== undefined ? config.valMin : 0;
  el.dataset.valMax      = config.valMax !== undefined ? config.valMax : 127;
  el.dataset.value       = config.value !== undefined ? config.value : 0;
  el.dataset.z           = config.z !== undefined ? config.z : 1;
  el.dataset.locked      = config.locked || 'false';

  const w = config.w || def.w;
  const h = config.h || def.h;
  const x = parseFloat(el.dataset.x);
  const y = parseFloat(el.dataset.y);

  el.style.width     = `${w}px`;
  el.style.height    = `${h}px`;
  el.style.transform = `translate(${x}px, ${y}px)`;

  applyWidgetStyles(el);
  buildWidgetDOM(el, type);
  wireWidgetEvents(el, type);

  el.addEventListener('mousedown', e => {
    if (isEditMode) {
      e.stopPropagation();
      selectWidget(el);
    }
  });

  canvas.appendChild(el);
  initInteract(el);

  return el;
}

// ── Apply Styles from Dataset ──────────────────────────────────────────────
function applyWidgetStyles(el) {
  el.style.backgroundColor = el.dataset.color;
  el.style.color           = el.dataset.labelColor;
  el.style.fontSize        = `${el.dataset.fontSize}px`;
  el.style.borderColor     = el.dataset.borderColor;
  el.style.borderWidth     = `${el.dataset.borderWidth}px`;
  el.style.borderStyle     = 'solid';
  el.style.borderRadius    = `${el.dataset.borderRadius}px`;
  el.style.opacity         = parseFloat(el.dataset.opacity) / 100;
  el.style.zIndex          = el.dataset.z;
}

// ── Build Widget DOM ───────────────────────────────────────────────────────
function buildWidgetDOM(el, type) {
  const showLabel = el.dataset.showLabel !== 'false';
  const labelText = el.dataset.label || '';
  const cc = el.dataset.cc;
  const ccY = el.dataset.ccY;

  switch (type) {
    case 'pad': {
      const lbl = document.createElement('div');
      lbl.className = 'widget-label';
      lbl.textContent = labelText;
      if (!showLabel) lbl.style.display = 'none';

      const tag = document.createElement('div');
      tag.className = 'widget-cc-tag';
      tag.textContent = `CC ${cc}`;

      el.appendChild(lbl);
      el.appendChild(tag);
      break;
    }
    case 'fader': {
      const lbl = document.createElement('div');
      lbl.className = 'widget-label';
      lbl.textContent = labelText;
      if (!showLabel) lbl.style.display = 'none';

      const track = document.createElement('div');
      track.className = 'fader-track';

      const fill = document.createElement('div');
      fill.className = 'fader-fill';

      const thumb = document.createElement('div');
      thumb.className = 'fader-thumb';

      track.appendChild(fill);
      track.appendChild(thumb);

      const tag = document.createElement('div');
      tag.className = 'widget-cc-tag';
      tag.textContent = `CC ${cc}`;

      el.appendChild(lbl);
      el.appendChild(track);
      el.appendChild(tag);

      // Set initial position
      const pct = (parseFloat(el.dataset.value) - parseFloat(el.dataset.valMin)) /
                  (parseFloat(el.dataset.valMax) - parseFloat(el.dataset.valMin));
      fill.style.height = `${pct * 100}%`;
      thumb.style.bottom = `${pct * 100}%`;
      break;
    }
    case 'knob': {
      const wrap = document.createElement('div');
      wrap.className = 'knob-svg-wrap';
      wrap.innerHTML = makeKnobSVG(
        parseFloat(el.dataset.value),
        parseFloat(el.dataset.valMin),
        parseFloat(el.dataset.valMax)
      );

      const lbl = document.createElement('div');
      lbl.className = 'widget-label';
      lbl.textContent = labelText;
      if (!showLabel) lbl.style.display = 'none';

      const tag = document.createElement('div');
      tag.className = 'widget-cc-tag';
      tag.textContent = `CC ${cc}`;

      el.appendChild(wrap);
      el.appendChild(lbl);
      el.appendChild(tag);
      break;
    }
    case 'xy': {
      const lbl = document.createElement('div');
      lbl.className = 'xy-label widget-label';
      lbl.textContent = labelText;
      if (!showLabel) lbl.style.display = 'none';

      const dot = document.createElement('div');
      dot.className = 'xy-dot';
      dot.style.left = '50%';
      dot.style.top = '50%';

      const tag = document.createElement('div');
      tag.className = 'widget-cc-tag';
      tag.textContent = `X:${cc} Y:${ccY}`;

      el.appendChild(lbl);
      el.appendChild(dot);
      el.appendChild(tag);
      break;
    }
    case 'toggle': {
      const lbl = document.createElement('div');
      lbl.className = 'widget-label';
      lbl.textContent = labelText;
      if (!showLabel) lbl.style.display = 'none';

      const state = document.createElement('div');
      state.className = 'toggle-state';
      state.textContent = 'OFF';

      const tag = document.createElement('div');
      tag.className = 'widget-cc-tag';
      tag.textContent = `CC ${cc}`;

      el.appendChild(lbl);
      el.appendChild(state);
      el.appendChild(tag);
      break;
    }
    case 'label': {
      const lbl = document.createElement('div');
      lbl.className = 'label-only widget-label';
      lbl.textContent = labelText;

      el.appendChild(lbl);
      break;
    }
  }
}

// ── Knob SVG ───────────────────────────────────────────────────────────────
function makeKnobSVG(value, min, max) {
  const range = max - min || 1;
  const pct = Math.max(0, Math.min(1, (value - min) / range));

  const startAngleDeg = -135;
  const endAngleDeg   =  135;
  const currentAngleDeg = startAngleDeg + pct * (endAngleDeg - startAngleDeg);

  // Convert polar angle to SVG coords: angle 0 = top, clockwise
  // toRad: degrees where 0=top, clockwise → standard math radians
  const toRad = (deg) => ((deg - 90) * Math.PI) / 180;

  const cx = 50, cy = 55, r = 38;

  const startRad   = toRad(startAngleDeg);
  const endRad     = toRad(endAngleDeg);
  const currentRad = toRad(currentAngleDeg);

  const sx = cx + r * Math.cos(startRad);
  const sy = cy + r * Math.sin(startRad);
  const ex = cx + r * Math.cos(endRad);
  const ey = cy + r * Math.sin(endRad);
  const vx = cx + r * Math.cos(currentRad);
  const vy = cy + r * Math.sin(currentRad);

  // Full track arc: start → end (270° arc)
  const trackLargeArc = 1; // 270° > 180°
  const trackSweep    = 1;

  // Value arc: start → current
  const arcSpan = currentAngleDeg - startAngleDeg; // 0 to 270
  const valueLargeArc = arcSpan > 180 ? 1 : 0;
  const valueSweep    = 1;

  // Indicator dot position
  const dotX = cx + r * Math.cos(currentRad);
  const dotY = cy + r * Math.sin(currentRad);

  return `<svg class="knob-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M ${sx} ${sy} A ${r} ${r} 0 ${trackLargeArc} ${trackSweep} ${ex} ${ey}"
      fill="none" stroke="#252525" stroke-width="8" stroke-linecap="round"/>
    ${pct > 0 ? `<path d="M ${sx} ${sy} A ${r} ${r} 0 ${valueLargeArc} ${valueSweep} ${vx} ${vy}"
      fill="none" stroke="#4a9eff" stroke-width="8" stroke-linecap="round"/>` : ''}
    <circle cx="${cx}" cy="${cy}" r="22" fill="#1a1a2e" stroke="#333" stroke-width="1"/>
    <circle cx="${dotX}" cy="${dotY}" r="4" fill="white"/>
  </svg>`;
}

function updateKnobSVG(el) {
  const wrap = el.querySelector('.knob-svg-wrap');
  if (!wrap) return;
  wrap.innerHTML = makeKnobSVG(
    parseFloat(el.dataset.value),
    parseFloat(el.dataset.valMin),
    parseFloat(el.dataset.valMax)
  );
}

// ── Wire Widget Events ─────────────────────────────────────────────────────
function wireWidgetEvents(el, type) {
  switch (type) {
    case 'pad':
      el.addEventListener('mousedown', e => {
        if (isEditMode) return;
        el.classList.add('active');
        sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, el.dataset.valMax);
      });
      el.addEventListener('mouseup', () => {
        if (isEditMode) return;
        el.classList.remove('active');
        sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, el.dataset.valMin);
      });
      el.addEventListener('mouseleave', () => {
        if (isEditMode) return;
        el.classList.remove('active');
        sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, el.dataset.valMin);
      });
      break;

    case 'fader':
      el.addEventListener('mousedown', e => {
        if (isEditMode) return;
        e.preventDefault();
        const val = parseFloat(el.dataset.value);
        activeFaderDrag = { el, startY: e.clientY, startVal: val };
      });
      break;

    case 'knob':
      el.addEventListener('mousedown', e => {
        if (isEditMode) return;
        e.preventDefault();
        activeKnobDrag = {
          el,
          startY: e.clientY,
          startVal: parseFloat(el.dataset.value)
        };
      });
      break;

    case 'xy':
      el.addEventListener('mousedown', e => {
        if (isEditMode) return;
        e.preventDefault();
        activeXYDrag = { el };
        updateXY(e, el);
      });
      break;

    case 'toggle':
      el.addEventListener('click', () => {
        if (isEditMode) return;
        const isOn = el.classList.contains('toggle-on');
        if (isOn) {
          el.classList.remove('toggle-on');
          el.dataset.value = el.dataset.valMin;
          const s = el.querySelector('.toggle-state');
          if (s) s.textContent = 'OFF';
          sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, el.dataset.valMin);
        } else {
          el.classList.add('toggle-on');
          el.dataset.value = el.dataset.valMax;
          const s = el.querySelector('.toggle-state');
          if (s) s.textContent = 'ON';
          sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, el.dataset.valMax);
        }
      });
      break;

    case 'label':
      // No interaction
      break;
  }
}

// ── XY Update ─────────────────────────────────────────────────────────────
function updateXY(e, el) {
  const rect = el.getBoundingClientRect();
  const px = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const py = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  const min = parseFloat(el.dataset.valMin);
  const max = parseFloat(el.dataset.valMax);
  const xVal = Math.round(min + px * (max - min));
  const yVal = Math.round(max - py * (max - min)); // inverted Y

  const dot = el.querySelector('.xy-dot');
  if (dot) {
    dot.style.left = `${px * 100}%`;
    dot.style.top  = `${py * 100}%`;
  }

  sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc,  xVal);
  sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.ccY, yVal);
}

// ── Global Drag Handlers ───────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  if (activeFaderDrag) {
    const { el, startY, startVal } = activeFaderDrag;
    const rect = el.querySelector('.fader-track').getBoundingClientRect();
    const py = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    const min = parseFloat(el.dataset.valMin);
    const max = parseFloat(el.dataset.valMax);
    const val = Math.round(min + py * (max - min));
    el.dataset.value = val;
    const fill  = el.querySelector('.fader-fill');
    const thumb = el.querySelector('.fader-thumb');
    if (fill)  fill.style.height = `${py * 100}%`;
    if (thumb) thumb.style.bottom = `${py * 100}%`;
    sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, val);
  }

  if (activeKnobDrag) {
    const { el, startY, startVal } = activeKnobDrag;
    const delta = startY - e.clientY;
    const min = parseFloat(el.dataset.valMin);
    const max = parseFloat(el.dataset.valMax);
    const newVal = Math.max(min, Math.min(max, startVal + delta));
    el.dataset.value = Math.round(newVal);
    updateKnobSVG(el);
    sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, Math.round(newVal));
  }

  if (activeXYDrag) {
    updateXY(e, activeXYDrag.el);
  }
});

document.addEventListener('mouseup', () => {
  activeFaderDrag = null;
  activeKnobDrag  = null;
  activeXYDrag    = null;
});

// ── interact.js ────────────────────────────────────────────────────────────
function initInteract(el) {
  if (!window.interact) return;

  interact(el)
    .draggable({
      enabled: isEditMode && el.dataset.locked !== 'true',
      modifiers: [
        interact.modifiers.restrictRect({ restriction: 'parent' }),
      ],
      listeners: {
        move: dragMoveListener,
      }
    })
    .resizable({
      enabled: isEditMode && el.dataset.locked !== 'true',
      edges: { left: true, right: true, bottom: true, top: true },
      modifiers: [
        interact.modifiers.restrictEdges({ outer: 'parent' }),
        interact.modifiers.restrictSize({ min: { width: 40, height: 40 } }),
      ],
      listeners: {
        move: resizeMoveListener,
      }
    });
}

function dragMoveListener(event) {
  const target = event.target;
  if (target.dataset.locked === 'true') return;

  let x = parseFloat(target.dataset.x) || 0;
  let y = parseFloat(target.dataset.y) || 0;

  x += event.dx;
  y += event.dy;

  if (snapEnabled) {
    x = Math.round(x / GRID_SIZE) * GRID_SIZE;
    y = Math.round(y / GRID_SIZE) * GRID_SIZE;
  }

  target.style.transform = `translate(${x}px, ${y}px)`;
  target.dataset.x = x;
  target.dataset.y = y;

  if (selectedWidget === target) syncLayoutInputs(target);
}

function resizeMoveListener(event) {
  const target = event.target;
  let x = parseFloat(target.dataset.x) || 0;
  let y = parseFloat(target.dataset.y) || 0;

  target.style.width  = `${event.rect.width}px`;
  target.style.height = `${event.rect.height}px`;

  x += event.deltaRect.left;
  y += event.deltaRect.top;

  target.style.transform = `translate(${x}px, ${y}px)`;
  target.dataset.x = x;
  target.dataset.y = y;

  if (selectedWidget === target) syncLayoutInputs(target);
}

// ── Selection ──────────────────────────────────────────────────────────────
function selectWidget(el) {
  deselectAll();
  selectedWidget = el;
  el.classList.add('selected');
  updateInspector();
}

function deselectAll() {
  document.querySelectorAll('.widget.selected').forEach(w => w.classList.remove('selected'));
  selectedWidget = null;
  updateInspector();
}

// ── Inspector ──────────────────────────────────────────────────────────────
function updateInspector() {
  if (!selectedWidget) {
    inspectorPanels.style.display = 'none';
    noSelectionMsg.style.display = 'block';
    return;
  }
  inspectorPanels.style.display = 'flex';
  noSelectionMsg.style.display = 'none';

  const d = selectedWidget.dataset;
  const type = d.type;

  inspectorTitle.textContent = type.charAt(0).toUpperCase() + type.slice(1);
  typeBadge.textContent = type.toUpperCase();

  xyCCRow.style.display = type === 'xy' ? '' : 'none';

  // Style tab
  setValue('prop-text', d.label || '');
  setValue('prop-font-size', d.fontSize);
  setValue('prop-label-color', d.labelColor);
  setValue('prop-color', d.color);
  setValue('prop-opacity', d.opacity);
  document.getElementById('prop-opacity-val').textContent = `${d.opacity}%`;
  setValue('prop-border-color', d.borderColor);
  setValue('prop-border-width', d.borderWidth);
  document.getElementById('prop-border-width-val').textContent = `${d.borderWidth}px`;
  setValue('prop-border-radius', d.borderRadius);
  document.getElementById('prop-border-radius-val').textContent = `${d.borderRadius}px`;
  document.getElementById('prop-show-label').checked = d.showLabel !== 'false';

  // MIDI tab
  setValue('prop-channel', d.channel);
  setValue('prop-cc', d.cc);
  setValue('prop-cc-y', d.ccY);
  setValue('prop-val-min', d.valMin);
  setValue('prop-val-max', d.valMax);
  setValue('prop-msg-type', d.msgType);

  // Layout tab
  syncLayoutInputs(selectedWidget);
  document.getElementById('prop-lock').checked = d.locked === 'true';
  setValue('prop-z', d.z);
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function syncLayoutInputs(el) {
  const w = parseFloat(el.style.width)  || 0;
  const h = parseFloat(el.style.height) || 0;
  setValue('prop-x', Math.round(parseFloat(el.dataset.x) || 0));
  setValue('prop-y', Math.round(parseFloat(el.dataset.y) || 0));
  setValue('prop-w', Math.round(w));
  setValue('prop-h', Math.round(h));
}

// ── Bind Inspector Inputs ──────────────────────────────────────────────────
function bindInspector() {
  function bind(id, event, callback) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(event, e => {
      if (!selectedWidget) return;
      callback(e, selectedWidget);
    });
  }

  bind('prop-text', 'input', (e, w) => {
    w.dataset.label = e.target.value;
    const lbl = w.querySelector('.widget-label');
    if (lbl) lbl.textContent = e.target.value;
  });

  bind('prop-font-size', 'input', (e, w) => {
    w.dataset.fontSize = e.target.value;
    w.style.fontSize = `${e.target.value}px`;
  });

  bind('prop-label-color', 'input', (e, w) => {
    w.dataset.labelColor = e.target.value;
    w.style.color = e.target.value;
  });

  bind('prop-color', 'input', (e, w) => {
    w.dataset.color = e.target.value;
    w.style.backgroundColor = e.target.value;
  });

  bind('prop-opacity', 'input', (e, w) => {
    const val = e.target.value;
    w.dataset.opacity = val;
    w.style.opacity = val / 100;
    document.getElementById('prop-opacity-val').textContent = `${val}%`;
  });

  bind('prop-border-color', 'input', (e, w) => {
    w.dataset.borderColor = e.target.value;
    w.style.borderColor = e.target.value;
  });

  bind('prop-border-width', 'input', (e, w) => {
    const val = e.target.value;
    w.dataset.borderWidth = val;
    w.style.borderWidth = `${val}px`;
    document.getElementById('prop-border-width-val').textContent = `${val}px`;
  });

  bind('prop-border-radius', 'input', (e, w) => {
    const val = e.target.value;
    w.dataset.borderRadius = val;
    w.style.borderRadius = `${val}px`;
    document.getElementById('prop-border-radius-val').textContent = `${val}px`;
  });

  bind('prop-show-label', 'change', (e, w) => {
    w.dataset.showLabel = e.target.checked ? 'true' : 'false';
    const lbl = w.querySelector('.widget-label');
    if (lbl) lbl.style.display = e.target.checked ? '' : 'none';
  });

  bind('prop-channel', 'change', (e, w) => {
    w.dataset.channel = e.target.value;
  });

  bind('prop-cc', 'input', (e, w) => {
    w.dataset.cc = e.target.value;
    const tag = w.querySelector('.widget-cc-tag');
    if (tag) {
      if (w.dataset.type === 'xy') {
        tag.textContent = `X:${w.dataset.cc} Y:${w.dataset.ccY}`;
      } else {
        tag.textContent = `CC ${w.dataset.cc}`;
      }
    }
  });

  bind('prop-cc-y', 'input', (e, w) => {
    w.dataset.ccY = e.target.value;
    const tag = w.querySelector('.widget-cc-tag');
    if (tag && w.dataset.type === 'xy') {
      tag.textContent = `X:${w.dataset.cc} Y:${w.dataset.ccY}`;
    }
  });

  bind('prop-val-min', 'input', (e, w) => {
    w.dataset.valMin = e.target.value;
    if (w.dataset.type === 'knob') updateKnobSVG(w);
  });

  bind('prop-val-max', 'input', (e, w) => {
    w.dataset.valMax = e.target.value;
    if (w.dataset.type === 'knob') updateKnobSVG(w);
  });

  bind('prop-msg-type', 'change', (e, w) => {
    w.dataset.msgType = e.target.value;
  });

  bind('prop-x', 'input', (e, w) => {
    const val = parseFloat(e.target.value) || 0;
    w.dataset.x = val;
    const y = parseFloat(w.dataset.y) || 0;
    w.style.transform = `translate(${val}px, ${y}px)`;
  });

  bind('prop-y', 'input', (e, w) => {
    const val = parseFloat(e.target.value) || 0;
    w.dataset.y = val;
    const x = parseFloat(w.dataset.x) || 0;
    w.style.transform = `translate(${x}px, ${val}px)`;
  });

  bind('prop-w', 'input', (e, w) => {
    const val = Math.max(40, parseFloat(e.target.value) || 40);
    w.style.width = `${val}px`;
  });

  bind('prop-h', 'input', (e, w) => {
    const val = Math.max(40, parseFloat(e.target.value) || 40);
    w.style.height = `${val}px`;
  });

  bind('prop-lock', 'change', (e, w) => {
    w.dataset.locked = e.target.checked ? 'true' : 'false';
    if (window.interact) {
      const locked = e.target.checked;
      interact(w).draggable({ enabled: isEditMode && !locked });
      interact(w).resizable({ enabled: isEditMode && !locked });
    }
  });

  bind('prop-z', 'input', (e, w) => {
    const val = Math.max(0, Math.min(999, parseInt(e.target.value) || 0));
    w.dataset.z = val;
    w.style.zIndex = val;
  });
}

// ── Edit Operations ────────────────────────────────────────────────────────
function duplicateSelected() {
  if (!selectedWidget) return;
  const d = selectedWidget.dataset;
  const newEl = spawnWidget(d.type, {
    x: parseFloat(d.x) + 20,
    y: parseFloat(d.y) + 20,
    cc: d.cc,
    ccY: d.ccY,
    channel: d.channel,
    label: (d.label || '') + ' copy',
    color: d.color,
    labelColor: d.labelColor,
    fontSize: d.fontSize,
    borderColor: d.borderColor,
    borderWidth: d.borderWidth,
    borderRadius: d.borderRadius,
    opacity: d.opacity,
    showLabel: d.showLabel,
    msgType: d.msgType,
    valMin: d.valMin,
    valMax: d.valMax,
    value: d.value,
    z: d.z,
    locked: d.locked,
    w: parseFloat(selectedWidget.style.width),
    h: parseFloat(selectedWidget.style.height),
  });
  selectWidget(newEl);
}

function deleteSelected() {
  if (!selectedWidget) return;
  selectedWidget.remove();
  selectedWidget = null;
  updateInspector();
}

function adjustLayer(dir) {
  if (!selectedWidget) return;
  const current = parseInt(selectedWidget.dataset.z) || 1;
  const newZ = Math.max(0, Math.min(999, current + dir));
  selectedWidget.dataset.z = newZ;
  selectedWidget.style.zIndex = newZ;
  setValue('prop-z', newZ);
}

function alignWidget(direction) {
  if (!selectedWidget) return;
  const canvasW = canvas.clientWidth;
  const canvasH = canvas.clientHeight;
  const w = parseFloat(selectedWidget.style.width)  || 0;
  const h = parseFloat(selectedWidget.style.height) || 0;

  let x = parseFloat(selectedWidget.dataset.x) || 0;
  let y = parseFloat(selectedWidget.dataset.y) || 0;

  switch (direction) {
    case 'left':     x = 0; break;
    case 'center-h': x = (canvasW - w) / 2; break;
    case 'right':    x = canvasW - w; break;
    case 'top':      y = 0; break;
    case 'center-v': y = (canvasH - h) / 2; break;
    case 'bottom':   y = canvasH - h; break;
  }

  selectedWidget.dataset.x = x;
  selectedWidget.dataset.y = y;
  selectedWidget.style.transform = `translate(${x}px, ${y}px)`;
  syncLayoutInputs(selectedWidget);
}

// ── Init ───────────────────────────────────────────────────────────────────
bindInspector();
updateInspector();
