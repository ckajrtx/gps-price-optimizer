// ═══════════════════════════════════════════════════════════════
// app.js  —  QuoteIQ Main Application Logic
// ═══════════════════════════════════════════════════════════════
import { requireAuth, signOutUser as authSignOut } from '/js/auth.js';
import {
  getSettings, saveSettings,
  getCompAreas,  saveCompAreas,
  getMinPrices,  saveMinPrices,
  getPrefPrices, savePrefPrices,
  getServiceCodes, saveServiceCodes,
  clearServiceCodes as dbClearSvcCodes,
  getSessions, createSession, updateSessionData,
  renameSession, deleteSession, loadSessionFeatures,
  debounce
} from '/js/db.js';

// ── STATE ────────────────────────────────────────────────────────
const state = {
  companyId:    null,
  userId:       null,
  features:     [],       // GeoJSON features with computed props
  cachedCoords: [],       // [{ lat, lon, rowIndex }] — skip re-geocode
  cachedRawRows:[],       // original parsed rows from last upload
  pendingFile:  null,     // File object waiting to be processed
  compAreas:    [],
  minPrices:    [],
  prefPrices:   [],
  svcCodes:     [],
  sessions:     [],       // list of saved session metadata from Firestore
  activeSessionId:       null,  // Firestore doc id of currently loaded session
  activeSessionName:     null,  // display name shown in top bar
  activeSessionStorageRef: null,// Storage path for re-saving in place
  activeFileName:        '',    // original Excel filename of current data
  settings: {
    epsilon: 3, minPoints: 5,
    quantityDiscount: 0.30, extraChargePerMile: 15,
    priceIncreaseRate: 0.10, prefBuffer: 0.40, orsKey: ''
  },
  sortCol: null,
  sortDir: 'none',
  map: null,
  clusterLayer: null,
};

// ── BOOT ─────────────────────────────────────────────────────────
requireAuth(async (firebaseUser, userDoc) => {
  state.userId    = firebaseUser.uid;
  state.companyId = userDoc.companyId;

  // Populate top-bar user info
  const initials = (userDoc.displayName || userDoc.email || '?')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent   = userDoc.displayName || userDoc.email;
  document.getElementById('user-role').textContent   = userDoc.role === 'superuser' ? 'Super Admin' : 'User';
  if (userDoc.role === 'superuser') document.getElementById('btn-admin').style.display = '';

  // Load all company data in parallel
  const [settings, compAreas, minPrices, prefPrices, svcCodes, sessions] = await Promise.all([
    getSettings(state.companyId),
    getCompAreas(state.companyId),
    getMinPrices(state.companyId),
    getPrefPrices(state.companyId),
    getServiceCodes(state.companyId),
    getSessions(state.companyId).catch(() => []),
  ]);

  state.settings  = { ...state.settings, ...settings };
  state.compAreas = compAreas  || [];
  state.minPrices = minPrices  || [];
  state.prefPrices= prefPrices || [];
  state.svcCodes  = svcCodes   || [];
  state.sessions  = sessions   || [];

  applySettingsToUI();

  // Load company name
  try {
    const { getCompany } = await import('/js/db.js');
    const company = await getCompany(state.companyId);
    if (company) {
      const chip = document.getElementById('company-chip');
      chip.textContent  = company.name;
      chip.style.display = 'inline-block';
    }
  } catch (_) {}

  renderCompAreas();
  renderMinPrices();
  renderPrefPrices();
  renderServiceCodes();
  updateSessionChip();

  // Auto-restore most recent session if available
  if (state.sessions.length > 0) {
    const latest = state.sessions[0];
    try {
      const features = await loadSessionFeatures(latest.storageRef);
      state.features               = features;
      state.activeSessionId        = latest.id;
      state.activeSessionName      = latest.name;
      state.activeSessionStorageRef= latest.storageRef;
      state.activeFileName         = latest.fileName || '';
      state.cachedCoords  = features.map((f, i) => ({
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], rowIndex: i,
      }));
      state.cachedRawRows = features.map(f => ({ ...f.properties }));
      setExportEnabled(true);
      document.getElementById('refresh-nn-btn').disabled = false;
      updateSessionChip();
      renderProcessedData();
      renderDashboard();
    } catch (e) {
      console.warn('Could not auto-restore session (Storage may not be enabled):', e);
    }
  }

  initMap();
});

// ── TAB SWITCHING ─────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === `tab-${tabId}`));
  if (tabId === 'map' && state.map) {
    setTimeout(() => state.map.invalidateSize(), 50);
  }
}

// ── DRAG & DROP ───────────────────────────────────────────────────
window.dzOver = function(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.add('drag-over');
};
window.dzLeave = function() {
  document.getElementById('drop-zone').classList.remove('drag-over');
};
window.dzDrop = function(e) {
  e.preventDefault();
  const dz = document.getElementById('drop-zone');
  dz.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) dzSelect(file);
};
window.dzSelect = function(file) {
  if (!file) return;
  state.pendingFile = file;
  state.cachedCoords  = [];   // new file → reset cache
  state.cachedRawRows = [];
  const dz  = document.getElementById('drop-zone');
  const fnEl = document.getElementById('dz-filename');
  dz.classList.add('has-file');
  fnEl.style.display = 'block';
  fnEl.textContent   = '✓ ' + file.name;
  dz.querySelector('.dz-icon').textContent = '✅';
};

// ── SETTINGS ─────────────────────────────────────────────────────
function applySettingsToUI() {
  const s = state.settings;
  document.getElementById('s-qty-disc').value  = pct(s.quantityDiscount);
  document.getElementById('s-extra-mile').value= s.extraChargePerMile;
  document.getElementById('s-pi-rate').value   = pct(s.priceIncreaseRate);
  document.getElementById('s-pref-buf').value  = pct(s.prefBuffer);
  document.getElementById('s-ors-key').value   = s.orsKey || '';
  document.getElementById('clusterRadius').value = s.epsilon;
  document.getElementById('minPoints').value     = s.minPoints;
}

function pct(v) { return Math.round(v * 100) + '%'; }

function parsePct(v) {
  const s = String(v).trim().replace('%', '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n / 100;
}

window.onSettingsChange = function() {
  state.settings.quantityDiscount  = parsePct(document.getElementById('s-qty-disc').value);
  state.settings.extraChargePerMile= parseFloat(document.getElementById('s-extra-mile').value) || 15;
  state.settings.priceIncreaseRate = parsePct(document.getElementById('s-pi-rate').value);
  state.settings.prefBuffer        = parsePct(document.getElementById('s-pref-buf').value);
  state.settings.orsKey            = document.getElementById('s-ors-key').value.trim();
  state.settings.epsilon           = parseFloat(document.getElementById('clusterRadius').value) || 3;
  state.settings.minPoints         = parseInt(document.getElementById('minPoints').value) || 5;
  if (state.features.length) {
    recalcPricing();
    renderProcessedData();
    renderDashboard();
  }
};

window.persistSettings = async function() {
  onSettingsChange();
  const btn = document.getElementById('save-settings-btn');
  btn.textContent = 'Saving…'; btn.disabled = true;
  await saveSettings(state.companyId, state.settings);
  btn.textContent = 'Saved ✓'; btn.disabled = false;
  setTimeout(() => { btn.textContent = 'Save Settings'; }, 1800);
};

// ── MAP INIT ──────────────────────────────────────────────────────
function initMap() {
  if (state.map) return;
  state.map = L.map('map').setView([39.5, -98.35], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18
  }).addTo(state.map);
}

