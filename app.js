// ── Module State ──────────────────────────────────────────────────────────────
let isEditMode      = false;
let widgetCount     = 0;
let selectedWidget  = null;
let snapEnabled     = false;
const GRID_SIZE     = 10;

// Multi-page state
let pages            = [{ id: 'page_0', name: 'Page 1' }];
let currentPageIndex = 0;

// Global drag state — one set of document-level handlers, no accumulation
let activeFaderDrag = null;   // { el }
let activeKnobDrag  = null;   // { el, startY, startVal }
let activeXYDrag    = null;   // { el }

// ── WebSocket ─────────────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
let socket     = null;

function connectWebSocket() {
  try {
    const wsHost = window.location.hostname || '127.0.0.1';
    socket = new WebSocket(`ws://${wsHost}:8080`);

    socket.addEventListener('open', () => {
      statusEl.textContent = 'MIDI Connected';
      statusEl.className   = 'status-connected';
    });

    socket.addEventListener('close', () => {
      statusEl.textContent = 'Disconnected — retrying…';
      statusEl.className   = 'status-error';
      setTimeout(connectWebSocket, 3000);
    });

    socket.addEventListener('error', () => {
      statusEl.textContent = 'No Bridge';
      statusEl.className   = 'status-error';
    });

    // Listen for server-pushed messages
    socket.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'osc_status') {
          const dot = document.getElementById('osc-dot');
          if (dot) dot.classList.add('active');
          document.getElementById('osc-ip').value   = data.ip;
          document.getElementById('osc-port').value = data.port;
        } else if (data.type === 'sync_layout') {
          // Another window pushed a layout change — apply it silently
          loadLayout(data.layout);
        }
      } catch (_) {}
    });
  } catch (e) {
    statusEl.textContent = 'No Bridge';
    statusEl.className   = 'status-error';
  }
}

connectWebSocket();

// ── Send Helpers ──────────────────────────────────────────────────────────────
function sendMidi(type, channel, controller, value) {
  if (isEditMode) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type,
    channel:    parseInt(channel),
    controller: parseInt(controller),
    value:      parseInt(value),
  }));
}

function sendOSC(address, value) {
  if (isEditMode || !address) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'osc', address, value: parseInt(value) }));
}

// ── OSC Config ────────────────────────────────────────────────────────────────
document.getElementById('osc-apply-btn').addEventListener('click', () => {
  const ip   = document.getElementById('osc-ip').value.trim();
  const port = parseInt(document.getElementById('osc-port').value);
  if (!ip || !port) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'config_osc', ip, port }));
  }
});

// ── Page Helpers ──────────────────────────────────────────────────────────────
function getCurrentLayer() {
  return document.getElementById(pages[currentPageIndex].id);
}

function initFirstPage() {
  const layer = document.createElement('div');
  layer.className = 'page-layer active';
  layer.id        = pages[0].id;
  document.getElementById('canvas').appendChild(layer);
  renderPageTabs();
}

function renderPageTabs() {
  const bar = document.getElementById('page-tabs-bar');
  bar.innerHTML = '';

  pages.forEach((page, i) => {
    const tab = document.createElement('div');
    tab.className = 'page-tab' + (i === currentPageIndex ? ' active' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className   = 'page-tab-name';
    nameSpan.textContent = page.name;

    if (isEditMode) {
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenaming(i, nameSpan);
      });
    }

    tab.appendChild(nameSpan);
    tab.addEventListener('click', () => switchPage(i));

    if (isEditMode && pages.length > 1) {
      const closeBtn       = document.createElement('span');
      closeBtn.className   = 'page-tab-close';
      closeBtn.textContent = '×';
      closeBtn.title       = 'Delete page';
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); deletePage(i); });
      tab.appendChild(closeBtn);
    }

    bar.appendChild(tab);
  });

  if (isEditMode) {
    const addBtn       = document.createElement('div');
    addBtn.className   = 'page-tab-add';
    addBtn.textContent = '+ Page';
    addBtn.addEventListener('click', addPage);
    bar.appendChild(addBtn);
  }
}

function switchPage(index) {
  if (index === currentPageIndex || index < 0 || index >= pages.length) return;
  deselectAll();
  getCurrentLayer().classList.remove('active');
  currentPageIndex = index;
  getCurrentLayer().classList.add('active');
  renderPageTabs();
}

function addPage() {
  const id   = 'page_' + Date.now();
  const name = 'Page ' + (pages.length + 1);
  pages.push({ id, name });

  const layer       = document.createElement('div');
  layer.className   = 'page-layer';
  layer.id          = id;
  document.getElementById('canvas').appendChild(layer);

  // Switch to the new page immediately
  getCurrentLayer().classList.remove('active');
  currentPageIndex = pages.length - 1;
  getCurrentLayer().classList.add('active');
  renderPageTabs();
}

