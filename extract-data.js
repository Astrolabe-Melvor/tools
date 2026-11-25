// Copies the game's data file out of Melvor2.exe into mi2-tools\data\MelvorBase.json.
const fs = require('fs');
const path = require('path');
const { findGameExe, readPackFile } = require('./lib/gamedata');

const exe = process.argv[2] ? path.join(process.argv[2], 'Melvor2.exe') : findGameExe();
if (!exe) { console.error('Could not find Melvor2.exe. Drag the game folder onto this script.'); process.exit(1); }
console.log('Game:', exe);
const { bytes, checksumOk } = readPackFile(exe, 'Data/Packages/MelvorBase.json');
const outDir = path.join(__dirname, 'data');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'MelvorBase.json');
fs.writeFileSync(out, bytes);
console.log(`Wrote ${out} (${(bytes.length / 1048576).toFixed(1)} MB, checksum ${checksumOk ? 'OK' : 'MISMATCH'})`);

// The game's version (shown on the wiki), from the project settings in the same pack.
try {
  const { bytes: pb } = readPackFile(exe, 'project.binary');
  const t = pb.toString('latin1'), i = t.indexOf('application/config/version');
  const m = i >= 0 && t.slice(i + 26, i + 400).match(/v?\d+\.\d+\.\d+[-\w.]*/);
  if (m) {
    const v = m[0].startsWith('v') ? m[0] : 'v' + m[0];
    fs.writeFileSync(path.join(outDir, 'version.txt'), v);
    console.log('Game version', v);
  } else console.log('Game version not found in project.binary');
} catch (e) { console.log('Game version not read:', e.message); }
