import {Deck, _GlobeView as GlobeView, AmbientLight, PointLight, LightingEffect} from "@deck.gl/core";
import {BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer} from "@deck.gl/layers";


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

const PAN_SENSITIVITY = 0.1; 
let isInteracting = false;
let draggingNow = false;

/* ===================== Deck setup ===================== */

const deck = new Deck({
  canvas: "deck-canvas",
  views: [new GlobeView()],
  controller: {
    dragRotate: false,        
    dragPan: true,
    scrollZoom: { speed: 0.03, smooth: true },   
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

deck.setProps({
  onViewStateChange: ({viewState, interactionState}) => {
    const prev = currentViewState;

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

const MAX_ALT_KM = 700;                 
const ALT_METERS = MAX_ALT_KM * 1000;
const MAX_ALT_KM_BASE = 500;
const MAX_ALT_KM_PER_INTENSITY = 80; // km per intensity index
function arcAltitude(t, maxAltMeters = ALT_METERS) {
  const clamped = Math.max(0, Math.min(1, t));
  const s = Math.sin(Math.PI * clamped);
  return maxAltMeters * Math.pow(s, 1.2);
}


const TRAVEL_MS = 1200;  
const FADE_MS   = 2000;  

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

function gcInterpolate([lng1, lat1], [lng2, lat2], t) {
  const toRad = d => (d * Math.PI) / 180;
  const toDeg = r => (r * 180) / Math.PI;
  const φ1 = toRad(lat1), λ1 = toRad(lng1);
  const φ2 = toRad(lat2), λ2 = toRad(lng2);

  const v = (φ, λ) => [Math.cos(φ)*Math.cos(λ), Math.cos(φ)*Math.sin(λ), Math.sin(φ)];
  const A = v(φ1, λ1), B = v(φ2, λ2);
  const dot = Math.max(-1, Math.min(1, A[0]*B[0] + A[1]*B[1] + A[2]*B[2]));
  const ω = Math.acos(dot) || 1e-12, sinω = Math.sin(ω);
  const k1 = Math.sin((1 - t) * ω) / sinω, k2 = Math.sin(t * ω) / sinω;

  const x = k1*A[0] + k2*B[0], y = k1*A[1] + k2*B[1], z = k1*A[2] + k2*B[2];
  const φ = Math.atan2(z, Math.hypot(x, y)), λ = Math.atan2(y, x);
  return [toDeg(λ), toDeg(φ)];
}

function gcPoints(src, dst, t, segments = 32, maxAltMeters = ALT_METERS) {
  const out = [];
  const end = Math.max(0.02, Math.min(1, t));
  const steps = Math.max(1, Math.round(segments * end));
  for (let i = 0; i <= steps; i++) {
    const f = i / segments;
    const pos = gcInterpolate(src, dst, f);
    out.push([pos[0], pos[1], arcAltitude(f, maxAltMeters)]);
  }
  return out;
}




function getCentroid(code) {
  if (!code) return null;
  const c = CENTROIDS[code.toUpperCase()];
  return Array.isArray(c) ? c : null;
}

function widthFromIntensity(x) {
  const n = Number(x) || 1;
  return 2 * Math.max(0.6, Math.min(4, Math.sqrt(n)));
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

function buildTrailLayer() {
  return new PathLayer({
    id: "attack-trails",
    data: arcs.slice(),                        
    getPath: d => gcPoints(d.sourcePosition, d.finalTarget, d.progress, 48, d.maxAltMeters),
    getWidth: d => d.width,
    widthUnits: "pixels",
    getColor: d => {
      const a = Math.round((d.alpha ?? 1) * 200); 
      return [d.color[0], d.color[1], d.color[2], a];
    },
    pickable: false,
    parameters: { depthTest: true, blend: true }
  });
}

function buildHeadLayer() {
  return new ScatterplotLayer({
    id: "attack-heads",
    data: arcs.slice(),
    getPosition: d => {
      const p = Math.max(0.02, d.progress);
      const pos = gcInterpolate(d.sourcePosition, d.finalTarget, p);
      return [pos[0], pos[1], arcAltitude(p, d.maxAltMeters)];
    },
    getRadius: d => 40000 + d.width * 12000,       
    radiusUnits: "meters",
    getFillColor: d => {
      const a = Math.round((d.alpha ?? 1) * 255);  
      return [d.color[0], d.color[1], d.color[2], a];
    },
    stroked: false,
    pickable: false,
    parameters: { depthTest: true, blend: true }
  });
}


function buildLayers() {
  const out = [];
  out.push(buildEarthLayer());
  const countries = buildCountriesLayer();
  if (countries) out.push(countries);
  out.push(buildTrailLayer());
  out.push(buildHeadLayer());
  return out;
}

function updateLayers() {
  deck.setProps({ layers: buildLayers() });
}

function animateArcs() {
  const now = performance.now();

  for (let i = arcs.length - 1; i >= 0; i--) {
    const a = arcs[i];
    const age = now - (a._born || now);
    const t = Math.min(1, age / TRAVEL_MS);
    a.progress = 1 - Math.pow(1 - t, 3); 

    if (a.progress >= 1) {
      const fadeT = Math.min(1, (age - TRAVEL_MS) / FADE_MS);
      a.alpha = 1 - fadeT;
    } else {
      a.alpha = 1;
    }

    a.width = Math.max(0.8, a.width * (0.996 + 0.004 * (a.alpha ?? 1)));

    if (age >= TRAVEL_MS + FADE_MS) {
      arcs.splice(i, 1);
    }
  }

  updateLayers();
  requestAnimationFrame(animateArcs);
}

/* ===================== Infographic (live KPIs & Top sources) ===================== */

const WINDOW_MS = 5 * 60 * 1000;
let windowEvents = [];

function pruneWindow(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  let idx = 0;
  while (idx < windowEvents.length && windowEvents[idx].ts < cutoff) idx++;
  if (idx) windowEvents.splice(0, idx);
}

function renderInfographic() {
  const now = Date.now();

  const ONE_MIN = 60 * 1000;
  const epm = windowEvents.filter(e => e.ts >= now - ONE_MIN).length;

  const total = windowEvents.length;

  let totalIntensity = 0;
  const byCountry = new Map(); 
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
  const epmEl = document.getElementById("kpi-epm");
  if (epmEl) epmEl.textContent = String(epm);
  const intEl = document.getElementById("kpi-intensity");
  if (intEl) intEl.textContent = String(totalIntensity);

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

  const statusEl = document.getElementById("status");
  if (statusEl) {
    const last = windowEvents[windowEvents.length - 1];
    const lastStr = last ? `${last.country} • x${last.intensity}` : "—";
    // statusEl.textContent = `Live data connected — last: ${lastStr} — 5-min total: ${total}`;
  }

  const lastTick = document.getElementById("lastTick");
  if (lastTick) {
    const d = new Date();
    lastTick.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}

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
  const lookupCentroid = (code) => {
    if (!code) return null;
    const k = String(code).toUpperCase();
    const pt = CENTROIDS && CENTROIDS[k];
    return Array.isArray(pt) ? pt : null;
  };
  const jitterHub = (seedStr) => {
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) h = ((h << 5) - h + seedStr.charCodeAt(i)) | 0;
    h = Math.abs(h);
    const r = 10 + (h % 100) / 100 * 12;        
    const ang = ((h / 100) % 360) * (Math.PI / 180);
    return [r * Math.cos(ang), r * Math.sin(ang)];
  };

  const ts = Number(evt.ts || Date.now());
  const srcCode = (evt.src_country || "").toUpperCase();
  const dstCode = (evt.dst_country || "GLOBAL").toUpperCase();
  const src = lookupCentroid(srcCode) || jitterHub("SRC|" + srcCode);
  const dst = (dstCode !== "GLOBAL" && lookupCentroid(dstCode)) || jitterHub(`HUB|${srcCode}|${ts}`);

  const initialT = 0.02;
  const intensity = Number(evt.intensity_index || 1);

  arcs.push({
    sourcePosition: [src[0], src[1]],
    finalTarget: [dst[0], dst[1]],
    color: nextColor(),
    width: widthFromIntensity(intensity),
    _born: performance.now(),
    progress: initialT,
    alpha: 1,
    maxAltMeters: 3 * (MAX_ALT_KM_BASE + MAX_ALT_KM_PER_INTENSITY * intensity) * 1000
  });


  if (arcs.length > MAX_ARCS) arcs.splice(0, arcs.length - MAX_ARCS);

  windowEvents.push({
    ts,
    country: srcCode || "??",
    intensity: Number(evt.intensity_index || 1)
  });
  pruneWindow(Date.now());
  scheduleInfographic();

  updateLayers();
}


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

function hubJitter(seed) {
  const r = 10 + (seed % 100) / 100 * 12;
  const ang = ((seed / 100) % 360) * (Math.PI / 180);
  return [r * Math.cos(ang), r * Math.sin(ang)];
}

function resolveDestination(dstCode, ts, srcLngLat) {
  const c = (dstCode || '').toUpperCase();
  const cen = centroidFor(c);
  if (cen) return cen;
  const seed = hashStr(String(srcLngLat[0]) + ',' + String(srcLngLat[1]) + '|' + String(ts) + '|' + c);
  return hubJitter(seed);
}


/* ===================== Robust SSE Connector (local + Vercel) ===================== */

const candidates = [
  "/api/events",                     
  "http://localhost:3000/api/events", 
  "http://localhost:3000/events",   
  "http://localhost:3000/stream"      
];

let es = globalThis.__ddos_es;

async function connectSSE() {
  if (es && es.readyState !== 2) {
    try { es.close(); } catch {}
  }
  es = null;

  for (const url of candidates) {
    try {
      console.log("SSE: trying", url);
      const source = new EventSource(url, { withCredentials: false });

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("open timeout")), 4000);
        source.onopen = () => { clearTimeout(t); resolve(); };
        source.onerror = () => {}; 
      });

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

      return; 
    } catch (err) {
      console.warn("SSE connect failed for", url, err?.message || err);
    }
  }

  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = "Unable to connect (retrying)…";
  setTimeout(connectSSE, 3000);
}

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
