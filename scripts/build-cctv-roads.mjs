// Adds the road cameras to cctv/v1.json: toll-road cameras listed by BPJT Kementerian PU and the
// Pemprov Banten cameras, inside Jabodetabek.
//   node scripts/build-cctv-roads.mjs --stations ../rutekita/assets/data/krl.json,../rutekita/assets/data/rail.json
// Every camera of the sources built here is replaced; the hand-picked station cameras are kept.
// Only cameras whose stream answers with a playlist right now are written, so run it again later
// to pick up cameras that were offline.
//
// A road camera has `kind: "road"`, an `area` (the toll road or region it watches), `lat`/`lon`, and
// a `station` only when it stands within NEAR_M of one. Apps older than road cameras skip them.

import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const stationsArg = args.includes('--stations') ? args[args.indexOf('--stations') + 1] : null;
if (!stationsArg) {
  console.error('usage: node scripts/build-cctv-roads.mjs --stations <krl.json>[,<rail.json>]');
  process.exit(2);
}

const CATALOG = new URL('../cctv/v1.json', import.meta.url);
const BPJT_PAGE = 'https://bpjt.pu.go.id/cctv/';
const BANTEN_PAGE = 'https://cctv.bantenprov.go.id';
// Some owners only answer CORS when the request names an origin, as a browser's does.
const WEB_ORIGIN = 'https://kaskitaserver.tail8f4ed4.ts.net';
const USER_AGENT = 'rutekita-data/1 (https://github.com/juansah27/rutekita-data)';
const NEAR_M = 400;
const inJabodetabek = (lat, lon) => lat >= -6.75 && lat <= -5.95 && lon >= 106.45 && lon <= 107.2;

