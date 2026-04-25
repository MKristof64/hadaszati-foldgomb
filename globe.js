const DATA = window.HADASZATI_DATA;
const GEO = window.GLOBE_GEO;

const METRICS = {
  military: { label: "Katonai kiadások", unit: "millió USD", colorMode: "red" },
  defense: { label: "Védelmi kiadások", unit: "millió USD", colorMode: "red" },
  perCapita: { label: "1 főre jutó katonai kiadások", unit: "USD/fő", colorMode: "red" },
  threat: { label: "Fenyegetettségi szint", unit: "0-10", colorMode: "threat" },
};

const TERRITORY_ALIASES = {
  GRL: { countryIso: "DNK", label: "Grönland (Dánia)" },
};

const state = {
  metric: "military",
  selectedIso: "HUN",
  centerLon: 18,
  centerLat: 16,
  autoSpin: false,
  dragging: false,
  moved: false,
  dirty: true,
  zoom: 1,
};

const canvas = document.getElementById("globe-canvas");
const ctx = canvas.getContext("2d", { alpha: true });
const metricSelect = document.getElementById("globe-metric");
const metricTitle = document.getElementById("globe-metric-title");
const legend = document.getElementById("globe-legend");
const countryTitle = document.getElementById("globe-country-title");
const countryDetails = document.getElementById("globe-details");
const countrySearch = document.getElementById("globe-search");
const analysisTitle = document.getElementById("globe-analysis-title");
const analysisText = document.getElementById("globe-analysis-text");
const resetButton = document.getElementById("reset-view");
const spinButton = document.getElementById("toggle-spin");
const zoomInButton = document.getElementById("zoom-in");
const zoomOutButton = document.getElementById("zoom-out");

const countriesByIso = new Map(DATA.countries.map((country) => [country.iso3, country]));
const countriesByName = new Map(DATA.countries.map((country) => [country.name.toLocaleLowerCase("hu"), country]));
const featuresByIso = new Map(GEO.features.map((feature) => [feature.id, feature]));
const formatCompact = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 0 });

