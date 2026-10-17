// Builds facilities/osm.v1.json and facilities/wikipedia.v1.json, the station facilities RuteKita shows.
//   node scripts/build-facilities.mjs --stations ../rutekita/assets/data/krl.json [--cache DIR]
// --cache keeps the raw Overpass and Wikipedia answers in DIR and reuses them, so a run can be repeated
// on exactly the same input. Only what the sources say is written; nothing is filled in by hand.
//
// The two files stay separate because their licences cannot be merged into one database:
//   osm.v1.json        OpenStreetMap, ODbL 1.0     exits, lifts, escalators, toilets, musholla, parking, pick-up points
//   wikipedia.v1.json  Wikipedia, CC BY-SA 4.0     the facility list in each station article's infobox

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const stationsPath = arg('--stations');
const cacheDir = arg('--cache');
if (!stationsPath) {
  console.error('usage: node scripts/build-facilities.mjs --stations <krl.json> [--cache DIR]');
  process.exit(2);
}

const USER_AGENT = 'rutekita-data/1 (https://github.com/juansah27/rutekita-data)';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const BBOX = '(-6.75,106.1,-5.95,107.25)';
const today = new Date().toISOString().slice(0, 10);
const stations = JSON.parse(await readFile(stationsPath, 'utf8')).stations;

async function cached(name, fetcher) {
  if (cacheDir) {
    try {
      return JSON.parse(await readFile(join(cacheDir, name), 'utf8'));
    } catch {
      // not cached yet
    }
  }
  const value = await fetcher();
  if (cacheDir) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, name), JSON.stringify(value));
  }
  return value;
}

// Public Overpass servers are often busy; try each a few times before giving up.
async function overpass(query) {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(300_000),
        });
        const text = await res.text();
        if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);
        console.warn(`overpass ${url}: HTTP ${res.status}`);
      } catch (e) {
        console.warn(`overpass ${url}: ${e.name}`);
      }
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  throw new Error('every Overpass server failed');
}

// ------------------------------------------------------------------ OpenStreetMap

const STATIONS_SET = `nwr[railway~"^(station|halt)$"][train!=no]${BBOX}->.st;`;
const features = await cached('osm-features.json', () =>
  overpass(`[out:json][timeout:240];${STATIONS_SET}
(
  .st;
  nwr(around.st:400)[railway=train_station_entrance];
  node(around.st:400)[entrance];
  nwr(around.st:400)[highway=elevator];
  way(around.st:400)[highway][conveying];
  nwr(around.st:400)[amenity=toilets];
  nwr(around.st:400)[amenity=place_of_worship][religion=muslim];
  nwr(around.st:400)[amenity~"^(parking|motorcycle_parking|taxi|taxi_point|motorcycle_taxi)$"];
  nwr(around.st:400)[name~"ojol|ojek|gojek|grab|maxim",i];
);
out tags center;`),
);
const areas = await cached('osm-areas.json', () =>
  overpass(`[out:json][timeout:240];${STATIONS_SET}
(
  way(around.st:200)[~"^(railway|public_transport|building)$"~"^(station|train_station)$"];
  relation(around.st:200)[public_transport=station];
);
out tags geom;`),
);

const RAD = Math.PI / 180;
/** Metres east and north of `origin`; fine at station scale. */
const local = (p, origin) => [
  (p.lon - origin.lon) * RAD * Math.cos(origin.lat * RAD) * 6371000,
  (p.lat - origin.lat) * RAD * 6371000,
];
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const ringDistance = (p, ring) =>
  insideRing(p, ring) ? 0 : Math.min(...ring.slice(1).map((b, i) => segmentDistance(p, ring[i], b)));

// Station outlines: closed ways, or the outer ways of a station relation.
const outlines = [];
for (const e of areas.elements) {
  const ways = e.type === 'way' ? [e.geometry] : (e.members ?? []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => m.geometry);
  for (const g of ways) {
    if (g && g.length > 3 && g[0].lat === g.at(-1).lat && g[0].lon === g.at(-1).lon) outlines.push(g);
  }
}

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const STATION_WORD = /\b(stasiun|statiun|sta\.|st\.|station)\s/;
/**
 * The station a feature's own name points at ("Shelter Ojek Online Sta. Depok Baru"), or null. The
 * longest matching station name wins, so a Depok Baru shelter is not also given to Depok.
 */
