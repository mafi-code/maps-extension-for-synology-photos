// Builds the installable extension package: only the files Chrome needs.
// Usage: npm run package [-- --expect-version 0.3.1] [--out dist]
// Output: <out>/maps-extension-for-synology-photos-v<version>.zip
// No dependencies: small ZIP writer on top of node:zlib (deflate + crc32).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'maps-extension-for-synology-photos';

// Everything the extension loads at runtime – nothing else ends up in the package.
const FILES = [
  'manifest.json', 'LICENSE',
  'page-hook.js', 'content.js', 'content.css',
  'map.html', 'map.js', 'map.css',
  'popup.html', 'popup.js',
];
const DIRS = ['_locales', 'icons', 'vendor'];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(rel) : [rel];
  });
}

// ---------- collect + check ----------

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const expected = arg('expect-version');
if (expected && expected !== version) {
  fail(`tag version ${expected} does not match manifest.json version ${version}`);
}

const files = [...FILES, ...DIRS.flatMap(walk)].sort();
for (const f of files) if (!fs.existsSync(path.join(ROOT, f))) fail(`missing file ${f}`);

// every path the manifest refers to must be part of the package
const referenced = [
  manifest.action && manifest.action.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources),
  manifest.default_locale && `_locales/${manifest.default_locale}/messages.json`,
].filter(Boolean);
for (const ref of referenced) if (!files.includes(ref)) fail(`manifest refers to ${ref}, which is not packaged`);

// ---------- zip ----------

const crc32 = zlib.crc32 || ((buf) => { // fallback for Node < 20.15
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
});

// fixed timestamp (2026-01-01 00:00) → identical input gives an identical zip
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const locals = [];
const centrals = [];
let offset = 0;
for (const f of files) {
  const data = fs.readFileSync(path.join(ROOT, f));
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const name = Buffer.from(f, 'utf8');
  const crc = crc32(data) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);              // version needed
  local.writeUInt16LE(0x0800, 6);          // UTF-8 names
  local.writeUInt16LE(stored ? 0 : 8, 8);  // method
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);            // version made by
  central.writeUInt16LE(20, 6);            // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(stored ? 0 : 8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);       // other fields stay 0
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const outDir = path.resolve(ROOT, arg('out') || 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${NAME}-v${version}.zip`);
fs.writeFileSync(outFile, Buffer.concat([...locals, ...centrals, end]));
console.log(`${path.relative(ROOT, outFile)}  ${files.length} files  ${Math.round(fs.statSync(outFile).size / 1024)} KB`);
