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