function stationNamed(tags) {
  const name = fold(tags.name ?? '');
  if (!STATION_WORD.test(name + ' ')) return null;
  let best = null;
  for (const s of stations) {
    const n = fold(s.name);
    if (new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(name) && (!best || n.length > fold(best.name).length)) best = s;
  }
  return best?.code ?? null;
}

const NOT_PUBLIC = new Set(['private', 'no']);
const NON_RIDER_ENTRANCES = new Set(['service', 'emergency', 'staff', 'garage', 'no', 'fire_exit']);
const isMrt = (t) => /mrt|lrt/i.test(t.operator ?? '') || /mrt|lrt/i.test(t.network ?? '');
const PICKUP_WORDS = /\b(ojol|ojek|gojek|goride|grab|maxim)\b/i;

/** Which facility list a feature goes in, or null when it is none of ours. */
function kind(t) {
  if (NOT_PUBLIC.has(t.access) || isMrt(t)) return null;
  if (t.railway === 'station' || t.railway === 'halt') return null;
  if (t.railway === 'train_station_entrance' || t.entrance) return NON_RIDER_ENTRANCES.has(t.entrance) ? null : 'exits';
  if (t.highway === 'elevator') return 'lifts';
  if (t.conveying && t.conveying !== 'no') return 'escalators';
  if (t.amenity === 'toilets') return 'toilets';
  if (t.amenity === 'place_of_worship') return 'musholla';
  if (t.amenity === 'motorcycle_parking') return 'parkingMotor';
  if (t.amenity === 'parking') return t.motorcar === 'no' ? (['yes', 'designated'].includes(t.motorcycle) ? 'parkingMotor' : null) : 'parkingCar';
  if (/^(taxi|taxi_point|motorcycle_taxi)$/.test(t.amenity ?? '')) return 'pickup';
  if (PICKUP_WORDS.test(t.name ?? '') && !t.shop && !t.amenity) return 'pickup';
  return null;
}

const ref = (e) => `${e.type}/${e.id}`;
const position = (e) => e.center ?? { lat: e.lat, lon: e.lon };
/** A feature belongs to a station when it is on or within this many metres of the station outline. */
const OUTLINE_MARGIN = 15;
const osmStations = {};
const counts = {};
for (const s of stations) {
  const mine = outlines.map((g) => g.map((p) => local(p, s))).filter((ring) => ringDistance([0, 0], ring) < 40);
  const entry = {};
  for (const e of features.elements) {
    const t = e.tags ?? {};
    const pos = position(e);
    if (pos.lat === undefined) continue;
    const p = local(pos, s);
    if (Math.hypot(...p) > 400) continue;

    // The station's own tags: step-free access as OSM records it.
    if ((t.railway === 'station' || t.railway === 'halt') && !['subway', 'light_rail', 'monorail'].includes(t.station)) {
      const sameName = fold(t.name ?? '').includes(fold(s.name));
      if (sameName && Math.hypot(...p) < 300 && ['yes', 'limited', 'no'].includes(t.wheelchair)) entry.wheelchair = { value: t.wheelchair, osm: ref(e) };
      if (sameName && Math.hypot(...p) < 300 && t.toilets === 'yes') (entry.toilets ??= []).push({ osm: ref(e) });
      continue;
    }

    const k = kind(t);
    if (!k) continue;
    const named = stationNamed(t);
    if (named ? named !== s.code : !mine.some((ring) => ringDistance(p, ring) <= OUTLINE_MARGIN)) continue;

    const item = { osm: ref(e) };
    if (k === 'exits' || k === 'pickup') {
      if (t.name) item.name = t.name;
      if (t.ref) item.ref = t.ref;
    }
    if (k === 'exits') {
      if (t['addr:street']) item.street = t['addr:street'];
      if (['yes', 'limited', 'no'].includes(t.wheelchair)) item.wheelchair = t.wheelchair;
    }
    (entry[k] ??= []).push(item);
  }
  for (const list of Object.values(entry)) if (Array.isArray(list)) list.sort((a, b) => a.osm.localeCompare(b.osm));
  if (Object.keys(entry).length) {
    osmStations[s.code] = entry;
    for (const k of Object.keys(entry)) counts[k] = (counts[k] ?? 0) + 1;
  }
}