// BPJT names each camera's operator (badan usaha jalan tol) by a short code. Each operator is its
// own source, credited as the camera's owner. A code missing here is reported and left out.
const TOLL_OPERATORS = {
  jm: 'PT Jasa Marga (Persero) Tbk',
  hk: 'PT Hutama Karya (Persero)',
  mms: 'PT Marga Mandalasakti',
  cw: 'PT Citra Waspphutowa',
  'PT Bintaro Serpong Damai': 'PT Bintaro Serpong Damai',
  TLKJ: 'PT Translingkar Kita Jaya',
  cct: 'PT Cimanggis Cibitung Tollways',
  cmnp: 'PT Citra Marga Nusaphala Persada Tbk',
  kkdm: 'PT Kresna Kusuma Dyandra Marga',
  tjt: 'PT Trans Jabar Tol',
  jlb: 'PT Jakarta Lingkar Baratsatu',
  TBS: 'PT Trans Bumi Serbaraja',
  jtd: 'PT Jakarta Tollroad Development',
  ctp: 'PT Cibitung Tanjung Priok Port Tollways',
  csj: 'PT Cinere Serpong Jaya',
  mlj: 'PT Marga Lingkar Jakarta',
  mtn: 'PT Marga Trans Nusantara',
};
const tollSourceKey = (code) => `tol-${code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const stations = (
  await Promise.all(stationsArg.split(',').map(async (path) => JSON.parse(await readFile(path, 'utf8')).stations))
).flat();

function metres(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const x = (lon2 - lon1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.hypot(x, y) * 6371e3;
}

function nearestStation(lat, lon) {
  let best = null;
  for (const s of stations) {
    const m = metres(lat, lon, s.lat, s.lon);
    if (m <= NEAR_M && (!best || m < best.m)) best = { code: s.code, m };
  }
  return best?.code;
}

// A source that cannot be read stops the run: writing without it would drop all its cameras.
async function get(url) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return await res.text();
      failure = `HTTP ${res.status}`;
    } catch (e) {
      failure = e.cause?.code ?? e.name;
    }
  }
  throw new Error(`${url} could not be read (${failure}); cctv/v1.json was left unchanged`);
}

/** Whether the stream answers with a playlist now, and whether other sites may play it. */
async function probe(url) {
  try {
    const res = await fetch(url, { headers: { origin: WEB_ORIGIN }, signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok || !body.startsWith('#EXTM3U')) return null;
    const cors = res.headers.get('access-control-allow-origin');
    return { web: cors === '*' || cors === WEB_ORIGIN };
  } catch {
    return null;
  }
}

const tidy = (text) => text.replace(/\s+/g, ' ').trim();

/** "13+200 A" → "KM 13+200 A"; BPJT gives some cameras only their kilometre post. */
function segmentName(cam) {
  const name = tidy(cam.nama_segment ?? '') || tidy(cam.nama_km ?? '');
  if (!name) return 'Kamera';
  return /^\d+\+\d+/.test(name) ? `KM ${name}` : name;
}

/** "6 Tol Dalam Kota (…)" → "Tol Dalam Kota (…)", "Serpong - Balaraja" → "Tol Serpong-Balaraja". */
function roadName(ruas) {
  const name = tidy(ruas ?? '').replace(/^\d+\s+(?=tol\b)/i, '').replace(/\s*-\s*/g, '-');
  return /^tol\b/i.test(name) ? name : `Tol ${name}`;
}

/** BPJT's page carries every camera as `const allStreams = {...}`, keyed by toll road. */
async function bpjtCameras() {
  const html = await get(BPJT_PAGE);
  const match = html.match(/const allStreams = (\{[\s\S]*?\});\s*\n/);
  if (!match) throw new Error('BPJT page no longer carries allStreams');
  const unknown = new Set();
  const cameras = [];
  for (const cam of Object.values(JSON.parse(match[1])).flat()) {
    const lat = Number(cam.lat);
    const lon = Number(cam.lon);
    const url = tidy(cam.streamhls || cam.stream || '');
    if (!inJabodetabek(lat, lon) || !url.startsWith('https://') || !/\.m3u8(\?|$)/.test(url)) continue;
    if (!TOLL_OPERATORS[cam.bujt]) {
      unknown.add(cam.bujt);
      continue;
    }
    cameras.push({
      id: `tol-${cam.id}`,
      source: tollSourceKey(cam.bujt),
      area: roadName(cam.nama_ruas),
      name: segmentName(cam),
      url,
      page: BPJT_PAGE,
      lat,
      lon,
    });
  }
  if (unknown.size) console.warn(`BPJT operators without a name in TOLL_OPERATORS, left out: ${[...unknown].join(', ')}`);
  return cameras;
}

/** "OBVIT-TGR-PASAR CIKUPA" → "Pasar Cikupa"; the prefixes are the owner's internal grouping. */
function bantenName(name) {
  const words = tidy(name.replace(/^(OBVIT-)?TGR-/i, '').replace(/-/g, ' ')).toLowerCase().split(' ');
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function bantenCameras() {
  const list = JSON.parse(await get(`${BANTEN_PAGE}/service/cctv-lists`));
  return list
    .filter((c) => inJabodetabek(Number(c.position?.lat), Number(c.position?.lng)))
    .map((c) => ({
      id: `banten-${c.id.slice(0, 8)}`,
      source: 'banten',
      area: 'Kabupaten Tangerang',
      name: bantenName(c.name),
      url: `${BANTEN_PAGE}/service/stream-cctv/${c.id}/index.m3u8`,
      page: BANTEN_PAGE,
      lat: Number(c.position.lat),
      lon: Number(c.position.lng),
    }));
}

const found = [...(await bpjtCameras()), ...(await bantenCameras())];
const probed = await Promise.all(found.map((c) => probe(c.url)));

// Two cameras on one road can share a segment name; number them so each row is distinct.
const live = found.flatMap((c, i) => (probed[i] ? [{ ...c, web: probed[i].web }] : []));
const seenNames = new Map();
const cameras = [];
const usedIds = new Set();
for (const c of live) {
  if (usedIds.has(c.id)) continue;
  usedIds.add(c.id);
  const key = `${c.area}\n${c.name}`;
  const n = (seenNames.get(key) ?? 0) + 1;
  seenNames.set(key, n);
  const station = nearestStation(c.lat, c.lon);
  cameras.push({
    id: c.id,
    ...(station ? { station } : {}),
    source: c.source,
    kind: 'road',
    area: c.area,
    name: n > 1 ? `${c.name} · ${n}` : c.name,
    play: { type: 'hls', url: c.url, web: c.web },
    page: c.page,
    lat: Number(c.lat.toFixed(6)),
    lon: Number(c.lon.toFixed(6)),
  });
}
// Name the first of a repeated name too, once a second one is known.
for (const c of cameras) {
  if (seenNames.get(`${c.area}\n${c.name}`) > 1) c.name = `${c.name} · 1`;
}

/** `{ "a": 1, "b": { "c": true } }`, the one-line style the catalog's cameras are written in. */
function oneLine(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${oneLine(v)}`).join(', ')} }`;
}

/**
 * The catalog keeps one camera per line, so a diff shows exactly which cameras changed. The
 * hand-picked cameras stay as written; the built ones follow, a blank line between areas.
 */
function format(catalog, handPicked) {
  const built = [];
  let area = null;
  for (const c of catalog.cameras.filter((c) => generated(c.source))) {
    if (built.length && c.area !== area) built[built.length - 1] += '\n';
    area = c.area;
    built.push(`    ${oneLine(c)}`);
  }
  const lines = [...handPicked, ...built].map((l, i, all) => (i < all.length - 1 ? l.replace(/(\n?)$/, ',$1') : l));
  if (handPicked.length && built.length) lines[handPicked.length - 1] += '\n';
  const head = JSON.stringify({ version: catalog.version, updatedAt: catalog.updatedAt, sources: catalog.sources }, null, 2).replace(/\n\}$/, '');
  return `${head},\n  "cameras": [\n${lines.join('\n')}\n  ]\n}\n`;
}

const generated = (key) => key.startsWith('tol-') || key === 'banten';
// A Windows checkout may have CRLF line ends; work on LF and write LF.
const catalogText = (await readFile(CATALOG, 'utf8')).replace(/\r\n/g, '\n');
const catalog = JSON.parse(catalogText);
// The hand-picked cameras' lines as written, blank lines included; built cameras are dropped.
const handPicked = catalogText
  .slice(catalogText.indexOf('"cameras": [\n') + '"cameras": [\n'.length, catalogText.lastIndexOf('\n  ]'))
  .split('\n')
  .filter((l) => !/"source": "(tol-[^"]*|banten)"/.test(l))
  .join('\n')
  .trimEnd()
  .replace(/,$/, '')
  .split(/,\n/);
const sources = Object.fromEntries(Object.entries(catalog.sources).filter(([key]) => !generated(key)));
for (const c of cameras) {
  if (c.source === 'banten') {
    sources.banten = { name: 'Sistem Pemantauan CCTV · Pemprov Banten', owner: 'Diskominfo Provinsi Banten', page: BANTEN_PAGE };
  } else if (!sources[c.source]) {
    const code = Object.keys(TOLL_OPERATORS).find((k) => tollSourceKey(k) === c.source);
    sources[c.source] = { name: 'CCTV Jalan Tol · BPJT Kementerian PU', owner: TOLL_OPERATORS[code], page: BPJT_PAGE };
  }
}
catalog.sources = sources;
catalog.cameras = [...catalog.cameras.filter((c) => !generated(c.source)), ...cameras];
catalog.updatedAt = new Date().toISOString().slice(0, 10);
await writeFile(CATALOG, format(catalog, handPicked));

const near = cameras.filter((c) => c.station).length;
console.log(
  `${found.length} road cameras found, ${cameras.length} live and written (${cameras.filter((c) => c.play.web).length} play on the web, ${near} near a station)`,
);
