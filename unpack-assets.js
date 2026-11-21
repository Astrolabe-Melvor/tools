// Turns data\assets-N.bin (from dump-assets.js) into WebP/PNG files under data\img\, keyed by the game's res:// paths.
// Godot stores each imported texture as a .ctex: a GST2 header, then the image (usually lossless WebP, first mip = full size).
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.argv[2] || path.join(__dirname, 'data'));
const outDir = path.resolve(process.argv[3] || path.join(dataDir, 'img'));
const files = {};
for (const f of fs.readdirSync(dataDir).filter(f => /^assets-\d+\.bin$/.test(f)).sort()) {
  const buf = fs.readFileSync(path.join(dataDir, f));
  for (let p = 0; p < buf.length;) {
    const nl = buf.readUInt32LE(p), name = buf.toString('utf8', p + 4, p + 4 + nl), dl = buf.readUInt32LE(p + 4 + nl);
    files[name] = buf.subarray(p + 8 + nl, p + 8 + nl + dl);
    p += 8 + nl + dl;
  }
}
const map = {};
let ok = 0, bad = [];
for (const [name, bytes] of Object.entries(files)) {
  if (!name.endsWith('.import')) continue;
  const src = name.slice(0, -7);
  const m = bytes.toString('utf8').match(/path(?:\.s3tc|\.etc2)?="res:\/\/([^"]+\.ctex)"/);
  const ctex = m && files[m[1]];
  if (!ctex || ctex.toString('latin1', 0, 4) !== 'GST2') { if (m) bad.push(src); continue; }
  let img = null, ext = null;
  const riff = ctex.indexOf('RIFF'), png = ctex.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (riff > 0 && (png < 0 || riff < png)) { img = ctex.subarray(riff, riff + 8 + ctex.readUInt32LE(riff + 4)); ext = '.webp'; }
  else if (png > 0) { img = ctex.subarray(png, png + ctex.readUInt32LE(png - 4)); ext = '.png'; }
  if (!img) { bad.push(src); continue; }
  const rel = src.replace(/\.[a-z]+$/i, ext);
  fs.mkdirSync(path.join(outDir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(outDir, rel), img);
  map[src] = rel; ok++;
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(map));
console.log(`Wrote ${ok} images to ${outDir}${bad.length ? `; ${bad.length} not decoded (e.g. ${bad.slice(0, 3).join(', ')})` : ''}`);