const CLUSTER_COLORS = [
  '#2563EB','#16A34A','#D97706','#DC2626','#7C3AED',
  '#0891B2','#DB2777','#65A30D','#EA580C','#6366F1',
];
function clusterColor(n) {
  if (n == null || n < 0) return '#94A3B8';
  return CLUSTER_COLORS[n % CLUSTER_COLORS.length];
}

function plotClusters() {
  if (state.clusterLayer) {
    state.map.removeLayer(state.clusterLayer);
    state.clusterLayer = null;
  }
  if (!state.features.length) return;
  const markers = [];
  state.features.forEach(f => {
    const p   = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const cn  = p.cluster ?? -1;
    const col = clusterColor(cn);
    const m   = L.circleMarker([lat, lon], {
      radius: 6, fillColor: col, color: '#fff',
      weight: 1.5, fillOpacity: 0.85
    }).bindPopup((() => {
      const addrParts = [
        p['Service Add Num'], p['Service Address'],
        p['Service City'],    p['Service State']
      ].filter(Boolean);
      const addr = addrParts.length ? addrParts.join(' ') : '—';
      return `<div style="min-width:190px;font-family:inherit;font-size:12px;line-height:1.7">
        <div style="font-weight:700;font-size:13px;margin-bottom:3px;color:#1E293B">${esc(String(p['Account#'] || 'Account'))}</div>
        <div style="color:#475569;margin-bottom:6px">${esc(addr)}</div>
        <hr style="border:none;border-top:1px solid #E2E8F0;margin:0 0 6px">
        <div><span style="color:#64748B">Cluster:</span> <b>${cn >= 0 ? cn : 'noise'}</b></div>
        <div><span style="color:#64748B">Nearest dist:</span> <b>${(p.distance_to_nearest || 0).toFixed(2)} mi</b></div>
      </div>`;
    })());
    markers.push(m);
  });
  state.clusterLayer = L.layerGroup(markers).addTo(state.map);
  const lats = state.features.map(f => f.geometry.coordinates[1]);
  const lons = state.features.map(f => f.geometry.coordinates[0]);
  state.map.fitBounds([[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]], { padding: [30, 30] });
}

// ── FILE PROCESSING ───────────────────────────────────────────────
window.processFile = async function() {
  const epsilon   = parseFloat(document.getElementById('clusterRadius').value) || 3;
  const minPoints = parseInt(document.getElementById('minPoints').value) || 5;
  state.settings.epsilon   = epsilon;
  state.settings.minPoints = minPoints;

  // ── Re-cluster from cache (no new file, no API re-call) ──────
  if (!state.pendingFile && state.cachedCoords.length > 0) {
    setProgress(true, 'Re-clustering…', 40);
    const geojson = buildGeojsonFromCache(state.cachedCoords, state.cachedRawRows);
    const clustered = turf.clustersDbscan(geojson, epsilon, { minPoints, units: 'miles' });
    state.features = clustered.features.map((f, i) => {
      const prev = state.features[i] || {};
      return {
        ...f,
        properties: {
          ...f.properties,
          nearest_point:       prev.properties?.nearest_point       || null,
          distance_to_nearest: prev.properties?.distance_to_nearest ?? 0,
        }
      };
    });
    recalcPricing();
    setProgress(false);
    plotClusters();
    renderProcessedData();
    renderDashboard();
    setExportEnabled(true);
    return;
  }

  // ── New file ─────────────────────────────────────────────────
  const file = state.pendingFile;
  if (!file) { alert('Please select an Excel file first.'); return; }

  // New file = new session context; user will save explicitly
  state.activeSessionId         = null;
  state.activeSessionName       = null;
  state.activeSessionStorageRef = null;
  state.activeFileName          = file.name;

  setProgress(true, 'Reading file…', 5);

  let jsonData;
  try {
    jsonData = await readExcel(file);
  } catch (e) {
    setProgress(false);
    alert('Could not read file: ' + e.message);
    return;
  }
  if (!jsonData.length) { setProgress(false); alert('No data rows found.'); return; }

  // Auto-populate service codes if table is empty
  if (state.svcCodes.length === 0) {
    await autoPopulateSvcCodes(jsonData);
  }

  setProgress(true, 'Parsing locations…', 15);
  const mode = document.querySelector('input[name="geocodeOption"]:checked').value;
  let coords = [];

  if (mode === 'latlong') {
    coords = jsonData.map((row, i) => {
      const lat = parseFloat(row['Latitude']  || row['latitude']  || row['lat'] || 0);
      const lon = parseFloat(row['Longitude'] || row['longitude'] || row['lon'] || row['lng'] || 0);
      return { lat, lon, rowIndex: i };
    }).filter(c => c.lat && c.lon);
  } else {
    coords = await geocodeBatch(jsonData, (pct) => setProgress(true, `Geocoding ${pct}%…`, pct));
  }

  if (!coords.length) { setProgress(false); alert('No valid coordinates found.'); return; }

  state.cachedCoords  = coords;
  state.cachedRawRows = jsonData;

  setProgress(true, 'Clustering…', 60);
  const geojson    = buildGeojsonFromCache(coords, jsonData);
  const clustered  = turf.clustersDbscan(geojson, epsilon, { minPoints, units: 'miles' });

  setProgress(true, 'Computing nearest neighbors…', 75);
  const orsKey = document.getElementById('s-ors-key').value.trim();
  let features = clustered.features;
  if (orsKey) {
    features = await computeNNORS(features, orsKey, (p) => setProgress(true, `Drive times ${p}%…`, 75 + p * 0.2));
  } else {
    features = await computeNNOSRM(features, (p) => setProgress(true, `Drive times (OSRM) ${p}%…`, 75 + p * 0.2));
  }

  state.features = features;
  recalcPricing();

  state.pendingFile = null;
  setProgress(false);
  setExportEnabled(true);
  document.getElementById('refresh-nn-btn').disabled = false;
  updateSessionChip(); // show Save button; clear any old session name
  plotClusters();
  renderProcessedData();
  renderDashboard();
};

// ── REFRESH DRIVE TIMES (ORS re-call only) ──────────────────────
window.refreshNN = async function() {
  if (!state.features.length) return;
  const orsKey = document.getElementById('s-ors-key').value.trim();
  setProgress(true, 'Refreshing drive times…', 10);
  if (orsKey) {
    state.features = await computeNNORS(state.features, orsKey, (p) => setProgress(true, `Drive times ${p}%…`, p));
  } else {
    state.features = await computeNNOSRM(state.features, (p) => setProgress(true, `Drive times (OSRM) ${p}%…`, p));
  }
  recalcPricing();
  setProgress(false);
  renderProcessedData();
  renderDashboard();
};

