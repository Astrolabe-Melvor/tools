# Astrolabe Tools

A local web app for Melvor Idle 2 that reads your own save and tells you what to do next: money per hour for every action, best gear per skill, upgrade and Astrology node order, combat rates, and a planner for any item or level. It also builds the public [Astrolabe Wiki](https://astrolabe-melvor.github.io/).

## Use

Needs [Node.js](https://nodejs.org/) 20 or newer and the game installed.

1. `Extract-Game-Data.cmd` copies the game's data out of `Melvor2.exe` (run again after game updates).
2. `Dump-Game-Assets.cmd` then `node unpack-assets.js` extract the game's images (optional, for icons).
3. `Start-MI2-Tools.cmd` starts the app and opens it in your browser.

Nothing is sent anywhere; it reads your save from `%APPDATA%\Games By Malcs` on your own machine.

## Sharing the tools

`Package.cmd` builds `dist\AstrolabeTools-<date>.zip` with a copy of `node.exe` inside, so people can unzip and run `Start-MI2-Tools.cmd` without installing Node.

## With the Course mod

While the tools run, the in-game Course planner reads `http://127.0.0.1:5320/api/plan`: the same action rates as the wiki, but with your gear, upgrades and mastery. Without the tools it uses the wiki's `plan.json`.

## Publishing the wiki

`Publish-Wiki.cmd` builds the static wiki into a clone of `astrolabe-melvor.github.io` next to this folder and pushes it.

Visitors can load their own save on the wiki's Your save page: `lib/brotli.js` decompresses it and `lib/savecore.js` (the same parser the tools use) reads it, both in the browser, so the save never leaves their machine.

The wiki has a combat calculator (`lib/combat.js`, the same formulas as the tools, run in the browser), gear compare, an Astrology map, hover cards and stat search. Each publish compares the new game data against the last published `wiki.json` and adds an entry to `changes.json`, shown on the wiki's Game changes page.

## License

MIT. Not affiliated with Games by Malcs or Jagex. No game files are included.

`Build-App.cmd` makes `dist\Astrolabe.exe`, the tools as a single file to double-click (no Node install needed). It keeps the game data and icons in `astrolabe-data\` next to itself and copies the icons from your game on first start.

The tools also have Bank cleanup (what's safe to sell, sent to Course as sell steps), Goals (progress and an ETA at your recent pace) and History (charts from Logbook's half-hourly records).
