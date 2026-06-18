// ==========================================
// DAW Controller — Frontend
// ==========================================

// ---- API: Electron IPC vs. WebSocket shim ----
const isElectron = typeof window.api !== 'undefined';

if (!isElectron) {
  // Running in a tablet browser — shim window.api over WebSocket
  const eventBus = {};
  let ws;

  function wsEmit(event, data) {
    (eventBus[event] || []).forEach(cb => cb(data));
  }

  function wsConnect() {
    ws = new WebSocket(`ws://${location.hostname}:8080`);

    ws.onopen  = () => updateStatus('connected', 'Connected');
    ws.onclose = () => {
      updateStatus('disconnected', 'Disconnected — retrying…');
      setTimeout(wsConnect, 3000);
    };
    ws.onerror = () => updateStatus('disconnected', 'Connection error');

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state:full')  wsEmit('state:sync',   { instruments: msg.payload.instruments, layout: msg.payload.layout });
        if (msg.type === 'map:added')   wsEmit('map:added',   msg.payload);
        if (msg.type === 'map:removed') wsEmit('map:removed', msg.payload);
        if (msg.type === 'map:updated') wsEmit('map:updated', msg.payload);
      } catch (err) { console.error('WS parse:', err); }
    };
  }

  wsConnect();

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  window.api = {
    openFileDialog:   ()      => Promise.resolve([]),
    openFolderDialog: ()      => Promise.resolve(null),
    loadFile:         ()      => Promise.resolve(null),
    removeMap:        (fp)    => { wsSend({ type: 'map:remove',   payload: fp });     return Promise.resolve(); },
    watchFolder:      ()      => Promise.resolve(),
    unwatchFolder:    ()      => Promise.resolve(),
    sendMidi:         (msg)   => { wsSend({ type: 'midi:send',    payload: msg });    return Promise.resolve(); },
    saveLayout:       (lay)   => { wsSend({ type: 'layout:save',  payload: lay });    return Promise.resolve(); },
    loadLayout:       ()      => Promise.resolve(null),
    onMapAdded:   (cb) => (eventBus['map:added']   = eventBus['map:added']   || []).push(cb),
    onMapRemoved: (cb) => (eventBus['map:removed'] = eventBus['map:removed'] || []).push(cb),
    onMapUpdated: (cb) => (eventBus['map:updated'] = eventBus['map:updated'] || []).push(cb),
    onError:      (cb) => (eventBus['error']       = eventBus['error']       || []).push(cb),
    onStateSync:  (cb) => (eventBus['state:sync']  = eventBus['state:sync']  || []).push(cb),
  };
}

// ---- State ----
const state = {
  instruments: new Map(),        // filePath -> { name, filePath, articulations }
  activeFilePath: null,
  activeArticulation: null,      // { filePath, artName }
  editMode: false,
  layout: {
    version: 1,
    watchedFolders: [],
    instruments: {},             // filePath -> { faders: [...] }
    macros: [],
    transport: {
      rewind: { type: 'cc', data1: 109, data2: 127, channel: 0 },
      play:   { type: 'cc', data1: 110, data2: 127, channel: 0 },
      stop:   { type: 'cc', data1: 111, data2: 127, channel: 0 },
      record: { type: 'cc', data1: 112, data2: 127, channel: 0 },
      loop:   { type: 'cc', data1: 113, data2: 127, channel: 0 },
    },
  },
};

// ---- DOM References ----
const $tabBar    = document.getElementById('tab-bar');
const $artGrid   = document.getElementById('articulation-grid');
const $faderBank = document.getElementById('fader-bank');
const $macroStrip = document.getElementById('macro-strip');
const $editToggle = document.getElementById('edit-toggle');
const $dropOverlay = document.getElementById('drop-overlay');
const $statusEl  = document.getElementById('status');

// ---- Utility ----
function updateStatus(cls, text) {
  if (!$statusEl) return;
  $statusEl.className = `status ${cls}`;
  $statusEl.textContent = text;
}

function getInstrumentLayout(filePath) {
  if (!state.layout.instruments[filePath]) {
    state.layout.instruments[filePath] = { faders: [] };
  }
  return state.layout.instruments[filePath];
}

let saveTimer = null;
function persistLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.saveLayout(state.layout), 400);
}