// ── HELPERS ───────────────────────────────────────────────────────
function buildGeojsonFromCache(coords, rows) {
  return {
    type: 'FeatureCollection',
    features: coords.map(c => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      properties: { ...rows[c.rowIndex] },
    }))
  };
}

async function readExcel(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
        res(data);
      } catch (err) { rej(err); }
    };
    reader.onerror = rej;
    reader.readAsArrayBuffer(file);
  });
}

function setProgress(show, msg = '', val = 0) {
  const wrap = document.getElementById('progress-wrap');
  const bar  = document.getElementById('progress-bar');
  const stat = document.getElementById('progress-status');
  wrap.style.display  = show ? 'block' : 'none';
  bar.value           = val;
  stat.textContent    = msg;
}

function setExportEnabled(on) {
  document.getElementById('exportBtn').disabled  = !on;
  document.getElementById('exportBtn2').disabled = !on;
}

// ── GEOCODING (address mode) ───────────────────────────────────────
async function geocodeBatch(rows, onPct) {
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const addr = [
      row['Service Add Num'] || '',
      row['Service Address'] || '',
      row['Service City']    || '',
      row['Service State']   || ''
    ].join(' ').trim();
    try {
      const c = await geocodeAddress(addr);
      if (c) results.push({ ...c, rowIndex: i });
    } catch (_) {}
    if (onPct) onPct(Math.round((i / rows.length) * 100));
    await sleep(120); // Nominatim rate limit
  }
  return results;
}