function deletePage(index) {
  if (pages.length <= 1) return;
  if (!confirm(`Delete "${pages[index].name}" and all its widgets?`)) return;

  const layer = document.getElementById(pages[index].id);
  if (layer) layer.remove();
  pages.splice(index, 1);

  if (currentPageIndex >= pages.length) currentPageIndex = pages.length - 1;

  // Re-activate correct layer
  document.querySelectorAll('.page-layer').forEach(l => l.classList.remove('active'));
  const active = document.getElementById(pages[currentPageIndex].id);
  if (active) active.classList.add('active');

  deselectAll();
  renderPageTabs();
}

function startRenaming(index, nameSpan) {
  const input   = document.createElement('input');
  input.type      = 'text';
  input.value     = pages[index].name;
  input.className = 'page-tab-rename';
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const v = input.value.trim();
    if (v) pages[index].name = v;
    renderPageTabs();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  commit();
    if (e.key === 'Escape') renderPageTabs();
    e.stopPropagation();
  });
}

// ── Edit Mode Toggle ──────────────────────────────────────────────────────────
const toggleBtn = document.getElementById('mode-toggle-btn');
const canvas    = document.getElementById('canvas');

toggleBtn.addEventListener('click', () => {
  isEditMode = !isEditMode;
  document.body.classList.toggle('edit-mode', isEditMode);
  toggleBtn.classList.toggle('active', isEditMode);
  toggleBtn.textContent = isEditMode ? 'Exit Edit Mode' : 'Edit Mode';

  if (!isEditMode) deselectAll();

  document.querySelectorAll('.widget').forEach(el => {
    const locked = el.dataset.locked === 'true';
    interact(el).draggable({ enabled: isEditMode && !locked });
    interact(el).resizable({ enabled: isEditMode && !locked });
  });

  renderPageTabs(); // re-render so +Page / close buttons appear/disappear
});

// ── Save / Load ───────────────────────────────────────────────────────────────
document.getElementById('sync-btn').addEventListener('click', syncLayout);
document.getElementById('save-btn').addEventListener('click', saveLayout);
document.getElementById('load-btn').addEventListener('click', () => {
  document.getElementById('load-file-input').click();
});
document.getElementById('load-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      loadLayout(JSON.parse(ev.target.result));
    } catch (err) {
      alert('Could not load file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset so same file can be re-loaded
});

function saveLayout() {
  const data = {
    version: 2,
    savedAt: new Date().toISOString(),
    pages: pages.map((page) => {
      const layer   = document.getElementById(page.id);
      const widgets = layer
        ? Array.from(layer.querySelectorAll('.widget')).map(serializeWidget)
        : [];
      return { id: page.id, name: page.name, widgets };
    }),
    currentPage: currentPageIndex,
  };

  // Broadcast to other connected windows
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'sync_layout', layout: data }));
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'midi-surface.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function syncLayout() {
  const data = {
    version: 2,
    savedAt: new Date().toISOString(),
    pages: pages.map((page) => {
      const layer   = document.getElementById(page.id);
      const widgets = layer
        ? Array.from(layer.querySelectorAll('.widget')).map(serializeWidget)
        : [];
      return { id: page.id, name: page.name, widgets };
    }),
    currentPage: currentPageIndex,
  };
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'sync_layout', layout: data }));
  }
}

function serializeWidget(el) {
  return {
    id:           el.id,
    type:         el.dataset.type,
    x:            parseFloat(el.dataset.x),
    y:            parseFloat(el.dataset.y),
    w:            parseFloat(el.style.width),
    h:            parseFloat(el.style.height),
    cc:           el.dataset.cc,
    ccY:          el.dataset.ccY,
    channel:      el.dataset.channel,
    label:        el.dataset.label,
    color:        el.dataset.color,
    labelColor:   el.dataset.labelColor,
    fontSize:     el.dataset.fontSize,
    borderColor:  el.dataset.borderColor,
    borderWidth:  el.dataset.borderWidth,
    borderRadius: el.dataset.borderRadius,
    opacity:      el.dataset.opacity,
    showLabel:    el.dataset.showLabel,
    msgType:      el.dataset.msgType,
    valMin:       el.dataset.valMin,
    valMax:       el.dataset.valMax,
    value:        el.dataset.value,
    z:            el.dataset.z,
    locked:       el.dataset.locked,
    oscAddress:   el.dataset.oscAddress,
    oscAddressY:  el.dataset.oscAddressY,
  };
}

function loadLayout(data) {
  if (!data.pages || !Array.isArray(data.pages)) {
    alert('Invalid layout file.');
    return;
  }

  // Clear everything
  canvas.innerHTML = '';
  pages            = [];
  currentPageIndex = 0;
  selectedWidget   = null;
  widgetCount      = 0;

  data.pages.forEach((pageData, i) => {
    pages.push({ id: pageData.id, name: pageData.name });

    const layer       = document.createElement('div');
    layer.className   = 'page-layer' + (i === 0 ? ' active' : '');
    layer.id          = pageData.id;
    canvas.appendChild(layer);

    (pageData.widgets || []).forEach(wData => {
      spawnWidget(wData.type, wData, layer);
    });
  });

  currentPageIndex = Math.min(data.currentPage || 0, pages.length - 1);

  // Make correct layer active
  document.querySelectorAll('.page-layer').forEach((l, i) => {
    l.classList.toggle('active', i === currentPageIndex);
  });

  renderPageTabs();
  updateInspector();
}