function outputHint(output) {
  if (!output) return '';
  if (output.type === 'note') return `Note ${output.data1} Ch${output.channel + 1}`;
  if (output.type === 'cc')   return `CC${output.data1} Ch${output.channel + 1}`;
  if (output.type === 'pc')   return `PC${output.data1} Ch${output.channel + 1}`;
  return output.type;
}

// ==========================================
// INIT
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  // Register IPC / WS listeners
  window.api.onMapAdded(instrument => {
    state.instruments.set(instrument.filePath, instrument);
    renderTabs();
    if (!state.activeFilePath) {
      state.activeFilePath = instrument.filePath;
      renderArticulationGrid();
      renderFaderBank();
    }
  });

  window.api.onMapRemoved(filePath => {
    state.instruments.delete(filePath);
    if (state.activeFilePath === filePath) {
      state.activeFilePath = state.instruments.size > 0
        ? state.instruments.keys().next().value
        : null;
      state.activeArticulation = null;
    }
    renderTabs();
    renderArticulationGrid();
    renderFaderBank();
  });

  window.api.onMapUpdated(instrument => {
    state.instruments.set(instrument.filePath, instrument);
    renderTabs();
    if (state.activeFilePath === instrument.filePath) renderArticulationGrid();
  });

  window.api.onError(({ title, message }) => {
    console.error(`[${title}] ${message}`);
  });

  window.api.onStateSync(({ instruments, layout }) => {
    if (layout) state.layout = { ...state.layout, ...layout };
    if (instruments?.length) {
      instruments.forEach(inst => state.instruments.set(inst.filePath, inst));
      if (!state.activeFilePath && state.instruments.size > 0) {
        state.activeFilePath = state.instruments.keys().next().value;
      }
    }
    renderAll();
  });

  // Load initial layout
  try {
    const saved = await window.api.loadLayout();
    if (saved) state.layout = { ...state.layout, ...saved };
  } catch (_) {}

  setupTransportButtons();
  setupEditMode();
  setupDragDrop();

  document.getElementById('import-hint-btn')?.addEventListener('click', importFiles);

  renderAll();

  if (isElectron) updateStatus('connected', 'Ready');
});

function renderAll() {
  renderTabs();
  renderArticulationGrid();
  renderFaderBank();
  renderMacros();
}

// ==========================================
// TRANSPORT
// ==========================================
function setupTransportButtons() {
  document.querySelectorAll('.transport-btn').forEach(btn => {
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (state.editMode) return;
      const msg = state.layout.transport?.[btn.dataset.action];
      if (!msg) return;
      window.api.sendMidi(msg);
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 180);
    });
  });
}

// ==========================================
// EDIT MODE
// ==========================================
function setupEditMode() {
  $editToggle.addEventListener('click', () => {
    state.editMode = !state.editMode;
    document.body.classList.toggle('edit-mode', state.editMode);
    $editToggle.textContent = state.editMode ? 'Done' : 'Edit';
    renderFaderBank();
    renderMacros();
  });
}

// ==========================================
// TABS
// ==========================================
function renderTabs() {
  $tabBar.innerHTML = '';

  state.instruments.forEach((instrument, filePath) => {
    const tab = document.createElement('button');
    tab.className = 'tab-btn' + (filePath === state.activeFilePath ? ' active-tab' : '');

    const name = document.createElement('span');
    name.textContent = instrument.name;
    tab.appendChild(name);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Remove instrument';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); removeInstrument(filePath); });
    tab.appendChild(closeBtn);

    tab.addEventListener('click', () => selectInstrument(filePath));
    $tabBar.appendChild(tab);
  });

  // Import button
  const importBtn = document.createElement('button');
  importBtn.className = 'tab-action-btn';
  importBtn.textContent = '+ Import';
  importBtn.addEventListener('click', importFiles);
  $tabBar.appendChild(importBtn);

  // Watch folder (Electron only)
  if (isElectron) {
    const watchBtn = document.createElement('button');
    watchBtn.className = 'tab-action-btn';
    watchBtn.textContent = '⟲ Watch Folder';
    watchBtn.addEventListener('click', watchFolder);
    $tabBar.appendChild(watchBtn);
  }
}

function selectInstrument(filePath) {
  state.activeFilePath = filePath;
  state.activeArticulation = null;
  renderTabs();
  renderArticulationGrid();
  renderFaderBank();
}

