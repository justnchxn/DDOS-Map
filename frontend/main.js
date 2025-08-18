import {Deck, _GlobeView as GlobeView, AmbientLight, PointLight, LightingEffect} from "@deck.gl/core";
import {ArcLayer, BitmapLayer, GeoJsonLayer} from "@deck.gl/layers";

/* ===================== Static data ===================== */

let CENTROIDS = {};
let COUNTRIES = null;

async function loadCentroids() {
  const res = await fetch("/country-centroids.json");
  if (!res.ok) throw new Error("Failed to load centroids");
  CENTROIDS = await res.json();
}
async function loadCountries() {
  const res = await fetch("/countries.geojson");
  if (!res.ok) throw new Error("Failed to load countries");
  COUNTRIES = await res.json();
}
await Promise.all([loadCentroids(), loadCountries()]);

/* ===================== Lighting / View ===================== */

const lighting = new LightingEffect({
  ambient: new AmbientLight({intensity: 1}),
  keyLight: new PointLight({position: [0, 0, 8e6], intensity: 1})
});

let currentViewState = {
  latitude: 20,
  longitude: -20,
  zoom: 0.6,
  minZoom: -0.2,
  maxZoom: 2.0,
  rotationX: 0,
  rotationOrbit: 0
};

const PAN_SENSITIVITY = 0.1;  // dampen drag motion
let isInteracting = false;
let draggingNow = false;

/* ===================== Deck setup ===================== */

const deck = new Deck({
  canvas: "deck-canvas",
  views: [new GlobeView()],
  controller: {
    dragRotate: false,        
    dragPan: true,
    scrollZoom: { speed: 0.03 },   
    zoomToPointer: false,
    doubleClickZoom: false,
    touchZoom: false,
    touchRotate: true,
    keyboard: false,
    inertia: 300
  },
  initialViewState: currentViewState,
  viewState: currentViewState,
  effects: [lighting],
  parameters: { depthTest: true, blend: true },
  useDevicePixels: 1,
  getCursor: () => "grab"
});

// Tame drag & keep position during zoom gesture
deck.setProps({
  onViewStateChange: ({viewState, interactionState}) => {
    const prev = currentViewState;

    // Lock lat/lon/orbit while zooming (wheel)
    if (interactionState?.isZooming) {
      const locked = {
        ...viewState,
        latitude: prev.latitude,
        longitude: prev.longitude,
        rotationOrbit: prev.rotationOrbit
      };
      currentViewState = locked;
      deck.setProps({ viewState: locked });
      return;
    }

    // Dampen drag movement
    if (interactionState?.isDragging) {
      const slowed = {
        ...viewState,
        latitude:      prev.latitude      + (viewState.latitude      - prev.latitude)      * PAN_SENSITIVITY,
        longitude:     prev.longitude     + (viewState.longitude     - prev.longitude)     * PAN_SENSITIVITY,
        rotationOrbit: prev.rotationOrbit + (viewState.rotationOrbit - prev.rotationOrbit) * PAN_SENSITIVITY,
        zoom:          prev.zoom
      };
      currentViewState = slowed;
      deck.setProps({ viewState: slowed });
      return;
    }

    currentViewState = viewState;
    deck.setProps({ viewState });
  },

  onInteractionStateChange: (s) => {
    draggingNow = !!s?.isDragging;
    isInteracting = !!(s?.isDragging || s?.isZooming);
  }
});

