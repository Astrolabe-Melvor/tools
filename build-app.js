// Builds dist\Astrolabe.exe: the tools as one file you double-click, no Node install needed.
// It is Node's own single-executable feature: every script here is bundled into one file, the pages it serves are
// embedded as assets, and both are injected into a copy of node.exe. On start the app unpacks its pages next to
// itself (astrolabe-data\), copies the game's icons once, and then runs exactly like Start-MI2-Tools.cmd.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
const work = path.join(dist, 'app-build');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// ---- 1. one script: every local module wrapped in a function, required through a small resolver ----
const modules = ['server.js', 'dump-assets.js', 'unpack-assets.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)];
let bundle = `'use strict';
const __path = require('path'), __fs = require('fs');
// The app keeps its pages and the game data in a folder next to the exe.
const __base = process.env.ASTROLABE_BASE || __path.join(__path.dirname(process.execPath), 'astrolabe-data');
const __defs = {}, __cache = {};
function __req(from, id) {
  if (!id.startsWith('.')) return require(id);
  let key = __path.posix.normalize(__path.posix.join(__path.posix.dirname(from), id));
  if (!key.endsWith('.js')) key += '.js';
  if (__cache[key]) return __cache[key].exports;
  const m = __cache[key] = { exports: {} };
  const dir = __path.join(__base, __path.posix.dirname(key));
  __defs[key](m, m.exports, x => __req(key, x), dir, __path.join(__base, key));
  return m.exports;
}
`;
for (const m of modules) {
  const src = fs.readFileSync(path.join(root, m), 'utf8').replace(/^#!.*\n/, '');
  bundle += `__defs[${JSON.stringify(m)}] = function (module, exports, require, __dirname, __filename) {\n${src}\n};\n`;
}
bundle += fs.readFileSync(path.join(root, 'app-start.js'), 'utf8');
fs.writeFileSync(path.join(work, 'astrolabe.js'), bundle);

// ---- 2. assets: the pages and files the server reads from disk ----
const assets = {};
for (const f of ['public/index.html', 'public/wiki.html', 'lib/combat.js', 'docs/mechanics.md']) if (fs.existsSync(path.join(root, f))) assets[f] = path.join(root, f);
const version = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
fs.writeFileSync(path.join(work, 'version.txt'), version);
assets['version.txt'] = path.join(work, 'version.txt');
fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify({
  main: path.join(work, 'astrolabe.js'), output: path.join(work, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true, useCodeCache: false, assets,
}, null, 2));

// ---- 3. blob, then inject into a copy of node.exe ----
execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea-config.json')], { stdio: 'inherit' });
const exe = path.join(dist, 'Astrolabe.exe');
fs.copyFileSync(process.execPath, exe);
// node.exe is signed; the signature no longer matches once the blob is in, so take it off when signtool is around.
try { execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' }); } catch {}
// npx is a .cmd on Windows, so it runs through the shell: one quoted command line (no argument list) for that.
const q = s => `"${s}"`;
require('child_process').execSync(['npx', '--yes', 'postject', q(exe), 'NODE_SEA_BLOB', q(path.join(work, 'sea-prep.blob')),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'].join(' '), { stdio: 'inherit' });
fs.rmSync(work, { recursive: true, force: true });
console.log(`\nBuilt ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB, version ${version}).`);
console.log('Run it anywhere: it makes astrolabe-data\\ next to itself for the game data and icons.');
