// Builds <city>_arrets_map.json for the Arrêts - Bus game from an official GTFS feed + an OpenStreetMap basemap.
// Output format matches arrets_map.json / paris_arrets_map.json:
//   {W, H, mPerPx, roads:{major,primary,secondary,tertiary}, water:{fills,lines}, green, rail,
//    lines:[], stations:[], bus:[{ref,colour,d}], stops:[{n,x,y,l:[[ref,colour],...]}]}
//
// Usage:  node --use-system-ca build_bus_city.mjs vannes [--refresh]
// GTFS (Kicéo / GMVA, data.gouv.fr) is read from data/kiceo/gtfs/ ; Overpass answers are cached in osm_cache/.

import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CITIES = {
  vannes: {
    label: "Vannes",
    gtfs: "data/kiceo/gtfs",
    // urban network only: 1-12 (interurban 20-30, regional 6xx, renforts, on-demand lines and the evening-only
    // Terminéo "TRM" are left out: its shape re-draws other lines' roads and cluttered the P+R Ouest area)
    routes: ["1", "2", "3", "4", "5", "6a", "6b", "7", "8", "9", "10", "11", "12"],
    tertiary: true,
    minGreenArea: 120,
    // city-centre crop (Republique): stops and line shapes farther than radiusM are dropped, so the
    // far ends of 10 (Theix, Seine) and 11 (Plougoumelen, Ploeren) - and the tips of 9 and 4 - no longer stretch the map
    crop: { lat: 47.655968, lon: -2.759721, radiusM: 6000 },
  },
  nantes: {
    label: "Nantes",
    gtfs: "data/naolib/gtfs",
    // structuring lines only (the network has 100+ routes): tramways 1-3, busways 4-5, Chronobus C1-C9 and C20
    routes: ["1", "2", "3", "4", "5", "C1", "C2", "C3", "C4", "C6", "C7", "C8", "C9", "C20"],
    tertiary: true,
    minGreenArea: 150,
    crop: { lat: 47.2138, lon: -1.5563, radiusM: 8000 },   // Commerce
  },
};

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const W = 1400;
const PAD = 0.07;
const MIN_ASPECT = 1.1;
const MAX_ASPECT = 1.6;
const EPS = { roads: 0.9, water: 0.9, green: 1.1, rail: 0.9, bus: 0.6 };
const MIN_GREEN_AREA = 60;
const SHAPE_SHARE = 0.1;   // keep a shape variant if it carries >= 10% of the route's trips...
const SHAPE_MAX = 4;       // ...and at most 4 variants per route
const MERGE_M = 250;       // same-name stops closer than this are one stop

const root = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(root, "osm_cache");
const refresh = process.argv.includes("--refresh");

async function overpass(name, query) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, name + ".json");
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  for (let attempt = 1; attempt <= 6; attempt++) {
    const endpoint = OVERPASS[(attempt - 1) % OVERPASS.length];
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "reseaux-de-france-builder" },
      });
    } catch (err) { console.warn(`  overpass ${name}: ${err.message} (${endpoint})`); continue; }
    if (res.ok) {
      const txt = await res.text();
      fs.writeFileSync(file, txt);
      return JSON.parse(txt);
    }
    console.warn(`  overpass ${name}: HTTP ${res.status} (${endpoint}), retry ${attempt}/6`);
    await new Promise(r => setTimeout(r, 8000 * attempt));
  }
  throw new Error("Overpass failed for " + name);
}

// ---------- GTFS (small CSV reader: quoted fields, BOM, CRLF) ----------
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function readLines(file) {
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/);
}
function readCsv(file, keep) {
  const lines = readLines(file);
  const head = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const v = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < head.length; j++) row[head[j]] = v[j] ?? "";
    if (!keep || keep(row)) rows.push(row);
  }
  return rows;
}