async function removeInstrument(filePath) {
  await window.api.removeMap(filePath);
  state.instruments.delete(filePath);
  if (state.activeFilePath === filePath) {
    state.activeFilePath = state.instruments.size > 0
      ? state.instruments.keys().next().value
      : null;
    state.activeArticulation = null;
  }
  renderTabs();
  renderArticulationGrid();
  renderFaderBank();
}

async function importFiles() {
  const instruments = await window.api.openFileDialog();
  if (!instruments.length) return;
  instruments.forEach(inst => state.instruments.set(inst.filePath, inst));
  state.activeFilePath = instruments[instruments.length - 1].filePath;
  state.activeArticulation = null;
  renderTabs();
  renderArticulationGrid();
  renderFaderBank();
}

async function watchFolder() {
  const folderPath = await window.api.openFolderDialog();
  if (!folderPath) return;
  await window.api.watchFolder(folderPath);
  if (!state.layout.watchedFolders.includes(folderPath)) {
    state.layout.watchedFolders.push(folderPath);
    persistLayout();
  }
}

// ==========================================
// ARTICULATION GRID
// ==========================================
function renderArticulationGrid() {
  $artGrid.innerHTML = '';

  if (!state.activeFilePath) {
    $artGrid.innerHTML = `
      <div id="art-empty-state">
        <p>Import a Cubase expression map to get started</p>
        <button id="import-hint-btn">+ Import Expression Map</button>
      </div>`;
    document.getElementById('import-hint-btn')?.addEventListener('click', importFiles);
    return;
  }

  const instrument = state.instruments.get(state.activeFilePath);
  if (!instrument || !instrument.articulations.length) {
    $artGrid.innerHTML = `<div id="art-empty-state"><p>No articulations found in this expression map</p></div>`;
    return;
  }

  instrument.articulations.forEach(art => {
    const btn = document.createElement('button');
    btn.className = 'art-btn';

    const isActive = state.activeArticulation?.filePath === state.activeFilePath &&
                     state.activeArticulation?.artName  === art.name;
    if (isActive) btn.classList.add('active');

    const nameSpan = document.createElement('span');
    nameSpan.textContent = art.name;
    btn.appendChild(nameSpan);

    if (art.outputs.length > 0) {
      const hint = document.createElement('span');
      hint.className = 'art-output-hint';
      hint.textContent = outputHint(art.outputs[0]);
      btn.appendChild(hint);
    }

    btn.addEventListener('click', () => {
      if (state.editMode) return;
      latchArticulation(instrument, art, btn);
    });

    $artGrid.appendChild(btn);
  });
}

function latchArticulation(instrument, art, btn) {
  // Remove active from all buttons, set on clicked
  $artGrid.querySelectorAll('.art-btn.active').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.activeArticulation = { filePath: instrument.filePath, artName: art.name };

  // Send all outputs for this articulation
  art.outputs.forEach(out => {
    window.api.sendMidi({ type: out.type, channel: out.channel, data1: out.data1, data2: out.data2 });
  });
}