let dpr = 1;
let width = 0;
let height = 0;
let globe = { x: 0, y: 0, r: 100 };
let mapCanvas;
let mapCtx;
let mapPixels;
let hitCanvas;
let hitCtx;
let hitPixels;
let hitCountryByColor = new Map();
let mapWidth = 4096;
let mapHeight = 2048;
let globeBuffer = document.createElement("canvas");
let globeBufferCtx = globeBuffer.getContext("2d");
let dragStart = null;
let pinchStart = null;
const activePointers = new Map();
let lastFrame = performance.now();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function mix(colorA, colorB, amount) {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  const t = clamp(amount, 0, 1);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const blue = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${blue})`;
}

function metricValues(metric) {
  return DATA.countries
    .map((country) => country.values[metric])
    .filter((value) => Number.isFinite(value));
}

function maxForMetric(metric) {
  return Math.max(...metricValues(metric), 1);
}

function positiveMetricValues(metric) {
  return metricValues(metric)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
}

function percentilePosition(values, value) {
  if (!values.length) return 0;
  if (values.length === 1) return 1;

  let lowerCount = 0;
  let equalCount = 0;
  values.forEach((candidate) => {
    if (candidate < value) lowerCount += 1;
    if (candidate === value) equalCount += 1;
  });

  return clamp((lowerCount + equalCount / 2) / (values.length - 1), 0, 1);
}

function redColor(value, metric) {
  if (!Number.isFinite(value)) return "#24272c";
  if (value <= 0) return "#ffffff";

  const values = positiveMetricValues(metric);
  const max = maxForMetric(metric);
  const ratioScore = Math.pow(clamp(value / max, 0, 1), 0.45);
  const rankScore = Math.pow(percentilePosition(values, value), 1.25);
  const score = ratioScore * 0.72 + rankScore * 0.28;
  const t = 0.24 + score * 0.76;

  if (t < 0.22) return mix("#fff4f2", "#ffb2aa", t / 0.22);
  if (t < 0.67) return mix("#ffb2aa", "#d71920", (t - 0.22) / 0.45);
  return mix("#d71920", "#5a0006", (t - 0.67) / 0.33);
}

function threatColor(value) {
  if (!Number.isFinite(value)) return "#24272c";

  const t = clamp(value / 10, 0, 1);
  if (t <= 0.5) return mix("#18d26b", "#ffd33d", t / 0.5);
  return mix("#ffd33d", "#ff2d1f", (t - 0.5) / 0.5);
}

function countryForMapIso(iso3) {
  const direct = countriesByIso.get(iso3);
  if (direct) return direct;
  const alias = TERRITORY_ALIASES[iso3];
  return alias ? countriesByIso.get(alias.countryIso) : null;
}

function colorForCountry(country, metric = state.metric) {
  if (!country) return "#171a20";
  const value = country.values[metric];
  return METRICS[metric].colorMode === "threat" ? threatColor(value) : redColor(value, metric);
}

function renderLegend() {
  const metric = METRICS[state.metric];
  if (metric.colorMode === "threat") {
    legend.innerHTML = `
      <div class="legend-bar" style="background: linear-gradient(90deg, #18d26b, #ffd33d, #ff2d1f);"></div>
      <div class="legend-scale"><span>0</span><span>5</span><span>10</span></div>
    `;
    return;
  }

  const max = maxForMetric(state.metric);
  legend.innerHTML = `
    <div class="legend-bar" style="background: linear-gradient(90deg, #ffffff 0 2%, #fff4f2 10%, #ffb2aa 28%, #d71920 70%, #5a0006 100%);"></div>
    <div class="legend-scale"><span>0</span><span>${formatCompact.format(max)} ${metric.unit}</span></div>
  `;
}

function lonToX(lon, offset = 0) {
  return ((lon + offset + 180) / 360) * mapWidth;
}

function latToY(lat) {
  return ((90 - lat) / 180) * mapHeight;
}

function drawRingOnMap(context, ring, offset) {
  if (!ring.length) return;

  let previousLon = ring[0][0];
  const unwrapped = ring.map(([lon, lat], index) => {
    if (index === 0) return [lon, lat];
    let adjusted = lon;
    while (adjusted - previousLon > 180) adjusted -= 360;
    while (previousLon - adjusted > 180) adjusted += 360;
    previousLon = adjusted;
    return [adjusted, lat];
  });

  context.moveTo(lonToX(unwrapped[0][0], offset), latToY(unwrapped[0][1]));
  unwrapped.slice(1).forEach(([lon, lat]) => {
    context.lineTo(lonToX(lon, offset), latToY(lat));
  });
  context.closePath();
}

function drawFeatureOnMap(context, feature, fillStyle, strokeStyle, strokeWidth = 0.45) {
  [-360, 0, 360].forEach((offset) => {
    context.beginPath();
    if (feature.geometry.type === "Polygon") {
      feature.geometry.coordinates.forEach((ring) => drawRingOnMap(context, ring, offset));
    } else {
      feature.geometry.coordinates.forEach((polygon) => {
        polygon.forEach((ring) => drawRingOnMap(context, ring, offset));
      });
    }
    context.fillStyle = fillStyle;
    context.fill("evenodd");
    if (strokeStyle) {
      context.strokeStyle = strokeStyle;
      context.lineWidth = strokeWidth;
      context.stroke();
    }
  });
}

function buildMapTexture() {
  mapCanvas = mapCanvas || document.createElement("canvas");
  mapCanvas.width = mapWidth;
  mapCanvas.height = mapHeight;
  mapCtx = mapCanvas.getContext("2d", { willReadFrequently: true });
  mapCtx.clearRect(0, 0, mapWidth, mapHeight);

  hitCanvas = hitCanvas || document.createElement("canvas");
  hitCanvas.width = mapWidth;
  hitCanvas.height = mapHeight;
  hitCtx = hitCanvas.getContext("2d", { willReadFrequently: true });
  hitCtx.clearRect(0, 0, mapWidth, mapHeight);
  hitCountryByColor = new Map();

  GEO.features.forEach((feature) => {
    const country = countryForMapIso(feature.id);
    drawFeatureOnMap(mapCtx, feature, colorForCountry(country), "rgba(255,255,255,0.42)");
    if (country) {
      const hitNumber = hitCountryByColor.size + 1;
      const r = hitNumber & 255;
      const g = (hitNumber >> 8) & 255;
      const b = (hitNumber >> 16) & 255;
      const key = `${r},${g},${b}`;
      hitCountryByColor.set(key, country);
      drawFeatureOnMap(hitCtx, feature, `rgb(${r},${g},${b})`, null);
    }
  });

  mapPixels = mapCtx.getImageData(0, 0, mapWidth, mapHeight).data;
  hitPixels = hitCtx.getImageData(0, 0, mapWidth, mapHeight).data;
  state.dirty = true;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

function normalizeLon(lon) {
  let result = lon;
  while (result > 180) result -= 360;
  while (result < -180) result += 360;
  return result;
}

function project(lon, lat) {
  const lambda = toRadians(lon - state.centerLon);
  const phi = toRadians(lat);
  const phi0 = toRadians(state.centerLat);
  const cosPhi = Math.cos(phi);
  const x = globe.x + globe.r * cosPhi * Math.sin(lambda);
  const y = globe.y - globe.r * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * cosPhi * Math.cos(lambda));
  const z = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * cosPhi * Math.cos(lambda);
  return { x, y, z };
}

function screenToLonLat(x, y) {
  const nx = (x - globe.x) / globe.r;
  const ny = -(y - globe.y) / globe.r;
  const rr = nx * nx + ny * ny;
  if (rr > 1) return null;

  const nz = Math.sqrt(1 - rr);
  const phi0 = toRadians(state.centerLat);
  const lambda0 = toRadians(state.centerLon);
  const cosPhi0 = Math.cos(phi0);
  const sinPhi0 = Math.sin(phi0);

  const xWorld = nx * Math.cos(lambda0) + (nz * cosPhi0 - ny * sinPhi0) * Math.sin(lambda0);
  const yWorld = ny * cosPhi0 + nz * sinPhi0;
  const zWorld = -nx * Math.sin(lambda0) + (nz * cosPhi0 - ny * sinPhi0) * Math.cos(lambda0);

  return {
    lon: normalizeLon(toDegrees(Math.atan2(xWorld, zWorld))),
    lat: toDegrees(Math.asin(clamp(yWorld, -1, 1))),
  };
}

function colorAtLonLat(lon, lat) {
  const x = Math.floor(((normalizeLon(lon) + 180) / 360) * (mapWidth - 1));
  const y = Math.floor(((90 - clamp(lat, -90, 90)) / 180) * (mapHeight - 1));
  const index = (y * mapWidth + x) * 4;
  return {
    r: mapPixels[index],
    g: mapPixels[index + 1],
    b: mapPixels[index + 2],
    a: mapPixels[index + 3],
  };
}

function hitCountryAtLonLat(lon, lat) {
  if (!hitPixels) return null;

  const x = Math.floor(((normalizeLon(lon) + 180) / 360) * (mapWidth - 1));
  const y = Math.floor(((90 - clamp(lat, -90, 90)) / 180) * (mapHeight - 1));
  const index = (y * mapWidth + x) * 4;
  const alpha = hitPixels[index + 3];
  if (!alpha) return null;

  const key = `${hitPixels[index]},${hitPixels[index + 1]},${hitPixels[index + 2]}`;
  return hitCountryByColor.get(key) || null;
}

function shadeColor(color, nx, ny, nz) {
  const light = clamp(0.48 + nz * 0.42 - nx * 0.08 - ny * 0.03, 0.34, 1.05);
  const edge = clamp(1 - nz, 0, 1);
  return {
    r: Math.round(color.r * light + 48 * edge),
    g: Math.round(color.g * light + 70 * edge),
    b: Math.round(color.b * light + 96 * edge),
  };
}

function drawBackground(time) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#030406";
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 140; i += 1) {
    const x = (i * 283 + time * 0.008) % width;
    const y = (i * 167 + Math.sin(time * 0.001 + i) * 20 + height) % height;
    const alpha = 0.14 + (i % 5) * 0.045;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fillRect(x, y, i % 9 === 0 ? 2 : 1, i % 9 === 0 ? 2 : 1);
  }
}

function drawGlobeRaster() {
  const size = Math.ceil(globe.r * 2);
  if (globeBuffer.width !== size || globeBuffer.height !== size) {
    globeBuffer.width = size;
    globeBuffer.height = size;
    globeBufferCtx = globeBuffer.getContext("2d");
  }

  const image = globeBufferCtx.createImageData(size, size);
  const pixels = image.data;
  const phi0 = toRadians(state.centerLat);
  const lambda0 = toRadians(state.centerLon);
  const cosPhi0 = Math.cos(phi0);
  const sinPhi0 = Math.sin(phi0);
  const cosLambda0 = Math.cos(lambda0);
  const sinLambda0 = Math.sin(lambda0);

  for (let py = 0; py < size; py += 1) {
    const ny = -((py - globe.r) / globe.r);
    for (let px = 0; px < size; px += 1) {
      const nx = (px - globe.r) / globe.r;
      const rr = nx * nx + ny * ny;
      const index = (py * size + px) * 4;
      if (rr > 1) {
        pixels[index + 3] = 0;
        continue;
      }

      const nz = Math.sqrt(1 - rr);
      const xWorld = nx * cosLambda0 + (nz * cosPhi0 - ny * sinPhi0) * sinLambda0;
      const yWorld = ny * cosPhi0 + nz * sinPhi0;
      const zWorld = -nx * sinLambda0 + (nz * cosPhi0 - ny * sinPhi0) * cosLambda0;
      const lon = normalizeLon(toDegrees(Math.atan2(xWorld, zWorld)));
      const lat = toDegrees(Math.asin(clamp(yWorld, -1, 1)));
      const sampled = colorAtLonLat(lon, lat);
      const base = sampled.a > 0 ? sampled : { r: 12, g: 20, b: 31 };
      const shaded = shadeColor(base, nx, ny, nz);

      pixels[index] = shaded.r;
      pixels[index + 1] = shaded.g;
      pixels[index + 2] = shaded.b;
      pixels[index + 3] = 255;
    }
  }

  globeBufferCtx.putImageData(image, 0, 0);
  ctx.drawImage(globeBuffer, globe.x - globe.r, globe.y - globe.r);
}

function drawLine(points, style, widthValue) {
  ctx.beginPath();
  let started = false;
  points.forEach((point) => {
    const p = project(point.lon, point.lat);
    if (p.z <= 0) {
      started = false;
      return;
    }
    if (!started) {
      ctx.moveTo(p.x, p.y);
      started = true;
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.strokeStyle = style;
  ctx.lineWidth = widthValue;
  ctx.stroke();
}

function drawGraticule() {
  ctx.save();
  ctx.beginPath();
  ctx.arc(globe.x, globe.y, globe.r, 0, Math.PI * 2);
  ctx.clip();

  for (let lat = -60; lat <= 60; lat += 30) {
    const points = [];
    for (let lon = -180; lon <= 180; lon += 3) points.push({ lon, lat });
    drawLine(points, "rgba(255,255,255,0.12)", 0.8 * dpr);
  }

  for (let lon = -180; lon < 180; lon += 30) {
    const points = [];
    for (let lat = -85; lat <= 85; lat += 3) points.push({ lon, lat });
    drawLine(points, "rgba(255,255,255,0.1)", 0.8 * dpr);
  }

  ctx.restore();
}

function eachFeatureRing(feature, callback) {
  if (feature.geometry.type === "Polygon") {
    feature.geometry.coordinates.forEach(callback);
  } else {
    feature.geometry.coordinates.forEach((polygon) => polygon.forEach(callback));
  }
}

function drawFeatureOutline(feature, color, widthValue) {
  if (!feature) return;

  ctx.save();
  ctx.beginPath();
  ctx.arc(globe.x, globe.y, globe.r, 0, Math.PI * 2);
  ctx.clip();
  eachFeatureRing(feature, (ring) => {
    ctx.beginPath();
    let started = false;
    ring.forEach(([lon, lat]) => {
      const p = project(lon, lat);
      if (p.z <= 0) {
        started = false;
        return;
      }
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = widthValue;
    ctx.stroke();
  });
  ctx.restore();
}

function drawSelectedOutlines() {
  GEO.features.forEach((feature) => {
    const country = countryForMapIso(feature.id);
    if (country?.iso3 === state.selectedIso) {
      drawFeatureOutline(feature, "rgba(255,255,255,0.95)", 2.1 * dpr);
      drawFeatureOutline(feature, "rgba(255,74,61,0.95)", 0.9 * dpr);
    }
  });
}

function markerCountries() {
  return DATA.countries.filter((country) => !featuresByIso.has(country.iso3) && Array.isArray(country.latlng));
}

function drawMarkers() {
  markerCountries().forEach((country) => {
    const p = project(country.latlng[1], country.latlng[0]);
    if (p.z <= 0) return;

    ctx.beginPath();
    ctx.arc(p.x, p.y, (country.iso3 === state.selectedIso ? 5.4 : 4.2) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = colorForCountry(country);
    ctx.fill();
    ctx.strokeStyle = country.iso3 === state.selectedIso ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.78)";
    ctx.lineWidth = (country.iso3 === state.selectedIso ? 1.8 : 1.1) * dpr;
    ctx.stroke();
  });
}

function drawAtmosphere() {
  const gradient = ctx.createRadialGradient(
    globe.x - globe.r * 0.2,
    globe.y - globe.r * 0.25,
    globe.r * 0.2,
    globe.x,
    globe.y,
    globe.r * 1.12,
  );
  gradient.addColorStop(0, "rgba(255,255,255,0.12)");
  gradient.addColorStop(0.72, "rgba(255,255,255,0.02)");
  gradient.addColorStop(1, "rgba(93,150,255,0.28)");
  ctx.beginPath();
  ctx.arc(globe.x, globe.y, globe.r * 1.02, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(179,209,255,0.32)";
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
  ctx.fillStyle = gradient;
  ctx.fill();
}

function render(time = performance.now()) {
  const delta = time - lastFrame;
  lastFrame = time;

  if (state.autoSpin && !state.dragging) {
    state.centerLon = normalizeLon(state.centerLon + delta * 0.004);
    state.dirty = true;
  }

  if (state.dirty) {
    drawBackground(time);
    drawGlobeRaster();
    drawGraticule();
    drawMarkers();
    drawSelectedOutlines();
    drawAtmosphere();
    state.dirty = false;
  }

  requestAnimationFrame(render);
}

function detailRows(country) {
  return [
    ["Ország", country.name],
    ["Hadászati/katonai kiadás, 2024 (m USD)", country.display.military],
    ["Csak védelmi kiadás / budget (m USD)", country.display.defense],
    ["1 főre jutó katonai kiadás (USD/fő)", country.display.perCapita],
    ["Fenyegetés (0-10)", country.display.threat],
  ];
}

function renderDetails(country) {
  countryTitle.textContent = country.name;
  analysisTitle.textContent = country.name;
  analysisText.textContent = country.display.analysis;
  countryDetails.replaceChildren();

  detailRows(country).forEach(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    row.className = "detail-row";
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    countryDetails.appendChild(row);
  });
}

function selectCountry(iso3) {
  const country = countriesByIso.get(iso3);
  if (!country) return;

  state.selectedIso = iso3;
  renderDetails(country);
  state.dirty = true;
}

function selectCountryBySearch(value) {
  const normalized = value.trim().toLocaleLowerCase("hu");
  if (!normalized) return;

  const exact = countriesByName.get(normalized);
  if (exact) {
    selectCountry(exact.iso3);
    focusCountry(exact);
    return;
  }

  const partial = DATA.countries.find((country) => country.name.toLocaleLowerCase("hu").includes(normalized));
  if (partial) {
    selectCountry(partial.iso3);
    focusCountry(partial);
  }
}

function focusCountry(country) {
  if (!Array.isArray(country.latlng)) return;
  state.centerLon = country.latlng[1];
  state.centerLat = clamp(country.latlng[0], -55, 70);
  state.dirty = true;
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const rect = canvas.getBoundingClientRect();
  width = Math.max(1, Math.round(rect.width * dpr));
  height = Math.max(1, Math.round(rect.height * dpr));
  canvas.width = width;
  canvas.height = height;

  const desktop = rect.width > 1080;
  globe = {
    x: (desktop ? rect.width * 0.43 : rect.width * 0.5) * dpr,
    y: (desktop ? rect.height * 0.64 : 540) * dpr,
    r:
      Math.min(rect.width * (desktop ? 0.235 : 0.43), rect.height * (desktop ? 0.35 : 0.28)) *
      dpr *
      state.zoom,
  };

  state.dirty = true;
}

function setGlobeZoom(nextZoom) {
  const previousZoom = state.zoom;
  state.zoom = clamp(nextZoom, 0.72, 1.55);
  if (state.zoom !== previousZoom) {
    resize();
    state.dirty = true;
  }
}

function countryAtScreenPoint(x, y) {
  const lonLat = screenToLonLat(x, y);
  if (!lonLat) return null;
  return hitCountryAtLonLat(lonLat.lon, lonLat.lat);
}

function pickMarker(x, y, radiusPx = 6.8 * dpr) {
  let picked = null;
  let bestDistance = Infinity;
  markerCountries().forEach((country) => {
    const p = project(country.latlng[1], country.latlng[0]);
    if (p.z <= 0) return;
    const distance = Math.hypot(x - p.x, y - p.y);
    if (distance < radiusPx && distance < bestDistance) {
      bestDistance = distance;
      picked = country;
    }
  });
  return picked;
}

function addCountryScore(scores, country, distance, weight) {
  if (!country) return;
  const current = scores.get(country.iso3) || { country, score: 0, count: 0, minDistance: Infinity };
  current.score += weight;
  current.count += 1;
  current.minDistance = Math.min(current.minDistance, distance);
  scores.set(country.iso3, current);
}

function pickCountryFromNeighborhood(x, y, radiusPx) {
  const directCountry = countryAtScreenPoint(x, y);
  if (directCountry) return directCountry;

  const scores = new Map();

  const rings = [
    { radius: radiusPx * 0.34, points: 8, weight: 1.35 },
    { radius: radiusPx * 0.66, points: 12, weight: 0.9 },
    { radius: radiusPx, points: 16, weight: 0.55 },
  ];

  rings.forEach((ring) => {
    for (let index = 0; index < ring.points; index += 1) {
      const angle = (Math.PI * 2 * index) / ring.points;
      const sampleX = x + Math.cos(angle) * ring.radius;
      const sampleY = y + Math.sin(angle) * ring.radius;
      const position = { x: sampleX, y: sampleY };
      if (!isOnGlobe(position)) continue;
      addCountryScore(scores, countryAtScreenPoint(sampleX, sampleY), ring.radius, ring.weight);
    }
  });

  if (!scores.size) return null;

  const best = [...scores.values()].sort(
    (a, b) => b.score - a.score || b.count - a.count || a.minDistance - b.minDistance,
  )[0];

  if (best.score >= 1.15 || best.count >= 3 || best.minDistance <= radiusPx * 0.42) return best.country;
  return null;
}

function pickCountry(x, y, options = {}) {
  if (!screenToLonLat(x, y)) return null;

  const touchMode = options.pointerType === "touch";
  const pickRadius = (options.radiusCss ?? (touchMode ? 18 : 7)) * dpr;
  const markerRadius = (touchMode ? 14 : 7) * dpr;
  const markerCountry = pickMarker(x, y, markerRadius);
  const polygonCountry = pickCountryFromNeighborhood(x, y, pickRadius);

  return polygonCountry || markerCountry;
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * dpr,
    y: (event.clientY - rect.top) * dpr,
  };
}

function isOnGlobe(position, edgePadding = 0) {
  return Math.hypot(position.x - globe.x, position.y - globe.y) <= globe.r + edgePadding * dpr;
}

function setCanvasCursor(position) {
  if (state.dragging) {
    canvas.style.cursor = "grabbing";
    return;
  }
  canvas.style.cursor = isOnGlobe(position, 6) ? "grab" : "default";
}

function preventTouchDefault(event) {
  if (event.pointerType === "touch" && event.cancelable) event.preventDefault();
}

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function firstTwoActivePointers() {
  const pointers = [...activePointers.values()];
  return [pointers[0], pointers[1]];
}

function startPinchGesture() {
  const [first, second] = firstTwoActivePointers();
  if (!first || !second) return;

  pinchStart = {
    distance: Math.max(pointerDistance(first, second), 1),
    zoom: state.zoom,
  };
  dragStart = null;
  state.dragging = true;
  state.moved = true;
}

function updatePinchGesture() {
  if (!pinchStart || activePointers.size < 2) return;

  const [first, second] = firstTwoActivePointers();
  const distance = Math.max(pointerDistance(first, second), 1);
  setGlobeZoom(pinchStart.zoom * (distance / pinchStart.distance));
}

function releasePointerCapture(event) {
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}

function continueSinglePointerAfterPinch() {
  const remaining = [...activePointers.values()][0];
  if (!remaining) return false;

  dragStart = {
    ...remaining,
    lon: state.centerLon,
    lat: state.centerLat,
  };
  pinchStart = null;
  state.dragging = true;
  state.moved = true;
  return true;
}

canvas.addEventListener("pointerdown", (event) => {
  const position = pointerPosition(event);
  const pointer = {
    ...position,
    pointerType: event.pointerType || "mouse",
  };
  if (!isOnGlobe(position, 6)) {
    if (!activePointers.size) {
      dragStart = null;
      pinchStart = null;
      state.dragging = false;
      state.moved = false;
    }
    setCanvasCursor(position);
    return;
  }

  preventTouchDefault(event);
  activePointers.set(event.pointerId, pointer);
  canvas.setPointerCapture(event.pointerId);

  if (activePointers.size >= 2) {
    startPinchGesture();
    setCanvasCursor(position);
    return;
  }

  dragStart = {
    ...pointer,
    lon: state.centerLon,
    lat: state.centerLat,
  };
  pinchStart = null;
  state.dragging = true;
  state.moved = false;
  setCanvasCursor(position);
});

canvas.addEventListener("pointermove", (event) => {
  const position = pointerPosition(event);
  const activePointer = activePointers.get(event.pointerId);
  if (activePointer) {
    activePointers.set(event.pointerId, {
      ...activePointer,
      ...position,
    });
  }

  if (activePointers.size >= 2) {
    preventTouchDefault(event);
    updatePinchGesture();
    setCanvasCursor(position);
    return;
  }

  if (!state.dragging || !dragStart) {
    setCanvasCursor(position);
    return;
  }

  const dx = position.x - dragStart.x;
  const dy = position.y - dragStart.y;
  const moveThreshold = (dragStart.pointerType === "touch" ? 10 : 4) * dpr;
  if (Math.hypot(dx, dy) <= moveThreshold) {
    setCanvasCursor(position);
    return;
  }
  state.moved = true;

  state.centerLon = normalizeLon(dragStart.lon - (dx / globe.r) * 76);
  state.centerLat = clamp(dragStart.lat + (dy / globe.r) * 76, -72, 72);
  state.dirty = true;
});

canvas.addEventListener("pointerup", (event) => {
  const position = pointerPosition(event);
  const activePointer = activePointers.get(event.pointerId);
  const pointerType = activePointer?.pointerType || event.pointerType || "mouse";
  const pointerWasActive = Boolean(activePointer);
  const pinchWasActive = activePointers.size >= 2 || Boolean(pinchStart);
  const wasDragging = state.dragging;
  activePointers.delete(event.pointerId);
  releasePointerCapture(event);

  if (activePointers.size >= 2) {
    startPinchGesture();
    setCanvasCursor(position);
    return;
  }

  if (activePointers.size === 1) {
    continueSinglePointerAfterPinch();
    setCanvasCursor(position);
    return;
  }

  state.dragging = false;

  if (pointerWasActive && wasDragging && !state.moved && !pinchWasActive && isOnGlobe(position, 6)) {
    const country = pickCountry(position.x, position.y, { pointerType });
    if (country) selectCountry(country.iso3);
  }
  dragStart = null;
  pinchStart = null;
  setCanvasCursor(position);
});

canvas.addEventListener("pointercancel", (event) => {
  activePointers.delete(event.pointerId);
  releasePointerCapture(event);
  if (activePointers.size >= 2) {
    startPinchGesture();
  } else if (activePointers.size === 1) {
    continueSinglePointerAfterPinch();
  } else {
    state.dragging = false;
    dragStart = null;
    pinchStart = null;
  }
  const position = pointerPosition(event);
  setCanvasCursor(position);
});

canvas.addEventListener(
  "wheel",
  (event) => {
    const position = pointerPosition(event);
    if (!isOnGlobe(position, 6)) return;

    event.preventDefault();
    setGlobeZoom(state.zoom * Math.exp(-event.deltaY * 0.0012));
  },
  { passive: false },
);

window.addEventListener(
  "keydown",
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setGlobeZoom(state.zoom * 1.16);
    }

    if (event.key === "-") {
      event.preventDefault();
      setGlobeZoom(state.zoom / 1.16);
    }

    if (event.key === "0") {
      event.preventDefault();
      setGlobeZoom(1);
    }
  },
  { capture: true },
);

metricSelect.addEventListener("change", (event) => {
  state.metric = event.target.value;
  metricTitle.textContent = METRICS[state.metric].label;
  buildMapTexture();
  renderLegend();
});

countrySearch.addEventListener("change", (event) => selectCountryBySearch(event.target.value));
countrySearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") selectCountryBySearch(event.currentTarget.value);
});

zoomInButton.addEventListener("click", () => {
  setGlobeZoom(state.zoom * 1.18);
});

zoomOutButton.addEventListener("click", () => {
  setGlobeZoom(state.zoom / 1.18);
});

resetButton.addEventListener("click", () => {
  state.centerLon = 18;
  state.centerLat = 16;
  setGlobeZoom(1);
  state.dirty = true;
});

spinButton.addEventListener("click", () => {
  state.autoSpin = !state.autoSpin;
  spinButton.classList.toggle("is-active", state.autoSpin);
  state.dirty = true;
});

window.addEventListener("resize", resize);

window.__globeDebug = {
  state,
  project,
  screenToLonLat,
  hitCountryAtLonLat,
  getGlobe: () => globe,
  selectCountry,
  pickCountry,
  pickCountryFromNeighborhood,
  pickMarker,
  countriesByIso,
};

resize();
buildMapTexture();
renderLegend();
renderDetails(countriesByIso.get(state.selectedIso));
requestAnimationFrame(render);