// Prevent wheel + drag conflict
const canvasEl = deck.canvas || document.getElementById("deck-canvas");
if (canvasEl) {
  canvasEl.addEventListener(
    "wheel",
    (e) => {
      if (draggingNow) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { passive: false }
  );
}

/* ===================== Layers & rendering ===================== */

const COLORS = [
  [120, 180, 255],
  [255, 120, 160],
  [120, 255, 200],
  [255, 190, 120],
  [190, 140, 255]
];
let colorIdx = 0;
const nextColor = () => COLORS[(colorIdx++) % COLORS.length];

const MAX_ARCS = 150;
let arcs = [];

function getCentroid(code) {
  if (!code) return null;
  const c = CENTROIDS[code.toUpperCase()];
  return Array.isArray(c) ? c : null;
}

function widthFromIntensity(x) {
  const n = Number(x) || 1;
  return Math.max(0.6, Math.min(4, Math.sqrt(n)));
}

function buildEarthLayer() {
  return new BitmapLayer({
    id: "earth",
    image: "/earth.jpg",
    bounds: [-180, -90, 180, 90],
    opacity: 0.95,
    pickable: false
  });
}

function buildCountriesLayer() {
  if (!COUNTRIES) return null;
  const shade = (iso2) => {
    const s = (iso2 || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    const v = 30 + (s % 18);
    return [v, v + 6, v + 12, 220];
  };
  return new GeoJsonLayer({
    id: "countries",
    data: COUNTRIES,
    stroked: true,
    filled: true,
    wireframe: false,
    opacity: 0.9,
    getFillColor: f => shade(f.properties.ISO_A2 || f.properties.iso_a2),
    getLineColor: [80, 110, 140, 180],
    getLineWidth: 1,
    lineWidthUnits: "pixels",
    pickable: false
  });
}

function buildArcLayer() {
  return new ArcLayer({
    id: "attack-arcs",
    data: arcs.slice(),
    getSourcePosition: d => d.sourcePosition,
    getTargetPosition: d => d.targetPosition,
    getWidth: d => d.width,
    getSourceColor: d => {
      const alpha = 255 * Math.max(0, 1 - d.age / 2000); 
      return [d.color[0], d.color[1], d.color[2], alpha];
    },
    getTargetColor: d => {
      const alpha = 255 * Math.max(0, 1 - d.age / 2000);
      return [d.color[0], d.color[1], d.color[2], alpha];
    },
    greatCircle: true,
    pickable: false,
    parameters: { depthTest: true, blend: true }
  });
}

function buildLayers() {
  const out = [];
  out.push(buildEarthLayer());
  const countries = buildCountriesLayer();
  if (countries) out.push(countries);
  out.push(buildArcLayer());
  return out;
}

function updateLayers() {
  deck.setProps({ layers: buildLayers() });
}

function animateArcs() {
  const now = Date.now();
  const lifespan = 2000; 

  // update ages + filter out expired
  for (const arc of arcs) {
    if (!arc._born) arc._born = now;
    arc.age = now - arc._born;
  }

  // keep only arcs younger than lifespan
  for (let i = arcs.length - 1; i >= 0; i--) {
    if (arcs[i].age > lifespan) {
      arcs.splice(i, 1);
    }
  }

  updateLayers();
  requestAnimationFrame(animateArcs);
}

/* ===================== Infographic (live KPIs & Top sources) ===================== */

const WINDOW_MS = 5 * 60 * 1000;
let windowEvents = []; // {ts, country, intensity}

function pruneWindow(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  let idx = 0;
  while (idx < windowEvents.length && windowEvents[idx].ts < cutoff) idx++;
  if (idx) windowEvents.splice(0, idx);
}

function renderInfographic() {
  const now = Date.now();

  // EPM = events in last 60s
  const ONE_MIN = 60 * 1000;
  const epm = windowEvents.filter(e => e.ts >= now - ONE_MIN).length;

  // 5-minute totals
  const total = windowEvents.length;

  // Aggregate by country + intensity
  let totalIntensity = 0;
  const byCountry = new Map(); // ISO2 -> {count, intensity}
  for (const e of windowEvents) {
    totalIntensity += e.intensity;
    const rec = byCountry.get(e.country) || { count: 0, intensity: 0 };
    rec.count += 1;
    rec.intensity += e.intensity;
    byCountry.set(e.country, rec);
  }
  const top = [...byCountry.entries()]
    .sort((a, b) => (b[1].count - a[1].count) || (b[1].intensity - a[1].intensity))
    .slice(0, 5);

  // Update KPIs
  const epmEl = document.getElementById("kpi-epm");
  if (epmEl) epmEl.textContent = String(epm);
  const intEl = document.getElementById("kpi-intensity");
  if (intEl) intEl.textContent = String(totalIntensity);

  // Update Top table (no per-bar intensity line)
  const table = document.getElementById("top");
  if (table) {
    const maxCount = top.length ? top[0][1].count : 1;
    table.innerHTML =
      (top.map(([code, v]) => {
        const w = Math.round((v.count / maxCount) * 100);
        return `
          <tr>
            <td class="country">${code}</td>
            <td style="width:100%;">
              <div class="bar"><span style="width:${w}%;"></span></div>
            </td>
            <td class="value">${v.count}</td>
          </tr>
        `;
      }).join("")) || `<tr><td class="muted">—</td><td></td><td></td></tr>`;
  }

  // Status line
  const statusEl = document.getElementById("status");
  if (statusEl) {
    const last = windowEvents[windowEvents.length - 1];
    const lastStr = last ? `${last.country} • x${last.intensity}` : "—";
    statusEl.textContent = `Live data connected — last: ${lastStr} — 5-min total: ${total}`;
  }

  // Footer timestamp
  const lastTick = document.getElementById("lastTick");
  if (lastTick) {
    const d = new Date();
    lastTick.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}

// Debounced updater
let infographicTimer = null;
function scheduleInfographic() {
  if (infographicTimer) return;
  infographicTimer = setTimeout(() => {
    infographicTimer = null;
    renderInfographic();
  }, 150);
}

/* ===================== SSE: handle incoming event ===================== */

function handleSSEEvent(evt) {
  // Local, safe helpers (no external deps)
  const lookupCentroid = (code) => {
    if (!code) return null;
    const k = String(code).toUpperCase();
    const pt = CENTROIDS && CENTROIDS[k];
    return Array.isArray(pt) ? pt : null;
  };
  const jitterHub = (seedStr) => {
    // deterministic ring around (0,0) so GLOBAL arcs don’t overlap
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) h = ((h << 5) - h + seedStr.charCodeAt(i)) | 0;
    h = Math.abs(h);
    const r = 10 + (h % 100) / 100 * 12;         // 10–22°
    const ang = ((h / 100) % 360) * (Math.PI / 180);
    return [r * Math.cos(ang), r * Math.sin(ang)];
  };

  // Parse & resolve
  const ts = Number(evt.ts || Date.now());
  const srcCode = (evt.src_country || "").toUpperCase();
  const dstCode = (evt.dst_country || "GLOBAL").toUpperCase();

  const src = lookupCentroid(srcCode) || jitterHub("SRC|" + srcCode);
  const dst = (dstCode !== "GLOBAL" && lookupCentroid(dstCode)) || jitterHub(`HUB|${srcCode}|${ts}`);

  // Push a simple A→B arc (no growth animation yet)
  arcs.push({
    sourcePosition: [src[0], src[1]],
    targetPosition: [dst[0], dst[1]],
    color: nextColor(),
    width: widthFromIntensity(evt.intensity_index),
    age: 0
  });
  if (arcs.length > MAX_ARCS) arcs.splice(0, arcs.length - MAX_ARCS);

  // Live infographic window
  windowEvents.push({
    ts,
    country: srcCode || "??",
    intensity: Number(evt.intensity_index || 1)
  });
  pruneWindow(Date.now());
  scheduleInfographic();

  updateLayers();
}


// --- centroid + fallback helpers ---
function centroidFor(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  const pt = centroids && centroids[c];
  return Array.isArray(pt) ? pt : null;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Spread points around a hub so they don't overlap; returns [lng, lat]
function hubJitter(seed) {
  // ring around (0,0): radius 10–22 degrees, deterministic by seed
  const r = 10 + (seed % 100) / 100 * 12;
  const ang = ((seed / 100) % 360) * (Math.PI / 180);
  return [r * Math.cos(ang), r * Math.sin(ang)];
}

// Resolve a destination: try centroid; if GLOBAL/unknown, jitter near hub
function resolveDestination(dstCode, ts, srcLngLat) {
  const c = (dstCode || '').toUpperCase();
  const cen = centroidFor(c);
  if (cen) return cen;
  // GLOBAL or unknown → jitter near hub, seeded by src + ts so it's stable per flow
  const seed = hashStr(String(srcLngLat[0]) + ',' + String(srcLngLat[1]) + '|' + String(ts) + '|' + c);
  return hubJitter(seed);
}


/* ===================== Robust SSE Connector (local + Vercel) ===================== */

const candidates = [
  "/api/events",                      // vercel dev + prod (same-origin)
  "http://localhost:3000/api/events", // explicit local fallback
  "http://localhost:3000/events",     // legacy local Express
  "http://localhost:3000/stream"      // legacy local Express
];

let es = globalThis.__ddos_es;

async function connectSSE() {
  if (es && es.readyState !== 2 /* CLOSED */) {
    try { es.close(); } catch {}
  }
  es = null;

  for (const url of candidates) {
    try {
      console.log("SSE: trying", url);
      const source = new EventSource(url, { withCredentials: false });

      // Wait until it opens (4s timeout)
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("open timeout")), 4000);
        source.onopen = () => { clearTimeout(t); resolve(); };
        source.onerror = () => {}; // let timeout decide
      });

      // Keep this one
      es = source;
      globalThis.__ddos_es = es;

      es.onopen = () => {
        console.log("SSE open:", url);
        const statusEl = document.getElementById("status");
        if (statusEl) statusEl.textContent = "Live data connected";
      };

      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          // If we got a valid message, we're definitely live
          const statusEl = document.getElementById("status");
          if (statusEl && statusEl.textContent !== "Live data connected") {
            statusEl.textContent = "Live data connected";
          }

          handleSSEEvent(msg);
        } catch {
          console.warn("Bad SSE payload:", e.data);
        }
      };

      es.onerror = (e) => {
        console.warn("SSE error on", url, e);
        const statusEl = document.getElementById("status");
        if (statusEl) statusEl.textContent = "Reconnecting…";
        try { es.close(); } catch {}
        setTimeout(connectSSE, 2000);
      };

      return; // stop after first working URL
    } catch (err) {
      console.warn("SSE connect failed for", url, err?.message || err);
    }
  }

  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = "Unable to connect (retrying)…";
  setTimeout(connectSSE, 3000);
}

// HMR cleanup (safe on Vercel)
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    try { es?.close(); } catch {}
    delete globalThis.__ddos_es;
  });
}

/* ===================== Kick off ===================== */

updateLayers();
connectSSE();
animateArcs();