// ── MIDI Channel Select ───────────────────────────────────────────────────────
const channelSelect = document.getElementById('prop-channel');
for (let i = 1; i <= 16; i++) {
  const opt      = document.createElement('option');
  opt.value      = i;
  opt.textContent = `Ch ${i}`;
  channelSelect.appendChild(opt);
}

// ── Tab Switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Snap Toggle ───────────────────────────────────────────────────────────────
document.getElementById('snap-toggle').addEventListener('change', e => {
  snapEnabled = e.target.checked;
});

// ── Toolbar Buttons ───────────────────────────────────────────────────────────
document.getElementById('add-pad-btn').addEventListener('click',    () => spawnWidget('pad'));
document.getElementById('add-fader-btn').addEventListener('click',  () => spawnWidget('fader'));
document.getElementById('add-knob-btn').addEventListener('click',   () => spawnWidget('knob'));
document.getElementById('add-xy-btn').addEventListener('click',     () => spawnWidget('xy'));
document.getElementById('add-toggle-btn').addEventListener('click', () => spawnWidget('toggle'));
document.getElementById('add-label-btn').addEventListener('click',  () => spawnWidget('label'));
document.getElementById('duplicate-btn').addEventListener('click',  duplicateSelected);
document.getElementById('delete-btn').addEventListener('click',     deleteSelected);
document.getElementById('bring-forward-btn').addEventListener('click', () => adjustLayer(1));
document.getElementById('send-back-btn').addEventListener('click',     () => adjustLayer(-1));
document.getElementById('align-left-btn').addEventListener('click',   () => alignWidget('left'));
document.getElementById('align-center-btn').addEventListener('click', () => alignWidget('center-h'));
document.getElementById('align-right-btn').addEventListener('click',  () => alignWidget('right'));
document.getElementById('align-top-btn').addEventListener('click',    () => alignWidget('top'));
document.getElementById('align-middle-btn').addEventListener('click', () => alignWidget('center-v'));
document.getElementById('align-bottom-btn').addEventListener('click', () => alignWidget('bottom'));

document.getElementById('clear-btn').addEventListener('click', () => {
  if (!confirm('Clear all widgets on this page?')) return;
  getCurrentLayer().innerHTML = '';
  selectedWidget = null;
  updateInspector();
});

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULTS = {
  pad:    { w: 150, h: 150, color: '#3a4a6b', radius: 12 },
  fader:  { w: 80,  h: 220, color: '#2d4a3e', radius: 8  },
  knob:   { w: 120, h: 120, color: '#4a3a6b', radius: 60 },
  xy:     { w: 200, h: 200, color: '#4a3d2d', radius: 8  },
  toggle: { w: 120, h: 80,  color: '#6b3a3a', radius: 8  },
  label:  { w: 150, h: 50,  color: '#1a1a1a', radius: 4  },
};

