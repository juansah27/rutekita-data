// Adds the road cameras to cctv/v1.json: toll-road cameras listed by BPJT Kementerian PU, the
// Pemprov Banten cameras, the national-road cameras of Bina Marga Kementerian PU, and the city
// cameras of Dishub Depok, Dishub Kabupaten Tangerang, Pemprov DKI and Pemkot Bekasi, inside
// Jabodetabek.
//   node scripts/build-cctv-roads.mjs --stations ../rutekita/assets/data/krl.json,../rutekita/assets/data/rail.json
// Every road camera is replaced; the hand-picked station and street cameras are kept, and a road
// camera whose stream is already hand-picked is left out.
// Only cameras whose stream answers with a playlist right now are written, so run it again later
// to pick up cameras that were offline.
//
// A road camera has `kind: "road"`, an `area` (the toll road or region it watches), `lat`/`lon` when
// its owner publishes a position, and a `station` only when it stands within NEAR_M of one. Apps
// older than road cameras skip them; apps older than road cameras without a position skip those.

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
const DEPOK_PAGE = 'https://dishub.depok.go.id/cctv';
const DKI_PAGE = 'https://jakcctv.jakarta.go.id/publik';
const BEKASI_PAGE = 'https://bekasikota.go.id/cctv';
const BEKASI_STREAMS = 'https://eofficev2.bekasikota.go.id/backupcctv/m3/';
const TANGERANG_KAB_PAGE = 'https://cctv-dishub.tangerangkab.go.id/';
const BINA_MARGA_PAGE = 'https://binamarga.pu.go.id/cctv-non-tol/';
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

