// Start-up for Astrolabe.exe (appended to the bundle by build-app.js; not run on its own).
// Unpacks the embedded pages into astrolabe-data\ when the exe is newer than what's there, copies the game's icons
// the first time, then starts the server.
(function start() {
  const sea = require('node:sea');
  const put = (rel, data) => { const f = __path.join(__base, rel); __fs.mkdirSync(__path.dirname(f), { recursive: true }); __fs.writeFileSync(f, data); };
  const verFile = __path.join(__base, 'app-version.txt');
  const ver = sea.isSea() ? sea.getAsset('version.txt', 'utf8') : '';
  if (ver && (!__fs.existsSync(verFile) || __fs.readFileSync(verFile, 'utf8') !== ver)) {
    for (const rel of ['public/index.html', 'public/wiki.html', 'lib/combat.js', 'docs/mechanics.md']) {
      try { put(rel, Buffer.from(sea.getAsset(rel))); } catch {}
    }
    put('app-version.txt', ver);
  }
  // Icons: copied out of the game once (and again after a game update), like Dump-Game-Assets.cmd does.
  const idx = __path.join(__base, 'data', 'img', 'index.json');
  const { findGameExe } = __req('server.js', './lib/gamedata');
  const game = findGameExe();
  if (game && (!__fs.existsSync(idx) || __fs.statSync(game).mtimeMs > __fs.statSync(idx).mtimeMs)) {
    console.log('Copying the game\'s icons (first start or after a game update, about a minute)...');
    const argv = process.argv;
    try {
      process.argv = [argv[0], argv[1]];
      __req('server.js', './dump-assets.js');
      __req('server.js', './unpack-assets.js');
      for (const f of __fs.readdirSync(__path.join(__base, 'data'))) if (/^assets-\d+\.bin$/.test(f)) __fs.unlinkSync(__path.join(__base, 'data', f));
    } catch (e) { console.log('Icons not copied: ' + e.message + '. The tools work without them.'); }
    process.argv = argv;
  }
  __req('server.js', './server.js');
})();