async function geocodeAddress(addr) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1`;
  const r   = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const d   = await r.json();
  return d[0] ? { lat: parseFloat(d[0].lat), lon: parseFloat(d[0].lon) } : null;
}

// ── NEAREST NEIGHBOR — STRAIGHT LINE (Turf) ───────────────────────
function computeNNTurf(features) {
  return features.map((f, i) => {
    const myAcct = f.properties['Account#'];
    let   minDist = Infinity, nearPt = null;
    features.forEach((other, j) => {
      if (j === i) return;
      if (other.properties['Account#'] === myAcct) return; // skip same account
      const d = turf.distance(f, other, { units: 'miles' });
      if (d < minDist) { minDist = d; nearPt = other.properties['Account#'] || `row ${j}`; }
    });
    return {
      ...f,
      properties: {
        ...f.properties,
        nearest_point:       nearPt,
        distance_to_nearest: minDist === Infinity ? 0 : +minDist.toFixed(4),
      }
    };
  });
}

// ── NEAREST NEIGHBOR — DRIVE TIME (ORS) ───────────────────────────
async function computeNNORS(features, orsKey, onPct) {
  const CHUNK = 50; // ORS free: max 50×50 = 2500 elements
  const total = features.length;
  const out   = features.map(f => ({ ...f, properties: { ...f.properties } }));

  for (let src = 0; src < total; src += CHUNK) {
    const srcFeat = features.slice(src, src + CHUNK);
    const srcIdx  = srcFeat.map((_, k) => k);

    // Build full coordinate list for destinations (all features)
    const locations = features.map(f => [f.geometry.coordinates[0], f.geometry.coordinates[1]]);
    const srcLocIdx = srcFeat.map((_, k) => src + k);

    // We only send src indices as sources, all as destinations
    const body = {
      locations,
      sources:      srcLocIdx,
      destinations: Array.from({ length: total }, (_, i) => i),
      metrics:      ['distance'],
      units:        'mi',
    };

    try {
      const resp = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': orsKey },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`ORS error ${resp.status}`);
      const data = await resp.json();
      const matrix = data.distances; // [srcCount][total]

      matrix.forEach((row, si) => {
        const fi = src + si;
        const myAcct = features[fi].properties['Account#'];
        let minDist = Infinity, nearPt = null;
        row.forEach((d, di) => {
          if (di === fi) return;
          if (features[di].properties['Account#'] === myAcct) return;
          if (d !== null && d < minDist) {
            minDist = d;
            nearPt  = features[di].properties['Account#'] || `row ${di}`;
          }
        });
        out[fi].properties.nearest_point       = nearPt;
        out[fi].properties.distance_to_nearest = minDist === Infinity ? 0 : +minDist.toFixed(4);
      });
    } catch (e) {
      console.warn('ORS chunk failed, falling back to turf for this chunk:', e);
      srcFeat.forEach((f, si) => {
        const fi = src + si;
        const myAcct = features[fi].properties['Account#'];
        let minDist = Infinity, nearPt = null;
        features.forEach((other, di) => {
          if (di === fi) return;
          if (other.properties['Account#'] === myAcct) return;
          const d = turf.distance(features[fi], other, { units: 'miles' });
          if (d < minDist) { minDist = d; nearPt = other.properties['Account#'] || `row ${di}`; }
        });
        out[fi].properties.nearest_point       = nearPt;
        out[fi].properties.distance_to_nearest = minDist === Infinity ? 0 : +minDist.toFixed(4);
      });
    }

    if (onPct) onPct(Math.round(((src + CHUNK) / total) * 100));
    if (src + CHUNK < total) await sleep(1600); // ORS rate limit
  }
  return out;
}

// ── NEAREST NEIGHBOR — OSRM (free road routing, no API key) ──────
async function computeNNOSRM(features, onPct) {
  const total = features.length;
  const out   = features.map(f => ({ ...f, properties: { ...f.properties } }));
  const K     = Math.min(20, total - 1);

  // Pre-select top-K candidates per feature by squared-degree distance (fast, no trig)
  const candidates = features.map((f, i) => {
    const [fx, fy] = f.geometry.coordinates;
    return features
      .map((other, j) => {
        if (j === i) return { j, d: Infinity };
        const dx = fx - other.geometry.coordinates[0];
        const dy = fy - other.geometry.coordinates[1];
        return { j, d: dx * dx + dy * dy };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, K)
      .map(x => x.j);
  });

  const BATCH = 5;
  let processed = 0;

  for (let bStart = 0; bStart < total; bStart += BATCH) {
    const bSrcIdx = [];
    for (let k = 0; k < BATCH && bStart + k < total; k++) bSrcIdx.push(bStart + k);

    // Unique coord indices: sources + all their candidates
    const coordIdxSet = new Set(bSrcIdx);
    bSrcIdx.forEach(si => candidates[si].forEach(di => coordIdxSet.add(di)));
    const coordIdxArr = [...coordIdxSet];

    const coordStr    = coordIdxArr.map(i => `${features[i].geometry.coordinates[0]},${features[i].geometry.coordinates[1]}`).join(';');
    const srcPositions = bSrcIdx.map(si => coordIdxArr.indexOf(si)).join(';');

    try {
      const resp = await fetch(
        `https://router.project-osrm.org/table/v1/driving/${coordStr}?sources=${srcPositions}&annotations=distance`
      );
      if (!resp.ok) throw new Error(`OSRM HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.code !== 'Ok') throw new Error('OSRM: ' + data.code);

      data.distances.forEach((row, rowIdx) => {
        const fi     = bSrcIdx[rowIdx];
        const myAcct = features[fi].properties['Account#'];
        let minDist = Infinity, nearPt = null;
        row.forEach((meters, colIdx) => {
          const di = coordIdxArr[colIdx];
          if (di === fi) return;
          if (features[di].properties['Account#'] === myAcct) return;
          if (meters == null) return;
          const miles = meters * 0.000621371;
          if (miles < minDist) { minDist = miles; nearPt = features[di].properties['Account#'] || `row ${di}`; }
        });
        out[fi].properties.nearest_point       = nearPt;
        out[fi].properties.distance_to_nearest = minDist === Infinity ? 0 : +minDist.toFixed(4);
      });
    } catch (e) {
      console.warn('OSRM batch failed, falling back to straight-line:', e);
      bSrcIdx.forEach(fi => {
        const myAcct = features[fi].properties['Account#'];
        let minDist = Infinity, nearPt = null;
        features.forEach((other, di) => {
          if (di === fi || other.properties['Account#'] === myAcct) return;
          const d = turf.distance(features[fi], other, { units: 'miles' });
          if (d < minDist) { minDist = d; nearPt = other.properties['Account#'] || `row ${di}`; }
        });
        out[fi].properties.nearest_point       = nearPt;
        out[fi].properties.distance_to_nearest = minDist === Infinity ? 0 : +minDist.toFixed(4);
      });
    }

    processed += bSrcIdx.length;
    if (onPct) onPct(Math.round((processed / total) * 100));
    if (bStart + BATCH < total) await sleep(500); // OSRM demo courtesy rate limit
  }
  return out;
}

// ── SESSION MANAGEMENT ───────────────────────────────────────────
function updateSessionChip() {
  const chip    = document.getElementById('session-chip');
  const saveBtn = document.getElementById('btn-save-session');
  if (!chip || !saveBtn) return;
  if (state.activeSessionName) {
    chip.textContent  = state.activeSessionName;
    chip.style.display = 'inline-block';
  } else {
    chip.style.display = 'none';
  }
  saveBtn.style.display = state.features.length > 0 ? '' : 'none';
}

window.openSaveSessionModal = function() {
  if (!state.features.length) return;
  const input = document.getElementById('session-name-input');
  // Pre-fill: current session name, or filename without extension
  input.value = state.activeSessionName ||
    state.activeFileName.replace(/\.[^.]+$/, '') || '';
  document.getElementById('save-session-overlay').classList.add('open');
  setTimeout(() => { input.focus(); input.select(); }, 60);
};
window.closeSaveSessionModal = function() {
  document.getElementById('save-session-overlay').classList.remove('open');
};

window.doSaveSession = async function() {
  const name = document.getElementById('session-name-input').value.trim();
  if (!name) { document.getElementById('session-name-input').focus(); return; }
  const saveBtn = document.querySelector('#save-session-modal .btn-primary');
  saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
  try {
    if (state.activeSessionId && state.activeSessionStorageRef) {
      await updateSessionData(state.companyId, state.activeSessionId, {
        name, rowCount: state.features.length,
        features: state.features, storageRef: state.activeSessionStorageRef,
      });
      state.activeSessionName = name;
    } else {
      const result = await createSession(state.companyId, state.userId, {
        name, fileName: state.activeFileName || 'Unknown',
        rowCount: state.features.length, features: state.features,
      });
      state.activeSessionId         = result.id;
      state.activeSessionName       = name;
      state.activeSessionStorageRef = result.storageRef;
    }
    state.sessions = await getSessions(state.companyId);
    updateSessionChip();
    closeSaveSessionModal();
  } catch (e) {
    console.error('Save session failed:', e);
    alert('Save failed — Firebase Storage must be enabled (Blaze plan required).\n\n' + e.message);
  } finally {
    saveBtn.textContent = '💾 Save'; saveBtn.disabled = false;
  }
};

// Allow pressing Enter in the name field to save
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('session-name-input');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSaveSession(); });
});

window.openSessionsModal = async function() {
  // Refresh list each time modal opens
  state.sessions = await getSessions(state.companyId).catch(() => state.sessions);
  renderSessionsList();
  document.getElementById('sessions-overlay').classList.add('open');
};
window.closeSessionsModal = function() {
  document.getElementById('sessions-overlay').classList.remove('open');
};

function renderSessionsList() {
  const body = document.getElementById('sessions-list-body');
  if (!state.sessions.length) {
    body.innerHTML = `
      <div class="no-sessions">
        <div class="ns-icon">📁</div>
        <div style="font-weight:600;color:#475569;margin-bottom:6px">No saved sessions yet</div>
        <div style="font-size:12px">Upload and process a file, then click <strong>💾 Save</strong> to create your first session.</div>
      </div>`;
    return;
  }
  const rows = state.sessions.map((s, i) => {
    const ts   = s.updatedAt?.toDate ? s.updatedAt.toDate() : new Date(s.updatedAt?.seconds * 1000 || Date.now());
    const date = ts.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    const loaded = s.id === state.activeSessionId;
    return `<tr${loaded ? ' style="background:#EFF6FF"' : ''}>
      <td>
        <div class="sname">${esc(s.name)}${loaded ? ' <span style="color:#3B82F6;font-size:10px;font-weight:700;letter-spacing:.5px">● ACTIVE</span>' : ''}</div>
        <div class="smeta">${esc(s.fileName || '')} &nbsp;·&nbsp; ${(s.rowCount||0).toLocaleString()} rows</div>
      </td>
      <td style="color:#64748B;font-size:12px;white-space:nowrap">${date}</td>
      <td>
        <div class="session-actions">
          ${loaded ? '<button class="btn btn-outline btn-sm" disabled style="color:#94A3B8">Loaded</button>'
                   : `<button class="btn btn-primary btn-sm" onclick="doLoadSession(${i})">Load</button>`}
          <button class="btn btn-outline btn-sm" onclick="doRenameSession(${i})">Rename</button>
          <button class="btn btn-outline btn-sm" style="color:#EF4444;border-color:#FCA5A5" onclick="doDeleteSession(${i})">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  body.innerHTML = `
    <table class="sessions-table">
      <thead><tr><th>Session</th><th>Last Saved</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

window.doLoadSession = async function(idx) {
  const session = state.sessions[idx];
  if (!session) return;
  // Swap button text while loading
  const btns = document.querySelectorAll('#sessions-list-body .btn-primary');
  btns.forEach(b => { b.textContent = 'Loading…'; b.disabled = true; });
  try {
    const features = await loadSessionFeatures(session.storageRef);
    state.features               = features;
    state.activeSessionId        = session.id;
    state.activeSessionName      = session.name;
    state.activeSessionStorageRef= session.storageRef;
    state.activeFileName         = session.fileName || '';
    state.cachedCoords  = features.map((f, i) => ({
      lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], rowIndex: i,
    }));
    state.cachedRawRows = features.map(f => ({ ...f.properties }));
    recalcPricing();
    setExportEnabled(true);
    document.getElementById('refresh-nn-btn').disabled = false;
    updateSessionChip();
    closeSessionsModal();
    switchTab('map');
    plotClusters();
    renderProcessedData();
    renderDashboard();
  } catch (e) {
    console.error('Load session failed:', e);
    alert('Could not load session. Firebase Storage must be enabled (Blaze plan required).\n\n' + e.message);
    renderSessionsList(); // restore button states
  }
};

window.doRenameSession = async function(idx) {
  const session = state.sessions[idx];
  const newName = prompt('Rename session:', session.name);
  if (!newName || newName.trim() === session.name) return;
  try {
    await renameSession(state.companyId, session.id, newName.trim());
    state.sessions[idx].name = newName.trim();
    if (state.activeSessionId === session.id) {
      state.activeSessionName = newName.trim();
      updateSessionChip();
    }
    renderSessionsList();
  } catch (e) { alert('Rename failed: ' + e.message); }
};

window.doDeleteSession = async function(idx) {
  const session = state.sessions[idx];
  if (!confirm(`Delete "${session.name}"? This cannot be undone.`)) return;
  try {
    await deleteSession(state.companyId, session.id, session.storageRef);
    state.sessions.splice(idx, 1);
    if (state.activeSessionId === session.id) {
      state.activeSessionId = null; state.activeSessionName = null;
      state.activeSessionStorageRef = null;
      updateSessionChip();
    }
    renderSessionsList();
  } catch (e) { alert('Delete failed: ' + e.message); }
};

// ── PRICING ENGINE ────────────────────────────────────────────────
function getContainerSize(svcCode) {
  if (!svcCode) return null;
  const code  = String(svcCode).toUpperCase().trim();
  const entry = state.svcCodes.find(r => r.svcCode && r.svcCode.toUpperCase() === code);
  if (entry && entry.contSize !== '' && entry.contSize != null) return parseFloat(entry.contSize);
  return null; // not in table — user must fill in the Service Codes tab
}

function lookupCompPrice(clusterNum, contSize) {
  if (clusterNum == null || clusterNum < 0) return null;
  const cn = String(clusterNum);
  const cs = parseFloat(contSize);
  const match = state.compAreas.find(r => {
    const rc = String(r.cluster || r.compArea || '').trim();
    const rs = parseFloat(r.contSize);
    return (rc === cn) && Math.abs(rs - cs) < 0.01;
  });
  return match ? parseFloat(match.price) || null : null;
}

function lookupMinPrice(contSize) {
  const cs = parseFloat(contSize);
  const match = state.minPrices.find(r => Math.abs(parseFloat(r.contSize) - cs) < 0.01);
  return match ? parseFloat(match.minBasePrice) || null : null;
}

function lookupPrefPrice(contSize) {
  const cs = parseFloat(contSize);
  const match = state.prefPrices.find(r => Math.abs(parseFloat(r.contSize) - cs) < 0.01);
  return match ? parseFloat(match.prefPrice) || null : null;
}

function calcRowPricing(props) {
  const s          = state.settings;
  const current    = parseFloat(props['Amount']) || 0;
  const mult       = parseFloat(props['Mult'])   || 1;
  const svcCode    = props['Svc_Code_Alpha'] || '';
  const contSize   = getContainerSize(svcCode);
  const dist       = parseFloat(props['distance_to_nearest']) || 0;
  const clusterNum = props['cluster'] ?? -1;

  const piPrice    = +(current * (1 + s.priceIncreaseRate)).toFixed(2);
  const priceMatch = lookupCompPrice(clusterNum, contSize);
  const minPrice   = lookupMinPrice(contSize);
  let   prefPrice  = lookupPrefPrice(contSize) || 0;

  // Outlier surcharge applies whenever road distance exceeds epsilon,
  // including in-cluster accounts (clustering uses straight-line; dist uses road miles).
  let prefAdj = prefPrice + Math.max(0, dist - s.epsilon) * s.extraChargePerMile;
  if (mult > 1) prefAdj = (prefAdj * (mult - 1) * (1 - s.quantityDiscount) + prefAdj) / mult;
  prefAdj = +prefAdj.toFixed(2);

  const ceiling = +(prefAdj * (1 + s.prefBuffer)).toFixed(2);

  let newRate;
  if (priceMatch !== null && current > priceMatch) {
    // Hold — customer already beating competitor
    newRate = current;
  } else {
    let candidate = piPrice;
    if (priceMatch !== null) candidate = Math.max(candidate, priceMatch);
    if (minPrice   !== null) candidate = Math.max(candidate, minPrice);
    newRate = Math.min(candidate, ceiling || candidate);
  }
  newRate = +newRate.toFixed(2);

  const dollarChange = +(newRate - current).toFixed(2);
  const pctChange    = current ? +((dollarChange / current) * 100).toFixed(1) : 0;

  return {
    contSize,
    piPrice,
    priceMatch: priceMatch !== null ? priceMatch : '',
    minPrice:   minPrice   !== null ? minPrice   : '',
    prefPrice:  prefAdj,
    prefPriceAdj: prefAdj,
    ceiling,
    newRate,
    dollarChange,
    pctChange,
  };
}

function recalcPricing() {
  state.features = state.features.map(f => {
    const calc = calcRowPricing(f.properties);
    return { ...f, properties: { ...f.properties, ...calc } };
  });
}

// ── RENDER: PROCESSED DATA ────────────────────────────────────────
const PROC_COLS = [
  { key: 'Account#',           label: 'Account #',        type: 'str' },
  { key: 'Svc_Code_Alpha',     label: 'Svc Code',         type: 'str' },
  { key: 'contSize',           label: 'Cont Size (yd)',   type: 'num' },
  { key: 'Amount',             label: 'Current Price',    type: '$'   },
  { key: 'Mult',               label: 'Qty',              type: 'num' },
  { key: 'TotalAmount',        label: 'Total Amount',     type: '$'   },
  { key: 'cluster',            label: 'Cluster #',        type: 'num' },
  { key: 'dbscan',             label: 'Type',             type: 'str' },
  { key: 'nearest_point',      label: 'Nearest Acct',     type: 'str' },
  { key: 'distance_to_nearest',label: 'Dist (mi, road)',  type: 'num' },
  { key: 'piPrice',            label: "PI'd Price",       type: '$',  calc: true },
  { key: 'priceMatch',         label: 'Price Match',      type: '$',  calc: true },
  { key: 'minPrice',           label: 'Min Price',        type: '$',  calc: true },
  { key: 'prefPriceAdj',       label: 'Pref Price Adj',   type: '$',  calc: true },
  { key: 'ceiling',            label: 'Ceiling',          type: '$',  calc: true },
  { key: 'newRate',            label: 'New Rate',         type: '$',  calc: true },
  { key: 'dollarChange',       label: '$ Change',         type: '$',  calc: true },
  { key: 'pctChange',          label: '% Change',         type: 'pct',calc: true },
];

function renderProcessedData() {
  const cont = document.getElementById('proc-content');
  if (!state.features.length) {
    cont.innerHTML = '<div class="no-data"><strong>No data yet</strong> — Upload a file on the Map tab.</div>';
    return;
  }

  // Sort
  let rows = state.features.map(f => f.properties);
  if (state.sortCol && state.sortDir !== 'none') {
    const col = PROC_COLS.find(c => c.key === state.sortCol);
    rows = [...rows].sort((a, b) => {
      let va = a[state.sortCol] ?? '';
      let vb = b[state.sortCol] ?? '';
      if (col && (col.type === 'num' || col.type === '$' || col.type === 'pct')) {
        va = parseFloat(va) || 0;
        vb = parseFloat(vb) || 0;
        return state.sortDir === 'asc' ? va - vb : vb - va;
      }
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      return state.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }

  const thHTML = PROC_COLS.map(c => {
    const isSort = state.sortCol === c.key;
    const icon   = !isSort || state.sortDir === 'none' ? '↕' : state.sortDir === 'asc' ? '↑' : '↓';
    const cls    = c.calc ? 'class="calc-col"' : '';
    return `<th ${cls} data-col="${c.key}" style="cursor:pointer;white-space:nowrap;user-select:none">${c.label} <span class="sort-icon" style="opacity:${isSort&&state.sortDir!=='none'?1:.35}">${icon}</span></th>`;
  }).join('');

  const tdHTML = rows.map(p => {
    return '<tr>' + PROC_COLS.map(c => {
      let v = p[c.key];
      if (v === null || v === undefined || v === '') v = '';
      let cell = '';
      if (c.key === 'contSize') {
        cell = (v !== '' && v != null) ? v : `<span style="color:#EF4444;font-weight:600" title="Set container size in the Service Codes tab">—</span>`;
      } else if (c.key === 'cluster') {
        const n = v ?? -1;
        cell = n >= 0 ? `<span class="badge badge-blue">${n}</span>` : `<span class="badge" style="background:#F1F5F9;color:#64748B">noise</span>`;
      } else if (c.key === 'pctChange') {
        const n = parseFloat(v) || 0;
        const cls2 = n > 0 ? 'pp-green' : n < 0 ? 'pp-red' : 'pp-blue';
        cell = `<span class="pct-pill ${cls2}">${n >= 0 ? '+' : ''}${n}%</span>`;
      } else if (c.type === '$') {
        cell = v !== '' ? `$${parseFloat(v).toFixed(2)}` : '—';
      } else if (c.type === 'num') {
        cell = v !== '' ? v : '—';
      } else {
        cell = v !== '' ? v : '—';
      }
      const tdCls = c.calc ? 'class="td-calc"' : '';
      return `<td ${tdCls} style="white-space:nowrap">${cell}</td>`;
    }).join('') + '</tr>';
  }).join('');

  cont.innerHTML = `
    <div class="proc-wrap">
      <table class="data-table" style="min-width:1400px">
        <thead><tr>${thHTML}</tr></thead>
        <tbody>${tdHTML}</tbody>
      </table>
    </div>`;

  // Attach sort listeners
  cont.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol !== col) { state.sortCol = col; state.sortDir = 'asc'; }
      else if (state.sortDir === 'asc') state.sortDir = 'desc';
      else if (state.sortDir === 'desc') { state.sortCol = null; state.sortDir = 'none'; }
      else { state.sortDir = 'asc'; }
      renderProcessedData();
    });
  });
}

// ── RENDER: DASHBOARD ─────────────────────────────────────────────
function renderDashboard() {
  const cont = document.getElementById('dash-content');
  if (!state.features.length) {
    cont.innerHTML = '<div class="no-data"><strong>No data yet</strong> — Upload a file on the Map tab.</div>';
    return;
  }
  const rows = state.features.map(f => f.properties);
  const n    = rows.length;

  const totalCurrent = rows.reduce((s, r) => s + (parseFloat(r['TotalAmount']) || parseFloat(r['Amount']) || 0), 0);
  const totalNew     = rows.reduce((s, r) => s + (parseFloat(r['newRate']) || 0), 0);
  const totalChange  = totalNew - totalCurrent;
  const clusters     = [...new Set(rows.filter(r => (r.cluster ?? -1) >= 0).map(r => r.cluster))].length;
  const noiseCount   = rows.filter(r => r['dbscan'] === 'noise').length;
  const avgDist      = rows.reduce((s, r) => s + (parseFloat(r['distance_to_nearest']) || 0), 0) / (n || 1);
  const increases    = rows.filter(r => parseFloat(r['newRate']) > parseFloat(r['Amount'])).length;
  const holds        = rows.filter(r => parseFloat(r['newRate']) <= parseFloat(r['Amount'])).length;
  const avgPct       = rows.reduce((s, r) => s + (parseFloat(r['pctChange']) || 0), 0) / (n || 1);

  cont.innerHTML = `
    <div class="dash-grid">
      <div class="dash-card">
        <h3>Revenue Impact</h3>
        <div class="metric-row"><span class="metric-label">Current Monthly Revenue</span><span class="metric-value">$${fmt(totalCurrent)}</span></div>
        <div class="metric-row"><span class="metric-label">Projected New Revenue</span><span class="metric-value mv-blue">$${fmt(totalNew)}</span></div>
        <div class="metric-row"><span class="metric-label">Net Change</span><span class="metric-value ${totalChange >= 0 ? 'mv-green' : 'mv-red'}">${totalChange >= 0 ? '+' : ''}$${fmt(totalChange)}</span></div>
        <div class="metric-row"><span class="metric-label">Avg Change Per Account</span><span class="metric-value">${avgPct >= 0 ? '+' : ''}${avgPct.toFixed(1)}%</span></div>
      </div>
      <div class="dash-card">
        <h3>Account Summary</h3>
        <div class="metric-row"><span class="metric-label">Total Accounts</span><span class="metric-value">${n}</span></div>
        <div class="metric-row"><span class="metric-label">Price Increases</span><span class="metric-value mv-green">${increases}</span></div>
        <div class="metric-row"><span class="metric-label">Holds (already at/above match)</span><span class="metric-value mv-orange">${holds}</span></div>
        <div class="metric-row"><span class="metric-label">Noise / Outlier Accounts</span><span class="metric-value">${noiseCount}</span></div>
      </div>
      <div class="dash-card">
        <h3>Clustering</h3>
        <div class="metric-row"><span class="metric-label">Competitive Clusters</span><span class="metric-value mv-blue">${clusters}</span></div>
        <div class="metric-row"><span class="metric-label">Epsilon (miles)</span><span class="metric-value">${state.settings.epsilon} mi</span></div>
        <div class="metric-row"><span class="metric-label">Min Points</span><span class="metric-value">${state.settings.minPoints}</span></div>
        <div class="metric-row"><span class="metric-label">Avg Distance to Nearest</span><span class="metric-value">${avgDist.toFixed(2)} mi</span></div>
      </div>
      <div class="dash-card">
        <h3>Pricing Settings</h3>
        <div class="metric-row"><span class="metric-label">PI Rate</span><span class="metric-value">${pct(state.settings.priceIncreaseRate)}</span></div>
        <div class="metric-row"><span class="metric-label">Qty Discount</span><span class="metric-value">${pct(state.settings.quantityDiscount)}</span></div>
        <div class="metric-row"><span class="metric-label">Pref Buffer (ceiling)</span><span class="metric-value">${pct(state.settings.prefBuffer)}</span></div>
        <div class="metric-row"><span class="metric-label">Extra $/Mile</span><span class="metric-value">$${state.settings.extraChargePerMile}</span></div>
      </div>
    </div>`;
}

function fmt(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── RENDER: COMP AREAS ────────────────────────────────────────────
function renderCompAreas() {
  const tbody = document.getElementById('comp-tbody');
  tbody.innerHTML = state.compAreas.map((row, i) => `
    <tr>
      <td><input class="td-input" value="${esc(row.compArea||'')}" onchange="updateCompRow(${i},'compArea',this.value)"></td>
      <td><input class="td-input" value="${esc(row.cluster||'')}" onchange="updateCompRow(${i},'cluster',this.value)"></td>
      <td><input class="td-input" type="number" step="0.5" value="${row.contSize||''}" onchange="updateCompRow(${i},'contSize',this.value)"></td>
      <td class="col-r"><input class="td-input" type="number" step="0.01" value="${row.price||''}" onchange="updateCompRow(${i},'price',this.value)"></td>
      <td class="col-r td-calc">${row.price && row.contSize ? '$'+(parseFloat(row.price)/parseFloat(row.contSize)).toFixed(2) : '—'}</td>
      <td><button class="btn-icon btn-icon-danger" onclick="deleteCompRow(${i})">×</button></td>
    </tr>`).join('');
}

window.addCompRow = function() {
  state.compAreas.push({ compArea: '', cluster: '', contSize: '', price: '' });
  renderCompAreas();
  scheduleAutoSave('compAreas');
};
window.deleteCompRow = function(i) {
  state.compAreas.splice(i, 1);
  renderCompAreas();
  scheduleAutoSave('compAreas');
};
window.updateCompRow = function(i, field, val) {
  state.compAreas[i][field] = val;
  if (field === 'price' || field === 'contSize') renderCompAreas();
  scheduleAutoSave('compAreas');
  if (state.features.length) { recalcPricing(); renderProcessedData(); renderDashboard(); }
};

// ── RENDER: MIN PRICES ────────────────────────────────────────────
function renderMinPrices() {
  const tbody = document.getElementById('min-tbody');
  tbody.innerHTML = state.minPrices.map((row, i) => `
    <tr>
      <td><input class="td-input" type="number" step="0.5" value="${row.contSize||''}" onchange="updateMinRow(${i},'contSize',this.value)"></td>
      <td class="col-r"><input class="td-input" type="number" step="0.01" value="${row.minBasePrice||''}" onchange="updateMinRow(${i},'minBasePrice',this.value)"></td>
      <td class="col-r td-calc">${row.minBasePrice && row.contSize ? '$'+(parseFloat(row.minBasePrice)/parseFloat(row.contSize)).toFixed(2) : '—'}</td>
      <td><button class="btn-icon btn-icon-danger" onclick="deleteMinRow(${i})">×</button></td>
    </tr>`).join('');
}

window.addMinRow = function() {
  state.minPrices.push({ contSize: '', minBasePrice: '' });
  renderMinPrices();
  scheduleAutoSave('minPrices');
};
window.deleteMinRow = function(i) {
  state.minPrices.splice(i, 1);
  renderMinPrices();
  scheduleAutoSave('minPrices');
};
window.updateMinRow = function(i, field, val) {
  state.minPrices[i][field] = val;
  if (field === 'minBasePrice' || field === 'contSize') renderMinPrices();
  scheduleAutoSave('minPrices');
  if (state.features.length) { recalcPricing(); renderProcessedData(); renderDashboard(); }
};

// ── RENDER: PREFERRED PRICES ───────────────────────────────────────
function renderPrefPrices() {
  const tbody = document.getElementById('pref-tbody');
  tbody.innerHTML = state.prefPrices.map((row, i) => `
    <tr>
      <td><input class="td-input" type="number" step="0.5" value="${row.contSize||''}" onchange="updatePrefRow(${i},'contSize',this.value)"></td>
      <td class="col-r"><input class="td-input" type="number" step="0.01" value="${row.prefPrice||''}" onchange="updatePrefRow(${i},'prefPrice',this.value)"></td>
      <td class="col-r td-calc">${row.prefPrice && row.contSize ? '$'+(parseFloat(row.prefPrice)/parseFloat(row.contSize)).toFixed(2) : '—'}</td>
      <td><button class="btn-icon btn-icon-danger" onclick="deletePrefRow(${i})">×</button></td>
    </tr>`).join('');
}

window.addPrefRow = function() {
  state.prefPrices.push({ contSize: '', prefPrice: '' });
  renderPrefPrices();
  scheduleAutoSave('prefPrices');
};
window.deletePrefRow = function(i) {
  state.prefPrices.splice(i, 1);
  renderPrefPrices();
  scheduleAutoSave('prefPrices');
};
window.updatePrefRow = function(i, field, val) {
  state.prefPrices[i][field] = val;
  if (field === 'prefPrice' || field === 'contSize') renderPrefPrices();
  scheduleAutoSave('prefPrices');
  if (state.features.length) { recalcPricing(); renderProcessedData(); renderDashboard(); }
};

// ── RENDER: SERVICE CODES ─────────────────────────────────────────
function renderServiceCodes() {
  const tbody = document.getElementById('svc-tbody');
  if (!state.svcCodes.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94A3B8;padding:16px">No service codes yet — upload a file to auto-populate, or add manually.</td></tr>';
    return;
  }
  tbody.innerHTML = state.svcCodes.map((row, i) => {
    const missingSize = row.contSize === '' || row.contSize == null;
    return `
    <tr>
      <td><span class="svc-badge">${esc(row.svcCode || '')}</span></td>
      <td><input class="td-input${missingSize ? ' input-required' : ''}" type="number" step="0.5" value="${row.contSize||''}" onchange="updateSvcRow(${i},'contSize',this.value)" placeholder="Required"></td>
      <td><input class="td-input" value="${esc(row.description||'')}" onchange="updateSvcRow(${i},'description',this.value)" placeholder="Optional description"></td>
      <td><button class="btn-icon btn-icon-danger" onclick="deleteSvcRow(${i})">×</button></td>
    </tr>`;
  }).join('');
}

window.addSvcRow = function() {
  state.svcCodes.push({ svcCode: '', contSize: '', description: '' });
  // For manually-added rows, allow editing the svcCode too
  const tbody = document.getElementById('svc-tbody');
  const i = state.svcCodes.length - 1;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="td-input" value="" onchange="updateSvcRow(${i},'svcCode',this.value)" placeholder="e.g. F2Y1W1"></td>
    <td><input class="td-input" type="number" step="0.5" value="" onchange="updateSvcRow(${i},'contSize',this.value)" placeholder="e.g. 2"></td>
    <td><input class="td-input" value="" onchange="updateSvcRow(${i},'description',this.value)" placeholder="Optional description"></td>
    <td><button class="btn-icon btn-icon-danger" onclick="deleteSvcRow(${i})">×</button></td>`;
  tbody.appendChild(tr);
  scheduleAutoSave('svcCodes');
};
window.deleteSvcRow = function(i) {
  state.svcCodes.splice(i, 1);
  renderServiceCodes();
  scheduleAutoSave('svcCodes');
};
window.updateSvcRow = function(i, field, val) {
  if (state.svcCodes[i]) state.svcCodes[i][field] = val;
  if (field === 'contSize') { renderServiceCodes(); if (state.features.length) { recalcPricing(); renderProcessedData(); renderDashboard(); } }
  scheduleAutoSave('svcCodes');
};

