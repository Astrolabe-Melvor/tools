// Reads the game's data (items, recipes, prices) from the Godot pack embedded in Melvor2.exe.
// The pack lives in a PE section named "pck"; inside it, Data/Packages/MelvorBase.json holds the content.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPDATA_GAME = path.join(process.env.APPDATA || '', 'Games By Malcs', 'Melvor Idle 2');

// The game writes its own exe path to logs/godot.log on every launch.
function findGameExe() {
  const fromEnv = process.env.MI2_GAME_DIR && path.join(process.env.MI2_GAME_DIR, 'Melvor2.exe');
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const logDir = path.join(APPDATA_GAME, 'logs');
  if (fs.existsSync(logDir)) {
    const logs = fs.readdirSync(logDir).filter(f => f.endsWith('.log'))
      .map(f => path.join(logDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const log of logs) {
      const head = fs.readFileSync(log, 'utf8').slice(0, 4000);
      const m = head.match(/Executable Path: "([^"]+Melvor2\.exe)"/);
      if (m && fs.existsSync(m[1])) return path.normalize(m[1]);
    }
  }
  return null;
}

// Opens the Godot pack embedded in Melvor2.exe (PE section "pck") and lists its files.
function openPack(exe) {
  const fd = fs.openSync(exe, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (off, len) => {
    if (off < 0 || len < 0 || off + len > size) throw new Error('Read outside Melvor2.exe');
    const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b;
  };
  try {
    const dos = read(0, 64);
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a Windows executable');
    const pe = dos.readUInt32LE(60);
    const coff = read(pe, 24);
    const nSections = coff.readUInt16LE(6);
    const sections = read(pe + 24 + coff.readUInt16LE(20), nSections * 40);
    let packStart = -1, packEnd = -1;
    for (let i = 0; i < sections.length; i += 40) {
      if (sections.toString('ascii', i, i + 8).replace(/\0+$/, '') === 'pck') {
        packStart = sections.readUInt32LE(i + 20);
        packEnd = packStart + sections.readUInt32LE(i + 16);
      }
    }
    if (packStart < 0) throw new Error('No embedded game pack found');
    const h = read(packStart, 40);
    if (h.toString('ascii', 0, 4) !== 'GDPC') throw new Error('Unknown pack format');
    const packVersion = h.readUInt32LE(4);
    const flags = h.readUInt32LE(20);
    if (flags & 1) throw new Error('Pack directory is encrypted');
    const dataStart = packStart + Number(h.readBigUInt64LE(24));
    const dirStart = packStart + Number(h.readBigUInt64LE(32));
    const dir = read(dirStart, packEnd - dirStart);
    const count = dir.readUInt32LE(0);
    let c = 4;
    const entries = [];
    for (let i = 0; i < count; i++) {
      const nameLen = dir.readUInt32LE(c); c += 4;
      const name = dir.toString('utf8', c, c + nameLen).replace(/\0+$/, '').replace(/^res:\/\//, ''); c += nameLen;
      const off = Number(dir.readBigUInt64LE(c));
      const len = Number(dir.readBigUInt64LE(c + 8));
      const md5 = dir.subarray(c + 16, c + 32);
      const fileFlags = dir.readUInt32LE(c + 32);
      c += 36;
      entries.push({ name, off: dataStart + off, len, md5, encrypted: !!(fileFlags & 1) });
    }
    return { packVersion, entries, read: e => read(e.off, e.len), close: () => fs.closeSync(fd) };
  } catch (e) { fs.closeSync(fd); throw e; }
}

function readPackFile(exe, wanted) {
  const pack = openPack(exe);
  try {
    const e = pack.entries.find(x => x.name === wanted);
    if (!e) { const err = new Error(`${wanted} not found in pack (${pack.entries.length} files)`); err.names = pack.entries.map(x => x.name); throw err; }
    if (e.encrypted) throw new Error(`${wanted} is encrypted`);
    const bytes = pack.read(e);
    return { bytes, checksumOk: crypto.createHash('md5').update(bytes).digest().equals(e.md5), packVersion: pack.packVersion };
  } finally { pack.close(); }
}

function loadGameData(exe = findGameExe()) {
  if (!exe) throw new Error('Could not find Melvor2.exe. Launch the game once, or set MI2_GAME_DIR to the game folder.');
  const { bytes, checksumOk } = readPackFile(exe, 'Data/Packages/MelvorBase.json');
  const data = JSON.parse(bytes.toString('utf8'));
  return { exe, checksumOk, data, mtime: fs.statSync(exe).mtimeMs };
}

module.exports = { findGameExe, openPack, readPackFile, loadGameData };
