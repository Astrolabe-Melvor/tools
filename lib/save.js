// Melvor Idle 2 save reader for the local tools: finds and decompresses the save, then parses it with
// lib/savecore.js (which the public wiki also runs in the browser).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseSave, XP_TABLE, levelFor, Reader, readHeader, readComponents } = require('./savecore');

function decompress(file) {
  // The stream isn't formally closed, so flush instead of finishing.
  return zlib.brotliDecompressSync(fs.readFileSync(file), {
    finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
  });
}

function readSave(file) {
  return { file, modified: fs.statSync(file).mtimeMs, ...parseSave(decompress(file)) };
}

// Finds the newest .sav under %APPDATA%\Games By Malcs\Melvor Idle 2\steam\<id>\saves
function findSave(root = path.join(process.env.APPDATA || '', 'Games By Malcs', 'Melvor Idle 2', 'steam')) {
  let best = null;
  if (!fs.existsSync(root)) return null;
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id, 'saves');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.sav')) continue;
      const full = path.join(dir, f);
      const m = fs.statSync(full).mtimeMs;
      if (!best || m > best.m) best = { full, m };
    }
  }
  return best && best.full;
}

module.exports = { readSave, findSave, XP_TABLE, levelFor, decompress, Reader, readHeader, readComponents };