// ── Spawn Widget ──────────────────────────────────────────────────────────────
// targetLayer is optional — defaults to getCurrentLayer()
function spawnWidget(type, cfg = {}, targetLayer = null) {
  const def   = DEFAULTS[type];
  const layer = targetLayer || getCurrentLayer();

  widgetCount++;
  const el   = document.createElement('div');
  el.className = `widget widget-${type}`;
  el.id        = cfg.id || `widget-${widgetCount}`;

  const x = cfg.x !== undefined ? cfg.x : 20;
  const y = cfg.y !== undefined ? cfg.y : 20;
  const w = cfg.w || def.w;
  const h = cfg.h || def.h;

  el.style.width     = `${w}px`;
  el.style.height    = `${h}px`;
  el.style.transform = `translate(${x}px, ${y}px)`;

  const cc  = cfg.cc  !== undefined ? cfg.cc  : (widgetCount % 128);
  const ccY = cfg.ccY !== undefined ? cfg.ccY : ((parseInt(cc) + 1) % 128);

  el.dataset.type         = type;
  el.dataset.x            = x;
  el.dataset.y            = y;
  el.dataset.cc           = cc;
  el.dataset.ccY          = ccY;
  el.dataset.channel      = cfg.channel      || 1;
  el.dataset.label        = cfg.label        || (type.charAt(0).toUpperCase() + type.slice(1));
  el.dataset.color        = cfg.color        || def.color;
  el.dataset.labelColor   = cfg.labelColor   || '#ffffff';
  el.dataset.fontSize     = cfg.fontSize     || 14;
  el.dataset.borderColor  = cfg.borderColor  || '#555555';
  el.dataset.borderWidth  = cfg.borderWidth  !== undefined ? cfg.borderWidth  : 2;
  el.dataset.borderRadius = cfg.borderRadius !== undefined ? cfg.borderRadius : def.radius;
  el.dataset.opacity      = cfg.opacity      !== undefined ? cfg.opacity      : 100;
  el.dataset.showLabel    = cfg.showLabel    !== undefined ? cfg.showLabel    : 'true';
  el.dataset.msgType      = cfg.msgType      || 'cc';
  el.dataset.valMin       = cfg.valMin       !== undefined ? cfg.valMin       : 0;
  el.dataset.valMax       = cfg.valMax       !== undefined ? cfg.valMax       : 127;
  el.dataset.value        = cfg.value        !== undefined ? cfg.value        : 0;
  el.dataset.z            = cfg.z            !== undefined ? cfg.z            : 1;
  el.dataset.locked       = cfg.locked       || 'false';
  el.dataset.oscAddress   = cfg.oscAddress   || `/cc/${el.dataset.channel}/${el.dataset.cc}`;
  el.dataset.oscAddressY  = cfg.oscAddressY  || `/cc/${el.dataset.channel}/${el.dataset.ccY}`;

  applyWidgetStyles(el);
  buildWidgetDOM(el, type);
  wireWidgetEvents(el, type);

  el.addEventListener('mousedown', e => {
    if (isEditMode) {
      e.stopPropagation();
      selectWidget(el);
    }
  });

  layer.appendChild(el);
  initInteract(el);
  return el;
}

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

// ── Build Widget DOM ──────────────────────────────────────────────────────────
function buildWidgetDOM(el, type) {
  const showLabel = el.dataset.showLabel !== 'false';
  const labelText = el.dataset.label || '';
  const cc        = el.dataset.cc;
  const ccY       = el.dataset.ccY;

  function mkLabel(cls = 'widget-label') {
    const s         = document.createElement('div');
    s.className     = cls;
    s.textContent   = labelText;
    if (!showLabel) s.style.display = 'none';
    return s;
  }

  function mkTag(text) {
    const s       = document.createElement('div');
    s.className   = 'widget-cc-tag';
    s.textContent = text;
    return s;
  }

  switch (type) {
    case 'pad':
      el.appendChild(mkLabel());
      el.appendChild(mkTag(`CC ${cc}`));
      break;

    case 'fader': {
      const track = document.createElement('div');
      track.className = 'fader-track';
      const fill      = document.createElement('div');
      fill.className  = 'fader-fill';
      const thumb     = document.createElement('div');
      thumb.className = 'fader-thumb';
      track.appendChild(fill);
      track.appendChild(thumb);

      const pct = (parseFloat(el.dataset.value) - parseFloat(el.dataset.valMin)) /
                  Math.max(1, parseFloat(el.dataset.valMax) - parseFloat(el.dataset.valMin));
      fill.style.height  = `${pct * 100}%`;
      thumb.style.bottom = `${pct * 100}%`;

      el.appendChild(mkLabel());
      el.appendChild(track);
      el.appendChild(mkTag(`CC ${cc}`));
      break;
    }

    case 'knob': {
      const wrap      = document.createElement('div');
      wrap.className  = 'knob-svg-wrap';
      wrap.innerHTML  = makeKnobSVG(
        parseFloat(el.dataset.value),
        parseFloat(el.dataset.valMin),
        parseFloat(el.dataset.valMax)
      );
      el.appendChild(wrap);
      el.appendChild(mkLabel());
      el.appendChild(mkTag(`CC ${cc}`));
      break;
    }

    case 'xy': {
      const lbl     = mkLabel('xy-label widget-label');
      const dot     = document.createElement('div');
      dot.className = 'xy-dot';
      dot.style.left = '50%';
      dot.style.top  = '50%';
      const hLine     = document.createElement('div');
      hLine.className = 'xy-h-line';
      const vLine     = document.createElement('div');
      vLine.className = 'xy-v-line';

      el.appendChild(lbl);
      el.appendChild(hLine);
      el.appendChild(vLine);
      el.appendChild(dot);
      el.appendChild(mkTag(`X:${cc} Y:${ccY}`));
      break;
    }

    case 'toggle': {
      const state       = document.createElement('div');
      state.className   = 'toggle-state';
      state.textContent = 'OFF';
      el.appendChild(mkLabel());
      el.appendChild(state);
      el.appendChild(mkTag(`CC ${cc}`));
      break;
    }

    case 'label':
      el.appendChild(mkLabel('label-only widget-label'));
      break;
  }
}