// ==========================================
// FADER BANK
// ==========================================
function renderFaderBank() {
  $faderBank.innerHTML = '';

  if (!state.activeFilePath) return;

  const instLayout = getInstrumentLayout(state.activeFilePath);
  const faders = instLayout.faders;

  faders.forEach((fader, index) => {
    const item = document.createElement('div');
    item.className = 'fader-item';

    const label = document.createElement('span');
    label.className = 'fader-label';
    label.textContent = fader.label;

    const valueDisplay = document.createElement('span');
    valueDisplay.className = 'fader-value-display';
    valueDisplay.textContent = fader.value ?? 100;

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'fader-input';
    input.min = 0;
    input.max = 127;
    input.value = fader.value ?? 100;
    input.setAttribute('orient', 'vertical');

    input.addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      valueDisplay.textContent = val;
      fader.value = val;
      window.api.sendMidi({ type: 'cc', channel: fader.channel ?? 0, data1: fader.cc, data2: val });
      persistLayout();
    });

    const ccLabel = document.createElement('span');
    ccLabel.className = 'fader-cc-label';
    ccLabel.textContent = `CC ${fader.cc}`;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'fader-remove-btn';
    removeBtn.title = 'Remove fader';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      instLayout.faders.splice(index, 1);
      persistLayout();
      renderFaderBank();
    });

    item.append(label, valueDisplay, input, ccLabel, removeBtn);
    $faderBank.appendChild(item);

    if (index < faders.length - 1) {
      const div = document.createElement('div');
      div.className = 'fader-divider';
      $faderBank.appendChild(div);
    }
  });

  // Add Fader button
  const addBtn = document.createElement('button');
  addBtn.id = 'add-fader-btn';
  addBtn.textContent = '+ Add Fader';
  addBtn.addEventListener('click', () => {
    addFaderForm.classList.toggle('visible');
  });
  $faderBank.appendChild(addBtn);

  // Add Fader inline form
  const addFaderForm = document.createElement('div');
  addFaderForm.id = 'add-fader-form';
  addFaderForm.innerHTML = `
    <input type="text"   id="f-label" placeholder="Label (e.g. Volume)" maxlength="20">
    <input type="number" id="f-cc"    placeholder="CC 0–127" min="0" max="127">
    <input type="number" id="f-ch"    placeholder="Channel 0–15" min="0" max="15" value="0">
    <div class="form-row">
      <button class="btn-confirm" id="f-add">Add</button>
      <button class="btn-cancel"  id="f-cancel">Cancel</button>
    </div>`;
  $faderBank.appendChild(addFaderForm);

  addFaderForm.querySelector('#f-add').addEventListener('click', () => {
    const label = addFaderForm.querySelector('#f-label').value.trim() || 'Fader';
    const cc    = parseInt(addFaderForm.querySelector('#f-cc').value, 10);
    const ch    = parseInt(addFaderForm.querySelector('#f-ch').value, 10) || 0;
    if (isNaN(cc) || cc < 0 || cc > 127) return;
    instLayout.faders.push({ label, cc, channel: ch, value: 100 });
    persistLayout();
    renderFaderBank();
  });

  addFaderForm.querySelector('#f-cancel').addEventListener('click', () => {
    addFaderForm.classList.remove('visible');
  });
}

// ==========================================
// MACROS
// ==========================================
function renderMacros() {
  $macroStrip.innerHTML = '';

  (state.layout.macros || []).forEach((macro, index) => {
    const btn = document.createElement('button');
    btn.className = 'macro-btn';
    btn.textContent = macro.label;
    btn.addEventListener('click', () => {
      if (state.editMode) return;
      macro.messages.forEach(msg => window.api.sendMidi(msg));
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 150);
    });
    $macroStrip.appendChild(btn);
  });

  if (state.editMode) {
    const addBtn = document.createElement('button');
    addBtn.className = 'macro-btn add-macro-btn';
    addBtn.textContent = '+ Macro';
    addBtn.addEventListener('click', addMacro);
    $macroStrip.appendChild(addBtn);
  }
}

function addMacro() {
  const label = prompt('Macro name:');
  if (!label?.trim()) return;
  state.layout.macros = state.layout.macros || [];
  state.layout.macros.push({ label: label.trim(), messages: [] });
  persistLayout();
  renderMacros();
}

// ==========================================
// DRAG & DROP IMPORT
// ==========================================
function setupDragDrop() {
  let dragCounter = 0;

  document.addEventListener('dragenter', e => {
    e.preventDefault();
    dragCounter++;
    $dropOverlay.classList.remove('hidden');
  });

  document.addEventListener('dragleave', e => {
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) $dropOverlay.classList.add('hidden');
  });

  document.addEventListener('dragover', e => e.preventDefault());

  document.addEventListener('drop', async e => {
    e.preventDefault();
    dragCounter = 0;
    $dropOverlay.classList.add('hidden');

    const files = Array.from(e.dataTransfer.files || []);
    let lastLoaded = null;

    for (const file of files) {
      if (!file.name.endsWith('.expressionmap')) continue;
      const filePath = file.path; // Electron patches File API with .path
      if (!filePath) continue;
      try {
        const inst = await window.api.loadFile(filePath);
        if (inst) {
          state.instruments.set(inst.filePath, inst);
          lastLoaded = inst.filePath;
        }
      } catch (err) {
        console.error('Drop load error:', err);
      }
    }

    if (lastLoaded) {
      state.activeFilePath = lastLoaded;
      state.activeArticulation = null;
      renderTabs();
      renderArticulationGrid();
      renderFaderBank();
    }
  });
}