window.clearSvcCodes = async function() {
  if (!confirm('Clear the entire service code table? Next upload will re-populate it.')) return;
  state.svcCodes = [];
  renderServiceCodes();
  await dbClearSvcCodes(state.companyId);
};

async function autoPopulateSvcCodes(jsonData) {
  const seen = new Set();
  const codes = [];
  jsonData.forEach(row => {
    const code = (row['Svc_Code_Alpha'] || '').trim();
    if (code && !seen.has(code)) {
      seen.add(code);
      codes.push({ svcCode: code, contSize: '', description: '' });
    }
  });
  state.svcCodes = codes;
  renderServiceCodes();
  await saveServiceCodes(state.companyId, codes);
}


// ── AUTO SAVE ─────────────────────────────────────────────────────
function scheduleAutoSave(type) {
  debounce('save_' + type, async () => {
    if (type === 'compAreas')  await saveCompAreas(state.companyId, state.compAreas);
    if (type === 'minPrices')  await saveMinPrices(state.companyId, state.minPrices);
    if (type === 'prefPrices') await savePrefPrices(state.companyId, state.prefPrices);
    if (type === 'svcCodes')   await saveServiceCodes(state.companyId, state.svcCodes);
  }, 800);
}

// ── EXPORT EXCEL ──────────────────────────────────────────────────
window.exportExcel = function() {
  if (!state.features.length) { alert('No data to export.'); return; }
  const header = PROC_COLS.map(c => c.label);
  const rows   = state.features.map(f => {
    return PROC_COLS.map(c => {
      const v = f.properties[c.key];
      if (c.key === 'cluster') return v ?? 'noise';
      return v ?? '';
    });
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Processed Data');

  // Comp Areas sheet
  if (state.compAreas.length) {
    const ws2 = XLSX.utils.json_to_sheet(state.compAreas);
    XLSX.utils.book_append_sheet(wb, ws2, 'Comp Areas');
  }
  // Min Prices sheet
  if (state.minPrices.length) {
    const ws3 = XLSX.utils.json_to_sheet(state.minPrices);
    XLSX.utils.book_append_sheet(wb, ws3, 'Min Base Price');
  }
  // Preferred Prices sheet
  if (state.prefPrices.length) {
    const ws4 = XLSX.utils.json_to_sheet(state.prefPrices);
    XLSX.utils.book_append_sheet(wb, ws4, 'Preferred Price');
  }

  XLSX.writeFile(wb, 'QuoteIQ_Export.xlsx');
};

// ── EXPORT PDF ────────────────────────────────────────────────────
window.exportPDF = async function() {
  const rows  = state.features.map(f => f.properties);
  const n     = rows.length;
  if (!n) { alert('No data to export.'); return; }

  const totalCurrent = rows.reduce((s, r) => s + (parseFloat(r['Amount']) || 0), 0);
  const totalNew     = rows.reduce((s, r) => s + (parseFloat(r['newRate']) || 0), 0);
  const totalChange  = totalNew - totalCurrent;
  const clusters     = [...new Set(rows.filter(r => (r.cluster ?? -1) >= 0).map(r => r.cluster))].length;

  const pdfArea = document.getElementById('pdf-area');
  pdfArea.innerHTML = `
    <div class="pdf-title">QuoteIQ Pricing Report</div>
    <div class="pdf-sub">Generated ${new Date().toLocaleDateString()} — ${n} accounts</div>
    <div class="pdf-section">
      <h2>Revenue Summary</h2>
      <div class="pdf-grid2">
        <div>
          <div class="pdf-metric"><span class="pdf-metric-label">Current Monthly Revenue</span><span class="pdf-metric-value">$${fmt(totalCurrent)}</span></div>
          <div class="pdf-metric"><span class="pdf-metric-label">Projected New Revenue</span><span class="pdf-metric-value">$${fmt(totalNew)}</span></div>
          <div class="pdf-metric"><span class="pdf-metric-label">Net Change</span><span class="pdf-metric-value">${totalChange >= 0 ? '+' : ''}$${fmt(totalChange)}</span></div>
        </div>
        <div>
          <div class="pdf-metric"><span class="pdf-metric-label">Competitive Clusters</span><span class="pdf-metric-value">${clusters}</span></div>
          <div class="pdf-metric"><span class="pdf-metric-label">PI Rate</span><span class="pdf-metric-value">${pct(state.settings.priceIncreaseRate)}</span></div>
          <div class="pdf-metric"><span class="pdf-metric-label">Pref Buffer</span><span class="pdf-metric-value">${pct(state.settings.prefBuffer)}</span></div>
        </div>
      </div>
    </div>
    <div class="pdf-section">
      <h2>Comp Areas</h2>
      <table class="pdf-table"><thead><tr><th>Comp Area</th><th>Cluster</th><th>Cont Size</th><th>Price</th></tr></thead>
      <tbody>${state.compAreas.map(r => `<tr><td>${r.compArea||''}</td><td>${r.cluster||''}</td><td>${r.contSize||''} yd</td><td>$${parseFloat(r.price||0).toFixed(2)}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="pdf-section">
      <h2>Min Base Prices &amp; Preferred Prices</h2>
      <div class="pdf-grid2">
        <div>
          <table class="pdf-table"><thead><tr><th>Cont Size</th><th>Min Base Price</th></tr></thead>
          <tbody>${state.minPrices.map(r => `<tr><td>${r.contSize||''} yd</td><td>$${parseFloat(r.minBasePrice||0).toFixed(2)}</td></tr>`).join('')}</tbody></table>
        </div>
        <div>
          <table class="pdf-table"><thead><tr><th>Cont Size</th><th>Preferred Price</th></tr></thead>
          <tbody>${state.prefPrices.map(r => `<tr><td>${r.contSize||''} yd</td><td>$${parseFloat(r.prefPrice||0).toFixed(2)}</td></tr>`).join('')}</tbody></table>
        </div>
      </div>
    </div>`;

  const canvas = await html2canvas(pdfArea, { scale: 1.5, useCORS: true });
  const { jsPDF } = window.jspdf;
  const pdf  = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pw   = pdf.internal.pageSize.getWidth();
  const ph   = pdf.internal.pageSize.getHeight();
  const imgH = (canvas.height * pw) / canvas.width;
  let   y    = 0;
  while (y < imgH) {
    if (y > 0) pdf.addPage();
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, -y, pw, imgH);
    y += ph;
  }
  pdf.save('QuoteIQ_Report.pdf');
  pdfArea.innerHTML = '';
};

// ── HELP MODAL ────────────────────────────────────────────────────
window.openHelp = function() {
  document.getElementById('help-overlay').classList.add('open');
};
window.closeHelp = function() {
  document.getElementById('help-overlay').classList.remove('open');
};
window.closeHelpOutside = function(e) {
  if (e.target === document.getElementById('help-overlay')) closeHelp();
};

// ── SIGN OUT ─────────────────────────────────────────────────────
window.signOutUser = async function() {
  await authSignOut();
};

// ── UTILITIES ────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