// ---------- projection (same equirectangular scheme as build_metro_city.mjs / paris_geo_lib.ps1) ----------
function makeProjection(minLat, minLon, maxLat, maxLon) {
  const R = 6371000;
  const cLat = (minLat + maxLat) / 2, cLon = (minLon + maxLon) / 2;
  const cos = Math.cos(cLat * Math.PI / 180);
  let wM = (maxLon - minLon) * Math.PI / 180 * R * cos * (1 + PAD * 2);
  let hM = (maxLat - minLat) * Math.PI / 180 * R * (1 + PAD * 2);
  if (wM / hM < MIN_ASPECT) wM = hM * MIN_ASPECT;
  if (wM / hM > MAX_ASPECT) hM = wM / MAX_ASPECT;
  const mPerPx = wM / W;
  const H = Math.round(hM / mPerPx);
  const project = (lon, lat) => {
    const xm = (lon - cLon) * Math.PI / 180 * R * cos;
    const ym = (lat - cLat) * Math.PI / 180 * R;
    return [(xm + wM / 2) / mPerPx, (hM / 2 - ym) / mPerPx];
  };
  const halfLat = hM / 2 / R * 180 / Math.PI, halfLon = wM / 2 / (R * cos) * 180 / Math.PI;
  const bbox = [cLat - halfLat, cLon - halfLon, cLat + halfLat, cLon + halfLon];
  return { project, mPerPx, H, bbox };
}
const distM = (a, b) => {
  const k = Math.PI / 180, cos = Math.cos((a.lat + b.lat) / 2 * k);
  return Math.hypot((a.lat - b.lat) * k * 6371000, (a.lon - b.lon) * k * 6371000 * cos);
};