const osmOut = {
  version: 1,
  updatedAt: today,
  osmTimestamp: features.osm3s?.timestamp_osm_base ?? null,
  source: {
    name: 'OpenStreetMap',
    attribution: '© OpenStreetMap contributors',
    licence: 'ODbL-1.0',
    licenceUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    page: 'https://www.openstreetmap.org/copyright',
  },
  stations: osmStations,
};

// ------------------------------------------------------------------ Wikipedia

// The station's facility icons in the article's infobox ({{Infobox stasiun/fasilitas|lift}}), mapped to
// the facilities RuteKita shows. Icons for anything else (ATMs, wifi, kiosks...) are not used.
const WIKI_FACILITIES = {
  toilet: 'toilet',
  toliet: 'toilet',
  musala: 'musholla',
  mushola: 'musholla',
  musholla: 'musholla',
  lift: 'lift',
  eskalator: 'escalator',
  difabel: 'accessible',
  disabilitas: 'accessible',
  parkir: 'parking',
  gedungparkir: 'parking',
  dropzone: 'dropoff',
};
// Articles whose infobox gives a different station code than the KCI timetable RuteKita uses.
const WIKI_CODE_ALIASES = { THI: ['TTI'] };

const pages = await cached('wikipedia.json', async () => {
  const out = {};
  const titles = stations.map((s) => `Stasiun ${s.name}`);
  for (let i = 0; i < titles.length; i += 40) {
    const url =
      'https://id.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content|ids&rvslots=main&redirects=1&format=json&formatversion=2&titles=' +
      encodeURIComponent(titles.slice(i, i + 40).join('|'));
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    const j = await res.json();
    const back = new Map();
    for (const r of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) back.set(r.to, back.get(r.from) ?? r.from);
    for (const p of j.query.pages) {
      if (p.missing) continue;
      out[back.get(p.title) ?? p.title] = { title: p.title, revision: p.revisions[0].revid, text: p.revisions[0].slots.main.content };
    }
  }
  return out;
});

const wikiStations = {};
for (const s of stations) {
  const page = pages[`Stasiun ${s.name}`];
  if (!page) continue;
  // Only the right article: its infobox must carry this station's code.
  const code = page.text.match(/\|\s*(?:code|kode)\s*=\s*([^\n|]*)/i)?.[1] ?? '';
  if (![s.code, ...(WIKI_CODE_ALIASES[s.code] ?? [])].some((c) => new RegExp(`\\b${c}\\b`).test(code))) {
    console.warn(`wikipedia: ${page.title} has code "${code.trim()}", not ${s.code}; skipped`);
    continue;
  }
  const field = page.text.match(/\|\s*fasilitas\s*=([\s\S]*?)(?=\n\s*\||\n\s*\}\})/i)?.[1] ?? '';
  const facilities = [
    ...new Set(
      [...field.matchAll(/\{\{\s*infobox stasiun\/fasilitas\s*\|\s*([^}|]+)/gi)]
        .map((m) => WIKI_FACILITIES[m[1].trim().toLowerCase()])
        .filter(Boolean),
    ),
  ].sort();
  if (facilities.length) wikiStations[s.code] = { article: page.title, revision: page.revision, facilities };
}

const wikiOut = {
  version: 1,
  updatedAt: today,
  source: {
    name: 'Wikipedia bahasa Indonesia',
    attribution: 'Kontributor Wikipedia',
    licence: 'CC BY-SA 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/deed.id',
    page: 'https://id.wikipedia.org/',
  },
  stations: wikiStations,
};

const root = new URL('../facilities/', import.meta.url);
await mkdir(root, { recursive: true });
await writeFile(new URL('osm.v1.json', root), JSON.stringify(osmOut, null, 1) + '\n');
await writeFile(new URL('wikipedia.v1.json', root), JSON.stringify(wikiOut, null, 1) + '\n');

const wikiCounts = {};
for (const e of Object.values(wikiStations)) for (const f of e.facilities) wikiCounts[f] = (wikiCounts[f] ?? 0) + 1;
console.log(`OSM: ${Object.keys(osmStations).length}/${stations.length} stations`, counts);
console.log(`Wikipedia: ${Object.keys(wikiStations).length}/${stations.length} stations`, wikiCounts);