/** "PASAR PUCUNG 1" → "Pasar Pucung 1"; short abbreviations such as SP and JPO stay as written. */
function cityName(name) {
  const text = tidy(name);
  if (text !== text.toUpperCase()) return text;
  const keep = (w) => w.length <= 2 || !/[AEIOU]/.test(w) || !/[A-Z]/.test(w);
  return text
    .split(' ')
    .map((w) => (keep(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(' ');
}

/** Dishub Depok's map page carries every camera as `dataCCTV`; a stream is named by its camera's IP without the dots. */
async function depokCameras() {
  const match = (await get(DEPOK_PAGE)).match(/\[\{"exists"[\s\S]*?\}\]/);
  if (!match) throw new Error('Dishub Depok page no longer carries its camera list');
  return JSON.parse(match[0])
    .map((c) => {
      const stream = String(c.ip).replace(/\./g, '');
      return {
        id: `depok-${stream}`,
        source: 'depok',
        area: 'Kota Depok',
        name: cityName(c.nama_cctv),
        url: `https://dishub.depok.go.id/vi/${stream}.m3u8`,
        page: DEPOK_PAGE,
        lat: Number(c.latitude),
        lon: Number(c.longitude),
      };
    })
    .filter((c) => inJabodetabek(c.lat, c.lon));
}

/** "JL.-JEND.-GATOT-SUBROTO" → "Jl. Jend. Gatot Subroto"; "Jl_Ir_H_Juanda" → "Jl. Ir H Juanda". */
function streetName(name) {
  const text = tidy(name.replace(/[-_]/g, ' '));
  // A name already in mixed case is kept as written, apart from "Jl".
  const shouting = text === text.toUpperCase();
  return text
    .split(' ')
    .map((w) => {
      if (/^jl\.?$/i.test(w)) return 'Jl.';
      // Short words (JPO, UOB, MH.) are abbreviations: keep them as written.
      if (!shouting || w.replace(/\./g, '').length <= 3) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * The DKI public portal pages its cameras as HTML cards, each a player iframe named by its stream.
 * The stream name carries the place (the card labels can be shifted against the iframes, so they
 * are not used): "502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7_CCTV-01" → "JPO Jl. Gatot Subroto 7".
 * The portal gives no positions.
 */
async function dkiCameras() {
  const streams = [];
  for (let page = 1; page <= 50; page++) {
    const { cards, total } = JSON.parse(await get(`${DKI_PAGE}/data?q=&page=${page}`));
    const found = [...String(cards).matchAll(/iframe src="(https:\/\/dki-jkt\.balitower\.co\.id:7028\/([^/"]+)\/embed\.html)"/g)];
    streams.push(...found.map((m) => ({ page: m[1], stream: m[2] })));
    if (found.length === 0 || streams.length >= total) break;
  }
  if (streams.length === 0) throw new Error('DKI portal no longer lists its cameras');
  return streams.map(({ page, stream }) => {
    const place =
      stream.match(/^\d+_JK[A-Z]_[^_]+_(.+)_CCTV-\d+$/)?.[1] ?? // 502045_JKP_POLDA_<place>_CCTV-01
      stream.match(/^\d+-(.+)_CCTV-\d+$/)?.[1] ?? // 501968-<place>_CCTV-01
      stream.match(/^(.+?-\d+)-\d+_\d+$/)?.[1] ?? // <kelurahan>-018-705979_2
      stream;
    return {
      id: `dki-${stream.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      source: 'dki',
      area: 'DKI Jakarta',
      // "C02" numbers the camera pole; the builder numbers cameras that share a name.
      name: streetName(place.replace(/[-_]C\d+$/i, '')),
      url: page.replace(/embed\.html$/, 'index.fmp4.m3u8'),
      page,
    };
  });
}

/** Pemkot Bekasi's player reads its camera list from list.json; it gives no positions. */
async function bekasiCameras() {
  return JSON.parse(await get(`${BEKASI_STREAMS}list.json`))
    .filter((c) => typeof c.path === 'string' && c.path.endsWith('.m3u8'))
    .map((c) => ({
      id: `bekasi-${c.path.replace(/\.m3u8$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      source: 'bekasi',
      area: 'Kota Bekasi',
      name: streetName(c.name ?? c.path.replace(/\.m3u8$/, '')),
      url: `${BEKASI_STREAMS}${encodeURIComponent(c.path)}`,
      page: BEKASI_PAGE,
    }));
}

/** Dishub Kabupaten Tangerang's map page carries every camera, with its position, in its Livewire state. */
async function tangerangKabCameras() {
  const html = (await get(`${TANGERANG_KAB_PAGE}cctv-map`)).replace(/&quot;/g, '"');
  const found = [...html.matchAll(/\{"id":"([a-z0-9]+)","name":"([^"]+)","latitude":(-?[\d.]+),"longitude":(-?[\d.]+),"url":"([^"]+)"/g)];
  if (found.length === 0) throw new Error('Dishub Kabupaten Tangerang page no longer carries its camera list');
  const seen = new Set();
  return found
    .filter((m) => !seen.has(m[1]) && seen.add(m[1]))
    .map((m) => ({
      id: `tgrkab-${m[1].slice(-10)}`,
      source: 'tangerang-kab',
      area: 'Kabupaten Tangerang',
      name: tidy(m[2]),
      url: m[5].replace(/\\\//g, '/'),
      page: TANGERANG_KAB_PAGE,
      lat: Number(m[3]),
      lon: Number(m[4]),
    }))
    .filter((c) => c.url.startsWith('https://') && inJabodetabek(c.lat, c.lon));
}

/**
 * Bina Marga's national-road map lists its cameras as `cctvLocations`; each links to a player page
 * whose <source> is the stream. "Tambun Selatan<br />Bekasi" is a camera in Bekasi.
 */
async function binaMargaCameras() {
  const html = await get(BINA_MARGA_PAGE);
  const found = [
    ...html.matchAll(/\{\s*lat:\s*(-?[\d.]+),\s*lng:\s*(-?[\d.]+),\s*info:\s*"([^"]*)",\s*category:\s*"([^"]*)",\s*url:\s*"([^"]*)"/g),
  ];
  if (found.length === 0) throw new Error('Bina Marga page no longer carries cctvLocations');
  const cameras = [];
  for (const [, lat, lon, info, , page] of found) {
    if (!inJabodetabek(Number(lat), Number(lon)) || !/^https:\/\/binamarga\.pu\.go\.id\/play-hls\//.test(page)) continue;
    const url = (await get(page)).match(/<source src="(https:\/\/[^"]+\.m3u8)"/)?.[1];
    if (!url) continue;
    const [place, region = ''] = info.split(/<br\s*\/?>/i).map((t) => tidy(t));
    cameras.push({
      id: `binamarga-${page.match(/play-hls\/(\d+)/)[1]}`,
      source: 'binamarga',
      area: `Jalan Nasional ${region.replace(/^Tanggerang$/i, 'Tangerang')}`.trim(),
      name: place.replace(/\s+-\s+/g, ' · '),
      url,
      page: BINA_MARGA_PAGE,
      lat: Number(lat),
      lon: Number(lon),
    });
  }
  return cameras;
}

// A Windows checkout may have CRLF line ends; work on LF and write LF.
const catalogText = (await readFile(CATALOG, 'utf8')).replace(/\r\n/g, '\n');
const catalog = JSON.parse(catalogText);
const handPickedUrls = new Set(catalog.cameras.filter((c) => c.kind !== 'road').map((c) => c.play?.url));
const handPickedIds = new Set(catalog.cameras.filter((c) => c.kind !== 'road').map((c) => c.id));

const found = [
  ...(await bpjtCameras()),
  ...(await bantenCameras()),
  ...(await depokCameras()),
  ...(await dkiCameras()),
  ...(await bekasiCameras()),
  ...(await tangerangKabCameras()),
  ...(await binaMargaCameras()),
].filter((c) => !handPickedUrls.has(c.url) && !handPickedIds.has(c.id));
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
  const placed = c.lat !== undefined;
  const station = placed ? nearestStation(c.lat, c.lon) : undefined;
  cameras.push({
    id: c.id,
    ...(station ? { station } : {}),
    source: c.source,
    kind: 'road',
    area: c.area,
    name: n > 1 ? `${c.name} · ${n}` : c.name,
    play: { type: 'hls', url: c.url, web: c.web },
    page: c.page,
    ...(placed ? { lat: Number(c.lat.toFixed(6)), lon: Number(c.lon.toFixed(6)) } : {}),
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
  for (const c of catalog.cameras.filter((c) => c.kind === 'road')) {
    if (built.length && c.area !== area) built[built.length - 1] += '\n';
    area = c.area;
    built.push(`    ${oneLine(c)}`);
  }
  const lines = [...handPicked, ...built].map((l, i, all) => (i < all.length - 1 ? l.replace(/(\n?)$/, ',$1') : l));
  if (handPicked.length && built.length) lines[handPicked.length - 1] += '\n';
  const head = JSON.stringify({ version: catalog.version, updatedAt: catalog.updatedAt, sources: catalog.sources }, null, 2).replace(/\n\}$/, '');
  return `${head},\n  "cameras": [\n${lines.join('\n')}\n  ]\n}\n`;
}

// Sources with nothing but built cameras; they are written again from the cameras found.
const BUILT_SOURCES = {
  banten: { name: 'Sistem Pemantauan CCTV · Pemprov Banten', owner: 'Diskominfo Provinsi Banten', page: BANTEN_PAGE },
  'tangerang-kab': { name: 'ATCS Dishub Kabupaten Tangerang', owner: 'Dinas Perhubungan Kabupaten Tangerang', page: TANGERANG_KAB_PAGE },
  binamarga: { name: 'CCTV Jalan Non Tol · Bina Marga Kementerian PU', owner: 'Direktorat Jenderal Bina Marga, Kementerian PU', page: BINA_MARGA_PAGE },
};
const generated = (key) => key.startsWith('tol-') || key in BUILT_SOURCES;
// The hand-picked cameras' lines as written, blank lines included; built cameras are dropped.
const handPicked = catalogText
  .slice(catalogText.indexOf('"cameras": [\n') + '"cameras": [\n'.length, catalogText.lastIndexOf('\n  ]'))
  .split('\n')
  .filter((l) => !/"kind": "road"/.test(l))
  .join('\n')
  .trimEnd()
  .replace(/,$/, '')
  .split(/,\n/);
const sources = Object.fromEntries(Object.entries(catalog.sources).filter(([key]) => !generated(key)));
for (const c of cameras) {
  if (BUILT_SOURCES[c.source]) {
    sources[c.source] = BUILT_SOURCES[c.source];
  } else if (!sources[c.source]) {
    const code = Object.keys(TOLL_OPERATORS).find((k) => tollSourceKey(k) === c.source);
    sources[c.source] = { name: 'CCTV Jalan Tol · BPJT Kementerian PU', owner: TOLL_OPERATORS[code], page: BPJT_PAGE };
  }
}
catalog.sources = sources;
catalog.cameras = [...catalog.cameras.filter((c) => c.kind !== 'road'), ...cameras];
catalog.updatedAt = new Date().toISOString().slice(0, 10);
await writeFile(CATALOG, format(catalog, handPicked));

const near = cameras.filter((c) => c.station).length;
console.log(
  `${found.length} road cameras found, ${cameras.length} live and written (${cameras.filter((c) => c.play.web).length} play on the web, ${near} near a station, ${cameras.filter((c) => c.lat === undefined).length} without a position)`,
);