// ---------- geometry helpers ----------
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let dmax = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else { const t = ((px - ax) * dx + (py - ay) * dy) / len2; d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const r1 = n => Math.round(n * 10) / 10;
function toPath(pts, close) {
  if (pts.length < 2) return "";
  return "M" + pts.map(p => r1(p[0]) + " " + r1(p[1])).join("L") + (close ? "Z" : "");
}
function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}
function inView(pts, Wd, Hd, margin = 60) {
  return pts.some(([x, y]) => x > -margin && x < Wd + margin && y > -margin && y < Hd + margin);
}
function joinRings(ways) {
  const key = p => p[0].toFixed(7) + "," + p[1].toFixed(7);
  const pool = ways.filter(w => w.length > 1).map(w => w.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    let grew = true;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i], end = key(ring[ring.length - 1]);
        if (key(w[0]) === end) ring = ring.concat(w.slice(1));
        else if (key(w[w.length - 1]) === end) ring = ring.concat(w.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    rings.push(ring);
  }
  return rings;
}
const geomOf = el => (el.geometry || []).filter(Boolean).map(g => [g.lon, g.lat]);
function norm(name) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---------- build one city ----------
async function build(key) {
  const cfg = CITIES[key];
  console.log(`== ${cfg.label}`);
  const dir = path.join(root, cfg.gtfs);

  // 1) routes + their trips
  const wanted = new Set(cfg.routes);
  const routes = readCsv(path.join(dir, "routes.txt"), r => wanted.has(r.route_short_name));
  const missing = cfg.routes.filter(r => !routes.some(x => x.route_short_name === r));
  if (missing.length) throw new Error("routes not in GTFS: " + missing.join(", "));
  const routeById = new Map(routes.map(r => [r.route_id, {
    ref: r.route_short_name, colour: "#" + r.route_color.toUpperCase(), shapes: new Map(), stops: new Set(), trips: 0,
  }]));
  const trips = readCsv(path.join(dir, "trips.txt"), t => routeById.has(t.route_id));
  const tripRoute = new Map();
  for (const t of trips) {
    const R = routeById.get(t.route_id);
    tripRoute.set(t.trip_id, R);
    R.trips++;
    if (t.shape_id) R.shapes.set(t.shape_id, (R.shapes.get(t.shape_id) || 0) + 1);
  }

  // 2) stops served by each route
  // streamed: Naolib's stop_times.txt is ~450 MB, too big to hold as one string
  let iTrip = -1, iStop = -1;
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, "stop_times.txt"), "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (iTrip < 0) {
      const sh = parseCsvLine(line.replace(/^﻿/, ""));
      iTrip = sh.indexOf("trip_id"); iStop = sh.indexOf("stop_id");
      continue;
    }
    const v = parseCsvLine(line);
    const R = tripRoute.get(v[iTrip]);
    if (R) R.stops.add(v[iStop]);
  }
  const allStops = readCsv(path.join(dir, "stops.txt"));
  const stopById = new Map(allStops.map(s => [s.stop_id, s]));

  // each platform -> its parent station when there is one
  const unit = id => {
    const s = stopById.get(id);
    if (!s) return null;
    const p = s.parent_station && stopById.get(s.parent_station);
    return p || s;
  };
  const inCrop = (lat, lon) => !cfg.crop || distM(cfg.crop, { lat, lon }) <= cfg.crop.radiusM;
  const stopsRaw = [];   // {id, name, lat, lon, ref, colour}
  for (const R of routeById.values()) {
    const seen = new Set();
    for (const id of R.stops) {
      const u = unit(id);
      if (!u || seen.has(u.stop_id) || !inCrop(+u.stop_lat, +u.stop_lon)) continue;
      seen.add(u.stop_id);
      stopsRaw.push({ id: u.stop_id, name: u.stop_name.trim(), lat: +u.stop_lat, lon: +u.stop_lon, ref: R.ref, colour: R.colour });
    }
  }

  // 3) shapes of the retained variants
  const keepShapes = new Map();   // shape_id -> route
  for (const R of routeById.values()) {
    const sorted = [...R.shapes.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted[0] ? sorted[0][1] : 0;
    sorted.filter(([, n]) => n >= top * SHAPE_SHARE).slice(0, SHAPE_MAX).forEach(([sid]) => keepShapes.set(sid, R));
  }
  const shapePts = new Map();
  const shapeLines = readLines(path.join(dir, "shapes.txt"));
  const hh = parseCsvLine(shapeLines[0]);
  const iS = hh.indexOf("shape_id"), iLa = hh.indexOf("shape_pt_lat"), iLo = hh.indexOf("shape_pt_lon"), iSq = hh.indexOf("shape_pt_sequence");
  for (let i = 1; i < shapeLines.length; i++) {
    const l = shapeLines[i];
    if (!l) continue;
    const v = parseCsvLine(l);
    if (!keepShapes.has(v[iS])) continue;
    if (!shapePts.has(v[iS])) shapePts.set(v[iS], []);
    shapePts.get(v[iS]).push([+v[iSq], +v[iLo], +v[iLa]]);
  }

  // 4) extent -> projection
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  const grow = (lat, lon) => { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); };
  for (const s of stopsRaw) grow(s.lat, s.lon);
  // with a crop the frame follows the retained stops only (shapes are clipped to the crop circle below)
  if (!cfg.crop) for (const pts of shapePts.values()) for (const [, lon, lat] of pts) grow(lat, lon);
  const P = makeProjection(minLat, minLon, maxLat, maxLon);

  // 5) stops: same normalised name within MERGE_M = one stop, lines merged
  const clusters = [];
  for (const s of stopsRaw) {
    const k = norm(s.name);
    let c = clusters.find(c => c.key === k && distM(c, s) < MERGE_M);
    if (!c) { c = { key: k, names: new Map(), lat: 0, lon: 0, n: 0, ids: new Set(), lines: new Map() }; clusters.push(c); }
    if (!c.ids.has(s.id)) { c.ids.add(s.id); c.lat = (c.lat * c.n + s.lat) / (c.n + 1); c.lon = (c.lon * c.n + s.lon) / (c.n + 1); c.n++; }
    c.names.set(s.name, (c.names.get(s.name) || 0) + 1);
    c.lines.set(s.ref, s.colour);
  }
  const refOrder = routes.map(r => r.route_short_name);   // routes.txt order = network order
  const stops = clusters.map(c => {
    const [x, y] = P.project(c.lon, c.lat);
    const name = [...c.names.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    return { n: name, x: r1(x), y: r1(y), l: refOrder.filter(r => c.lines.has(r)).map(r => [r, c.lines.get(r)]) };
  }).sort((a, b) => a.n.localeCompare(b.n, "fr"));

  // 6) bus lines: union of the retained shape variants
  const bus = refOrder.map(ref => {
    const R = [...routeById.values()].find(r => r.ref === ref);
    // a shape leaving the crop circle is cut into runs, so no chord is drawn across the gap
    const runs = pts => {
      if (!cfg.crop) return [pts];
      const out = []; let cur = [];
      for (const p of pts) {
        if (inCrop(p[2], p[1])) cur.push(p);
        else { if (cur.length) out.push(cur); cur = []; }
      }
      if (cur.length) out.push(cur);
      return out;
    };
    const d = [...keepShapes.entries()].filter(([, r]) => r === R)
      .flatMap(([sid]) => runs((shapePts.get(sid) || []).sort((a, b) => a[0] - b[0]))
        .map(run => toPath(simplify(run.map(([, lon, lat]) => P.project(lon, lat)), EPS.bus))))
      .join("");
    return { ref, colour: R.colour, d };
  });

  // 7) basemap inside the final map box
  const [bs, bw, bn, be] = P.bbox.map(v => +v.toFixed(5));
  const base = await overpass(`${key}_bus_basemap`, `[out:json][timeout:240][bbox:${bs},${bw},${bn},${be}];
(
  way[highway~"^(motorway|trunk|primary|secondary|tertiary)$"];
  way[railway=rail][!service];
  way[natural=water]; relation[natural=water][type=multipolygon];
  way[waterway=riverbank]; relation[waterway=riverbank][type=multipolygon];
  way[waterway~"^(river|canal)$"];
  way[leisure~"^(park|garden|nature_reserve)$"]; relation[leisure=park][type=multipolygon];
  way[landuse~"^(forest|grass|recreation_ground|meadow|cemetery|allotments|village_green)$"];
  way[natural=wood]; relation[landuse=forest][type=multipolygon]; relation[natural=wood][type=multipolygon];
);
out geom;`);

  const proj = pts => pts.map(([lon, lat]) => P.project(lon, lat));
  const roads = { major: [], primary: [], secondary: [], tertiary: [] };
  const rail = [], waterLines = [], waterFills = [], green = [];
  const pushArea = (target, rings, eps, minArea) => {
    for (const ring of rings) {
      if (ring.length < 4) continue;
      const pts = proj(ring);
      if (!inView(pts, W, P.H) || area(pts) < minArea) continue;
      target.push(toPath(simplify(pts, eps), true));
    }
  };
  for (const el of base.elements) {
    const t = el.tags || {};
    if (el.type === "way") {
      const g = geomOf(el);
      if (g.length < 2) continue;
      const pts = proj(g);
      if (!inView(pts, W, P.H)) continue;
      const closed = g.length > 3 && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1];
      const cls = t.highway && (/^(motorway|trunk)$/.test(t.highway) ? "major" : t.highway);
      if (cls && roads[cls] && !(cls === "tertiary" && cfg.tertiary === false)) {
        roads[cls].push(toPath(simplify(pts, EPS.roads)));
      } else if (t.railway === "rail") rail.push(toPath(simplify(pts, EPS.rail)));
      else if (t.waterway === "river" || t.waterway === "canal") waterLines.push(toPath(simplify(pts, EPS.water)));
      else if (closed && (t.natural === "water" || t.waterway === "riverbank")) pushArea(waterFills, [g], EPS.water, 4);
      else if (t.highway) continue;
      else if (closed) pushArea(green, [g], EPS.green, cfg.minGreenArea || MIN_GREEN_AREA);
    } else if (el.type === "relation") {
      const outers = (el.members || []).filter(m => m.type === "way" && m.role !== "inner").map(geomOf);
      const rings = joinRings(outers);
      if (t.natural === "water" || t.waterway === "riverbank") pushArea(waterFills, rings, EPS.water, 4);
      else pushArea(green, rings, EPS.green, cfg.minGreenArea || MIN_GREEN_AREA);
    }
  }

  const out = {
    W, H: P.H, mPerPx: +P.mPerPx.toFixed(4),
    roads: { major: roads.major.join(""), primary: roads.primary.join(""), secondary: roads.secondary.join(""), tertiary: roads.tertiary.join("") },
    water: { fills: waterFills.join(""), lines: waterLines.join("") },
    green: green.join(""),
    rail: rail.join(""),
    lines: [],
    stations: [],
    bus,
    stops,
  };
  const file = path.join(root, `${key}_arrets_map.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`  ${W}x${P.H} · ${Math.round(P.mPerPx * 10) / 10} m/px · ${bus.length} lignes · ${stops.length} arrêts · ${Math.round(fs.statSync(file).size / 1024)} Ko`);
  return out;
}

const which = process.argv[2] || "vannes";
if (!CITIES[which]) { console.error("unknown city " + which); process.exit(1); }
await build(which);