// ── Knob SVG ──────────────────────────────────────────────────────────────────
function makeKnobSVG(value, min, max) {
  const range = max - min || 1;
  const pct   = Math.max(0, Math.min(1, (value - min) / range));

  const startDeg   = -135;
  const endDeg     =  135;
  const currentDeg = startDeg + pct * (endDeg - startDeg);

  // angle 0 = 12-o'clock, clockwise → SVG polar
  const toRad = (deg) => ((deg - 90) * Math.PI) / 180;

  const cx = 50, cy = 55, r = 38;

  const sRad = toRad(startDeg);
  const eRad = toRad(endDeg);
  const cRad = toRad(currentDeg);

  const sx = cx + r * Math.cos(sRad);
  const sy = cy + r * Math.sin(sRad);
  const ex = cx + r * Math.cos(eRad);
  const ey = cy + r * Math.sin(eRad);
  const vx = cx + r * Math.cos(cRad);
  const vy = cy + r * Math.sin(cRad);

  // Indicator dot slightly inside the track ring
  const dotR = 26;
  const dotX = cx + dotR * Math.cos(cRad);
  const dotY = cy + dotR * Math.sin(cRad);

  const arcSpan    = currentDeg - startDeg;  // 0 → 270
  const valLargeArc = arcSpan > 180 ? 1 : 0;

  const valuePath = pct > 0
    ? `<path d="M ${sx} ${sy} A ${r} ${r} 0 ${valLargeArc} 1 ${vx} ${vy}"
         fill="none" stroke="#4a9eff" stroke-width="8" stroke-linecap="round"/>`
    : '';

  return `<svg class="knob-svg" viewBox="0 0 100 108" xmlns="http://www.w3.org/2000/svg">
    <path d="M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}"
      fill="none" stroke="#252525" stroke-width="8" stroke-linecap="round"/>
    ${valuePath}
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

// ── Wire Widget Events ────────────────────────────────────────────────────────
function wireWidgetEvents(el, type) {
  switch (type) {
    case 'pad': {
      const press = () => {
        if (isEditMode) return;
        el.classList.add('active');
        sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, el.dataset.valMax);
        sendOSC(el.dataset.oscAddress, el.dataset.valMax);
      };
      const release = () => {
        if (isEditMode) return;
        el.classList.remove('active');
        sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, el.dataset.valMin);
        sendOSC(el.dataset.oscAddress, el.dataset.valMin);
      };

      el.addEventListener('mousedown',  press);
      el.addEventListener('mouseup',    release);
      el.addEventListener('mouseleave', release);

      el.addEventListener('touchstart', (e) => { e.preventDefault(); press();   }, { passive: false });
      el.addEventListener('touchend',   (e) => { e.preventDefault(); release(); }, { passive: false });
      break;
    }

    case 'fader': {
      // pointerdown covers both mouse and touch, and fires before interact.js
      // can suppress mousedown via its own pointerdown handler
      el.addEventListener('pointerdown', (e) => {
        if (isEditMode) return;
        e.preventDefault();
        activeFaderDrag = { el };
      });
      break;
    }

    case 'knob': {
      el.addEventListener('pointerdown', (e) => {
        if (isEditMode) return;
        e.preventDefault();
        activeKnobDrag = { el, startY: e.clientY, startVal: parseFloat(el.dataset.value) };
      });
      break;
    }

    case 'xy': {
      el.addEventListener('pointerdown', (e) => {
        if (isEditMode) return;
        e.preventDefault();
        activeXYDrag = { el };
        updateXY(e.clientX, e.clientY, el);
      });
      break;
    }

    case 'toggle': {
      const toggle = () => {
        if (isEditMode) return;
        const isOn = el.classList.contains('toggle-on');
        const val  = isOn ? el.dataset.valMin : el.dataset.valMax;
        el.dataset.value = val;
        el.classList.toggle('toggle-on', !isOn);
        const s = el.querySelector('.toggle-state');
        if (s) s.textContent = isOn ? 'OFF' : 'ON';
        sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, val);
        sendOSC(el.dataset.oscAddress, val);
      };
      el.addEventListener('click',      toggle);
      el.addEventListener('touchstart', (e) => { e.preventDefault(); toggle(); }, { passive: false });
      break;
    }
  }
}

function updateXY(clientX, clientY, el) {
  const rect = el.getBoundingClientRect();
  const px   = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const py   = Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height));
  const min  = parseFloat(el.dataset.valMin);
  const max  = parseFloat(el.dataset.valMax);
  const xVal = Math.round(min + px * (max - min));
  const yVal = Math.round(max - py * (max - min)); // inverted Y

  const dot = el.querySelector('.xy-dot');
  if (dot) { dot.style.left = `${px * 100}%`; dot.style.top = `${py * 100}%`; }

  sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc,  xVal);
  sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.ccY, yVal);
  sendOSC(el.dataset.oscAddress,  xVal);
  sendOSC(el.dataset.oscAddressY, yVal);
}

// ── Global Pointer Handlers (mouse + touch unified) ───────────────────────────
function handlePointerMove(clientX, clientY) {
  if (activeFaderDrag) {
    const { el }  = activeFaderDrag;
    const track   = el.querySelector('.fader-track');
    if (track) {
    const rect    = track.getBoundingClientRect();
    const py      = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    const min     = parseFloat(el.dataset.valMin);
    const max     = parseFloat(el.dataset.valMax);
    const val     = Math.round(min + py * (max - min));
    el.dataset.value = val;
    const fill  = el.querySelector('.fader-fill');
    const thumb = el.querySelector('.fader-thumb');
    if (fill)  fill.style.height  = `${py * 100}%`;
    if (thumb) thumb.style.bottom = `${py * 100}%`;
    sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, val);
    sendOSC(el.dataset.oscAddress, val);
    } // end if (track)
  }

  if (activeKnobDrag) {
    const { el, startY, startVal } = activeKnobDrag;
    const delta  = startY - clientY;
    const min    = parseFloat(el.dataset.valMin);
    const max    = parseFloat(el.dataset.valMax);
    const newVal = Math.round(Math.max(min, Math.min(max, startVal + delta)));
    el.dataset.value = newVal;
    updateKnobSVG(el);
    sendMidi(el.dataset.msgType, el.dataset.channel, el.dataset.cc, newVal);
    sendOSC(el.dataset.oscAddress, newVal);
  }

  if (activeXYDrag) {
    updateXY(clientX, clientY, activeXYDrag.el);
  }
}

function handlePointerEnd() {
  activeFaderDrag = null;
  activeKnobDrag  = null;
  activeXYDrag    = null;
}

document.addEventListener('mousemove',   (e) => handlePointerMove(e.clientX, e.clientY));
document.addEventListener('mouseup',     handlePointerEnd);
// pointermove covers mouse + stylus + touch from pointerdown-initiated drags
document.addEventListener('pointermove', (e) => {
  if (activeFaderDrag || activeKnobDrag || activeXYDrag) {
    e.preventDefault();
    handlePointerMove(e.clientX, e.clientY);
  }
}, { passive: false });
document.addEventListener('pointerup',   handlePointerEnd);
// touchmove/touchend kept for any fallback paths
document.addEventListener('touchmove', (e) => {
  if (activeFaderDrag || activeKnobDrag || activeXYDrag) {
    e.preventDefault();
    const t = e.touches[0];
    handlePointerMove(t.clientX, t.clientY);
  }
}, { passive: false });
document.addEventListener('touchend', handlePointerEnd, { passive: true });

// ── Interact.js ───────────────────────────────────────────────────────────────
function initInteract(el) {
  if (!window.interact) return;

  interact(el)
    .draggable({
      enabled:   isEditMode && el.dataset.locked !== 'true',
      modifiers: [interact.modifiers.restrictRect({ restriction: 'parent' })],
      listeners: { move: dragMoveListener },
    })
    .resizable({
      enabled:   isEditMode && el.dataset.locked !== 'true',
      edges:     { left: true, right: true, bottom: true, top: true },
      modifiers: [
        interact.modifiers.restrictEdges({ outer: 'parent' }),
        interact.modifiers.restrictSize({ min: { width: 40, height: 40 } }),
      ],
      listeners: { move: resizeMoveListener },
    });
}

function dragMoveListener(event) {
  const target = event.target;
  if (target.dataset.locked === 'true') return;

  let x = (parseFloat(target.dataset.x) || 0) + event.dx;
  let y = (parseFloat(target.dataset.y) || 0) + event.dy;

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

// ── Selection ─────────────────────────────────────────────────────────────────
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

canvas.addEventListener('mousedown', (e) => {
  if (e.target === canvas || e.target.classList.contains('page-layer')) {
    if (isEditMode) deselectAll();
  }
});

// ── Inspector ─────────────────────────────────────────────────────────────────
function updateInspector() {
  const panels  = document.getElementById('inspector-panels');
  const noSel   = document.getElementById('no-selection-msg');
  const el      = selectedWidget;

  if (!el) {
    panels.style.display = 'none';
    noSel.style.display  = 'block';
    return;
  }

  panels.style.display = 'flex';
  noSel.style.display  = 'none';

  const d    = el.dataset;
  const type = d.type;

  document.getElementById('inspector-title').textContent =
    type.charAt(0).toUpperCase() + type.slice(1);
  document.getElementById('widget-type-badge').textContent = type.toUpperCase();

  // Show/hide XY-specific rows
  const isXY = type === 'xy';
  document.getElementById('xy-cc-row').style.display    = isXY ? '' : 'none';
  document.getElementById('xy-osc-y-row').style.display = isXY ? '' : 'none';

  // Style tab
  setValue('prop-text',          d.label       || '');
  setValue('prop-font-size',     d.fontSize);
  setValue('prop-label-color',   d.labelColor);
  setValue('prop-color',         d.color);
  setValue('prop-opacity',       d.opacity);
  document.getElementById('prop-opacity-val').textContent       = `${d.opacity}%`;
  setValue('prop-border-color',  d.borderColor);
  setValue('prop-border-width',  d.borderWidth);
  document.getElementById('prop-border-width-val').textContent  = `${d.borderWidth}px`;
  setValue('prop-border-radius', d.borderRadius);
  document.getElementById('prop-border-radius-val').textContent = `${d.borderRadius}px`;
  document.getElementById('prop-show-label').checked = d.showLabel !== 'false';

  // MIDI tab
  setValue('prop-channel',       d.channel);
  setValue('prop-cc',            d.cc);
  setValue('prop-cc-y',          d.ccY);
  setValue('prop-val-min',       d.valMin);
  setValue('prop-val-max',       d.valMax);
  setValue('prop-msg-type',      d.msgType);
  setValue('prop-osc-address',   d.oscAddress  || '');
  setValue('prop-osc-address-y', d.oscAddressY || '');

  // Layout tab
  syncLayoutInputs(el);
  document.getElementById('prop-lock').checked = d.locked === 'true';
  setValue('prop-z', d.z);
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val !== undefined) el.value = val;
}

function syncLayoutInputs(el) {
  setValue('prop-x', Math.round(parseFloat(el.dataset.x) || 0));
  setValue('prop-y', Math.round(parseFloat(el.dataset.y) || 0));
  setValue('prop-w', Math.round(parseFloat(el.style.width)  || 0));
  setValue('prop-h', Math.round(parseFloat(el.style.height) || 0));
}

// ── Bind Inspector Inputs ─────────────────────────────────────────────────────
function bind(id, event, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener(event, (e) => {
    if (!selectedWidget) return;
    fn(e, selectedWidget);
  });
}

function bindInspector() {
  bind('prop-text', 'input', (e, w) => {
    w.dataset.label = e.target.value;
    const lbl = w.querySelector('.widget-label');
    if (lbl) lbl.textContent = e.target.value;
  });

  bind('prop-font-size', 'input', (e, w) => {
    w.dataset.fontSize = e.target.value;
    w.style.fontSize   = `${e.target.value}px`;
  });

  bind('prop-label-color', 'input', (e, w) => {
    w.dataset.labelColor = e.target.value;
    w.style.color        = e.target.value;
  });

  bind('prop-color', 'input', (e, w) => {
    w.dataset.color        = e.target.value;
    w.style.backgroundColor = e.target.value;
  });

  bind('prop-opacity', 'input', (e, w) => {
    w.dataset.opacity = e.target.value;
    w.style.opacity   = e.target.value / 100;
    document.getElementById('prop-opacity-val').textContent = `${e.target.value}%`;
  });

  bind('prop-border-color', 'input', (e, w) => {
    w.dataset.borderColor = e.target.value;
    w.style.borderColor   = e.target.value;
  });

  bind('prop-border-width', 'input', (e, w) => {
    w.dataset.borderWidth = e.target.value;
    w.style.borderWidth   = `${e.target.value}px`;
    document.getElementById('prop-border-width-val').textContent = `${e.target.value}px`;
  });

  bind('prop-border-radius', 'input', (e, w) => {
    w.dataset.borderRadius = e.target.value;
    w.style.borderRadius   = `${e.target.value}px`;
    document.getElementById('prop-border-radius-val').textContent = `${e.target.value}px`;
  });

  bind('prop-show-label', 'change', (e, w) => {
    w.dataset.showLabel = e.target.checked ? 'true' : 'false';
    const lbl = w.querySelector('.widget-label');
    if (lbl) lbl.style.display = e.target.checked ? '' : 'none';
  });

  bind('prop-channel', 'change', (e, w) => { w.dataset.channel = e.target.value; });

  bind('prop-cc', 'input', (e, w) => {
    w.dataset.cc = e.target.value;
    const tag = w.querySelector('.widget-cc-tag');
    if (!tag) return;
    tag.textContent = w.dataset.type === 'xy'
      ? `X:${w.dataset.cc} Y:${w.dataset.ccY}`
      : `CC ${w.dataset.cc}`;
  });

  bind('prop-cc-y', 'input', (e, w) => {
    w.dataset.ccY = e.target.value;
    const tag = w.querySelector('.widget-cc-tag');
    if (tag && w.dataset.type === 'xy')
      tag.textContent = `X:${w.dataset.cc} Y:${w.dataset.ccY}`;
  });

  bind('prop-val-min', 'input', (e, w) => {
    w.dataset.valMin = e.target.value;
    if (w.dataset.type === 'knob') updateKnobSVG(w);
  });

  bind('prop-val-max', 'input', (e, w) => {
    w.dataset.valMax = e.target.value;
    if (w.dataset.type === 'knob') updateKnobSVG(w);
  });

  bind('prop-msg-type', 'change', (e, w) => { w.dataset.msgType = e.target.value; });

  bind('prop-osc-address', 'input', (e, w) => {
    w.dataset.oscAddress = e.target.value;
  });

  bind('prop-osc-address-y', 'input', (e, w) => {
    w.dataset.oscAddressY = e.target.value;
  });

  bind('prop-x', 'input', (e, w) => {
    const val = parseFloat(e.target.value) || 0;
    w.dataset.x = val;
    w.style.transform = `translate(${val}px, ${parseFloat(w.dataset.y) || 0}px)`;
  });

  bind('prop-y', 'input', (e, w) => {
    const val = parseFloat(e.target.value) || 0;
    w.dataset.y = val;
    w.style.transform = `translate(${parseFloat(w.dataset.x) || 0}px, ${val}px)`;
  });

  bind('prop-w', 'input', (e, w) => {
    w.style.width = `${Math.max(40, parseFloat(e.target.value) || 40)}px`;
  });

  bind('prop-h', 'input', (e, w) => {
    w.style.height = `${Math.max(40, parseFloat(e.target.value) || 40)}px`;
  });

  bind('prop-lock', 'change', (e, w) => {
    w.dataset.locked = e.target.checked ? 'true' : 'false';
    if (window.interact) {
      interact(w).draggable({ enabled: isEditMode && !e.target.checked });
      interact(w).resizable({ enabled: isEditMode && !e.target.checked });
    }
  });

  bind('prop-z', 'input', (e, w) => {
    const val = Math.max(0, Math.min(999, parseInt(e.target.value) || 0));
    w.dataset.z    = val;
    w.style.zIndex = val;
  });
}

// ── Edit Operations ───────────────────────────────────────────────────────────
function duplicateSelected() {
  if (!selectedWidget) return;
  const d     = selectedWidget.dataset;
  const newEl = spawnWidget(d.type, {
    x:            parseFloat(d.x) + 20,
    y:            parseFloat(d.y) + 20,
    w:            parseFloat(selectedWidget.style.width),
    h:            parseFloat(selectedWidget.style.height),
    cc:           d.cc,
    ccY:          d.ccY,
    channel:      d.channel,
    label:        (d.label || '') + ' copy',
    color:        d.color,
    labelColor:   d.labelColor,
    fontSize:     d.fontSize,
    borderColor:  d.borderColor,
    borderWidth:  d.borderWidth,
    borderRadius: d.borderRadius,
    opacity:      d.opacity,
    showLabel:    d.showLabel,
    msgType:      d.msgType,
    valMin:       d.valMin,
    valMax:       d.valMax,
    value:        d.value,
    z:            d.z,
    locked:       d.locked,
    oscAddress:   d.oscAddress,
    oscAddressY:  d.oscAddressY,
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
  const z = Math.max(0, Math.min(999, (parseInt(selectedWidget.dataset.z) || 1) + dir));
  selectedWidget.dataset.z = z;
  selectedWidget.style.zIndex = z;
  setValue('prop-z', z);
}

function alignWidget(dir) {
  if (!selectedWidget) return;
  const layer = getCurrentLayer();
  const cw    = layer.clientWidth;
  const ch    = layer.clientHeight;
  const w     = parseFloat(selectedWidget.style.width)  || 0;
  const h     = parseFloat(selectedWidget.style.height) || 0;
  let   x     = parseFloat(selectedWidget.dataset.x)    || 0;
  let   y     = parseFloat(selectedWidget.dataset.y)    || 0;

  switch (dir) {
    case 'left':     x = 0;           break;
    case 'center-h': x = (cw - w) / 2; break;
    case 'right':    x = cw - w;      break;
    case 'top':      y = 0;           break;
    case 'center-v': y = (ch - h) / 2; break;
    case 'bottom':   y = ch - h;      break;
  }

  selectedWidget.dataset.x = x;
  selectedWidget.dataset.y = y;
  selectedWidget.style.transform = `translate(${x}px, ${y}px)`;
  syncLayoutInputs(selectedWidget);
}

// ── Keyboard Shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (!isEditMode) return;
  // Don't fire shortcuts when typing in inspector inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
  if (e.key === 'd' && (e.metaKey || e.ctrlKey))   { duplicateSelected(); e.preventDefault(); }
  if (e.key === 'Escape') deselectAll();

  // Nudge selected widget
  if (selectedWidget && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    let x = parseFloat(selectedWidget.dataset.x) || 0;
    let y = parseFloat(selectedWidget.dataset.y) || 0;
    if (e.key === 'ArrowLeft')  x -= step;
    if (e.key === 'ArrowRight') x += step;
    if (e.key === 'ArrowUp')    y -= step;
    if (e.key === 'ArrowDown')  y += step;
    selectedWidget.dataset.x = x;
    selectedWidget.dataset.y = y;
    selectedWidget.style.transform = `translate(${x}px, ${y}px)`;
    syncLayoutInputs(selectedWidget);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
bindInspector();
updateInspector();
initFirstPage();
