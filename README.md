# Astrolabe Tools

A local web app for Melvor Idle 2 that reads your own save and tells you what to do next: money per hour for every action, best gear per skill, upgrade and Astrology node order, combat rates, and a planner for any item or level. It also builds the public [Astrolabe Wiki](https://astrolabe-melvor.github.io/).

## Use

Needs [Node.js](https://nodejs.org/) 20 or newer and the game installed.

1. `Extract-Game-Data.cmd` copies the game's data out of `Melvor2.exe` (run again after game updates).
2. `Dump-Game-Assets.cmd` then `node unpack-assets.js` extract the game's images (optional, for icons).
3. `Start-MI2-Tools.cmd` starts the app and opens it in your browser.

Nothing is sent anywhere; it reads your save from `%APPDATA%\Games By Malcs` on your own machine.

## Publishing the wiki

`Publish-Wiki.cmd` builds the static wiki into a clone of `astrolabe-melvor.github.io` next to this folder and pushes it.

## License

MIT. Not affiliated with Games by Malcs or Jagex. No game files are included.
