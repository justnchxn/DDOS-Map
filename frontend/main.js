import {Deck, _GlobeView as GlobeView, AmbientLight, PointLight, LightingEffect} from "@deck.gl/core";
import {ArcLayer, BitmapLayer, GeoJsonLayer} from "@deck.gl/layers";

const STREAM_URL = "http://localhost:3000/stream";
const GLOBAL_POINT = [0, 0];
const MAX_ARCS = 150;       
const ARC_FADE_SPEED = 0.05;
const WINDOW_MS = 5 * 60 * 1000;

let CENTROIDS = {};
let COUNTRIES = null;

async function loadCentroids() {
  const res = await fetch("/country-centroids.json");
  CENTROIDS = await res.json();
}
async function loadCountries() {
  const res = await fetch("/countries.geojson");
  COUNTRIES = await res.json();
}
await Promise.all([loadCentroids(), loadCountries()]);

const lighting = new LightingEffect({
  ambient: new AmbientLight({intensity: 1}),
  keyLight: new PointLight({position: [0,0,8e6], intensity: 1})
});

let currentViewState = {
  latitude: 20, longitude: -20, zoom: 0.6, minZoom: -0.2, maxZoom: 2.0,
  rotationX: 0, rotationOrbit: 0
};
let isInteracting = false;
let draggingNow = false;

const PAN_SENSITIVITY = 0.1; 

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
  useDevicePixels: 1,
  effects: [lighting],
  parameters: { depthTest: true, blend: true },
  getCursor: () => "grab"
});


deck.setProps({
  onViewStateChange: ({ viewState, interactionState }) => {
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



const earthLayer = new BitmapLayer({
  id: "earth",
  image: "/earth.jpg",
  bounds: [-180, -90, 180, 90],
  opacity: 0.95,
  pickable: false
});

function countriesLayer() {
  if (!COUNTRIES) return null;
  const shade = (iso2) => {
    const s = (iso2 || "").split("").reduce((a,c)=>a+c.charCodeAt(0),0);
    const v = 30 + (s % 18);
    return [v, v+6, v+12, 220];
  };
  return new GeoJsonLayer({
    id: "countries",
    data: COUNTRIES,
    stroked: true, filled: true, wireframe: false, opacity: 0.9,
    getFillColor: f => shade(f.properties.ISO_A2 || f.properties.iso_a2),
    getLineColor: [80,110,140,180],
    getLineWidth: 1, lineWidthUnits: "pixels",
    pickable: false
  });
}
const COLORS = [[120,180,255],[255,120,160],[120,255,200],[255,190,120],[190,140,255]];
let colorIdx = 0; const nextColor = () => COLORS[(colorIdx++) % COLORS.length];

let arcs = []; 
let windowEvents = []; 

function getCentroid(code) {
  if (!code) return null;
  const c = CENTROIDS[code.toUpperCase()];
  return Array.isArray(c) ? c : null;
}
function widthFromIntensity(x) {
  const n = Number(x) || 1;
  return Math.max(0.6, Math.min(4, Math.sqrt(n)));
}

function pruneWindow(now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  let idx = 0;
  while (idx < windowEvents.length && windowEvents[idx].ts < cutoff) idx++;
  if (idx > 0) windowEvents.splice(0, idx);
}

const es = new EventSource(STREAM_URL);
es.onopen = () => (statusEl.textContent = "Live data connected");
es.onerror = () => (statusEl.textContent = "Connection issue… (using cache)");
es.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  const now = Date.now();

  const src = getCentroid(evt.src_country) || [Math.random()*360-180, Math.random()*180-90];
  arcs.push({ src, age: 0, width: widthFromIntensity(evt.intensity_index), color: nextColor() });
  if (arcs.length > MAX_ARCS) arcs.splice(0, arcs.length - MAX_ARCS);

  windowEvents.push({ ts: now, country: (evt.src_country || "??").toUpperCase(), intensity: Number(evt.intensity_index || 1) });
  pruneWindow(now);

  scheduleFrame();
  scheduleInfographic();
};

let rafId = null;
let lastTime = performance.now();

function scheduleFrame() {
  if (rafId) return;
  rafId = requestAnimationFrame(frame);
}

function frame(now) {
  rafId = null;

  const dt = Math.min(100, now - lastTime);
  lastTime = now;
  const fade = ARC_FADE_SPEED * (dt / 16.67);
  for (const a of arcs) a.age = Math.min(1, a.age + fade);

  const arcData = arcs.map(a => ({
    sourcePosition: a.src,
    targetPosition: GLOBAL_POINT,
    width: a.width,
    sourceColor: [...a.color, Math.floor(255 * (1 - a.age))],
    targetColor: [200, 220, 255, Math.floor(200 * (1 - a.age))]
  }));

  deck.setProps({
    layers: [
      earthLayer,
      countriesLayer(),
      new ArcLayer({
        id: "arcs",
        data: arcData,
        greatCircle: true,
        getSourcePosition: d => d.sourcePosition,
        getTargetPosition: d => d.targetPosition,
        getWidth: d => d.width,
        getSourceColor: d => d.sourceColor,
        getTargetColor: d => d.targetColor,
        pickable: false
      })
    ].filter(Boolean)
  });

  if (!isInteracting) {
    currentViewState = {...currentViewState, rotationOrbit: (currentViewState.rotationOrbit + 0.05) % 360};
    deck.setProps({viewState: currentViewState});
  }

  if (arcs.length) scheduleFrame();
}

scheduleFrame();

const elEpm = document.getElementById("kpi-epm");
const elIntensity = document.getElementById("kpi-intensity");
const elTop = document.getElementById("top");
const elLastTick = document.getElementById("lastTick");

let infoTimer = null;
function scheduleInfographic() {
  if (infoTimer) return;
  infoTimer = setTimeout(updateInfographic, 500);
}

function updateInfographic() {
  infoTimer = null;
  const now = Date.now();
  pruneWindow(now);

  const oneMin = now - 60 * 1000;
  const epm = windowEvents.filter(e => e.ts >= oneMin).length;
  elEpm.textContent = epm.toString();

  const totalIntensity = windowEvents.reduce((acc, e) => acc + e.intensity, 0);
  elIntensity.textContent = Math.round(totalIntensity).toLocaleString();
  const byCountry = new Map();
  for (const e of windowEvents) byCountry.set(e.country, (byCountry.get(e.country) || 0) + e.intensity);
  const top = Array.from(byCountry.entries())
    .sort((a,b) => b[1] - a[1])
    .slice(0, 6);
  elTop.innerHTML = "";
  const maxVal = top[0]?.[1] || 1;
  for (const [iso2, val] of top) {
    const tr = document.createElement("tr");

    const tdCountry = document.createElement("td");
    tdCountry.className = "country";
    tdCountry.textContent = iso2;
    tr.appendChild(tdCountry);

    const tdBar = document.createElement("td");
    tdBar.style.width = "100%";
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(4, (val / maxVal) * 100)}%`;
    bar.appendChild(fill);
    tdBar.appendChild(bar);
    tr.appendChild(tdBar);

    const tdVal = document.createElement("td");
    tdVal.className = "value";
    tdVal.textContent = Math.round(val).toLocaleString();
    tr.appendChild(tdVal);

    elTop.appendChild(tr);
  }

  elLastTick.textContent = new Date().toLocaleTimeString();
}
