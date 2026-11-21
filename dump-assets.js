// Copies the game's image files out of Melvor2.exe into data\assets-N.bin bundles (plus a list of every file
// in the pack), so the wiki can show item, monster and skill icons. Audio, fonts and scripts are skipped.
// Bundle format: repeated [u32 name length][name][u32 data length][data].
const fs = require('fs');
const path = require('path');
const { findGameExe, openPack } = require('./lib/gamedata');

const exe = process.argv[2] ? path.join(process.argv[2], 'Melvor2.exe') : findGameExe();
if (!exe) { console.error('Could not find Melvor2.exe. Drag the game folder onto Dump-Game-Assets.cmd.'); process.exit(1); }
console.log('Game:', exe);
const pack = openPack(exe);
const out = path.join(__dirname, 'data');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'pack-list.txt'), pack.entries.map(e => `${e.len}\t${e.encrypted ? 'enc' : ''}\t${e.name}`).join('\n'));

const want = e => !e.encrypted && (/\.(ctex|png|webp|jpg|svg|import|remap|stex)$/i.test(e.name)) && !/\.(ogg|wav|mp3|ttf|otf)/i.test(e.name);
const list = pack.entries.filter(want);
const LIMIT = 350 * 1048576;
let part = 0, size = 0, fd = null, files = 0, total = 0;
const open = () => { fd = fs.openSync(path.join(out, `assets-${part}.bin`), 'w'); size = 0; };
for (const f of fs.readdirSync(out)) if (/^assets-\d+\.bin$/.test(f)) fs.unlinkSync(path.join(out, f));
open();
for (const e of list) {
  const name = Buffer.from(e.name, 'utf8');
  const data = pack.read(e);
  const head = Buffer.alloc(8 + name.length);
  head.writeUInt32LE(name.length, 0); name.copy(head, 4); head.writeUInt32LE(data.length, 4 + name.length);
  if (size + head.length + data.length > LIMIT && size > 0) { fs.closeSync(fd); part++; open(); }
  fs.writeSync(fd, head); fs.writeSync(fd, data);
  size += head.length + data.length; total += data.length; files++;
}
fs.closeSync(fd);
pack.close();
console.log(`Wrote ${files} image files (${(total / 1048576).toFixed(1)} MB) into ${part + 1} bundle(s) in ${out}`);
console.log(`Pack has ${pack.entries.length} files in total; the full list is in data\\pack-list.txt`);
