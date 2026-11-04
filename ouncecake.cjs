#!/usr/bin/env node
const path = require('node:path');
const { createInterface } = require('node:readline');
const { titleId, withCleanup } = require('./engine/protocol.cjs');
const { attachGame } = require('./engine/session.cjs');
const { discoverGames, listApplicationContent } = require('./engine/content.cjs');
const { prepareGame, probeDataPatches } = require('./engine/mounts.cjs');
const { deployFtp, readImage } = require('./engine/ftp.cjs');
const { packNup } = require('./engine/nup.cjs');

const USAGE = 'Usage: node ouncecake.cjs <run-directory> [title-id] [--port 2121] [--nup <out.nup> --ip <switch 2 ip>] [--edition switch2]\n' +
              'Use the run dir given by ns2jb (Run folder: <whatever>)\n' +
              'You can also provide a title ID to skip the selection menu and just mount a specific game\n' +
              'With --nup, OunceCake downloads everything itself and writes a .nup instead of leaving the FTP up\n' +
              '--edition picks how a Switch 2 Edition is packed: switch2 (default, one flattened Switch 2 package),\n' +
              '  switch1, both (one file each), or all (every dumped package in one file, as the NUP spec lays it out)\n' +
              '--probe lists every installed content meta of the title (incl. add-on data patches) and exits\n';

function getArgs(argv) {
  const args = [];
  let port = 2121;
  let nup;
  let ip;
  let edition = 'switch2';
  let probe = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help') {
      return { help: true };
    }

    if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('Invalid --port value\n' + USAGE);
      }
      continue;
    }

    if (a === '--nup') {
      nup = argv[++i];
      if (!nup || nup.startsWith('--')) throw new Error('--nup needs an output file\n' + USAGE);
      continue;
    }

    if (a === '--ip') {
      ip = argv[++i];
      if (!ip || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) throw new Error('--ip needs an IPv4 address\n' + USAGE);
      continue;
    }

    if (a === '--probe') {
      probe = true;
      continue;
    }

    if (a === '--edition') {
      edition = argv[++i];
      if (!['switch1', 'switch2', 'both', 'all'].includes(edition)) {
        throw new Error('--edition must be switch1, switch2, both, or all\n' + USAGE);
      }
      continue;
    }

    if (a.startsWith('--')) {
      throw new Error('Unknown option: ' + a + '\n' + USAGE);
    }

    args.push(a);
  }

  if (args.length < 1 || args.length > 2) {
    throw new Error(USAGE);
  }

  if (args.length === 1 && /^(?:0x)?[0-9a-fA-F]{16}$/.test(args[0])) {
    throw new Error('You need to add a run directory\n' + USAGE);
  }

  if (Boolean(nup) !== Boolean(ip)) {
    throw new Error('--nup and --ip go together (OunceCake needs your Switch 2\'s IP to download from it)\n' + USAGE);
  }

  const title = args.length === 2 ? titleId(args[1]) : undefined;
  return { run: path.resolve(args[0]), title, port, nup: nup && path.resolve(nup), ip, edition, probe };
}

const storageNames = { 2: 'Game card', 4: 'Internal', 5: 'SD' };

function gameMenu(games) {
  const width = String(games.length).length;
  return games
    .map((game, i) => {
      const number = String(i + 1).padStart(width);
      const name = game.name || 'Unknown title';
      const storages = game.storages.map((id) => storageNames[id]).join(', ');
      return number + '. ' + name + '  [' + game.title.toUpperCase() + ']  (' + storages + ')';
    })
    .join('\n');
}

async function pickGame(games, signal) {
  const input = process.stdin;
  const output = process.stdout;

  if (!games.length) {
    throw new Error('No games were found. How did you even run this?');
  }

  output.write(gameMenu(games) + '\n');

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const close = () => rl.close();
  rl.once('SIGINT', close);
  signal.addEventListener('abort', close, { once: true });

  const prompt = () => output.write('Choose a game: ');

  try {
    if (signal.aborted) return null;

    prompt();

    for await (const line of lines) {
      if (signal.aborted) return null;

      const value = line.trim();

      if (/^q(?:uit)?$/i.test(value)) return null;

      if (/^[0-9]+$/.test(value)) {
        const number = Number(value);

        if (Number.isSafeInteger(number) && number >= 1 && number <= games.length) return games[number - 1];
      }

      output.write('Enter a number from 1 to ' + games.length + ', or q.\n');
      prompt();
    }

    return null;
  } finally {
    signal.removeEventListener('abort', close);
    rl.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = getArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const image = await readImage();
  const { port, run, nup, ip, edition, probe } = options;
  let { title } = options;
  let name;
  const cancellation = new AbortController();
  // a second ctrl-c used to kill node mid cleanup, leaving the server thread running on the console
  // and the game's fs mounts held open. only a third one gives up on cleanup now
  let interrupts = 0;
  const stop = () => {
    interrupts++;
    if (interrupts === 1) {
      console.log('\nStopping, cleaning up the console side. This takes a few seconds');
    } else if (interrupts === 2) {
      console.log('Still cleaning up. Press Ctrl-C again to quit anyway (the console will need a restart)');
    } else {
      process.exit(130);
    }
    cancellation.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let attachment;
  let server;
  await withCleanup(async () => {
    attachment = await attachGame(run);
    const shouldStop = () => cancellation.signal.aborted;
    if (!title) {
      const selected = await pickGame(await discoverGames({ ...attachment, shouldStop }), cancellation.signal);
      if (!selected || shouldStop()) return;
      title = selected.title;
      name = selected.name;
    }
    if (probe) {
      const content = await listApplicationContent({ ...attachment, title });
      console.log('Installed content for ' + title.toUpperCase() + ':');
      for (const c of content) {
        console.log('  ' + c.id.toUpperCase() + '  v' + c.version + '  ' + c.typeName + '  ' + storageNames[c.storage] +
          (c.installType ? '  install type ' + c.installType : ''));
      }
      const patches = content
        .filter((c) => c.type === 0x84)
        .map((c) => ({ contentTitle: c.id, version: c.version, storage: c.storage }));
      if (!patches.length) console.log('  (no add-on data patches)');
      for (const r of await probeDataPatches({ attachment, title, patches })) {
        console.log('Data patch ' + r.contentTitle.toUpperCase() + ' v' + r.version + ':');
        if (r.contentPath) console.log('  content ' + r.contentPath);
        if (r.error) {
          console.log('  could not read it as a RomFS: ' + r.error);
          continue;
        }
        console.log('  RomFS ' + r.size + ' bytes, ' + r.files + ' files');
        if (r.regionLangMask) console.log('  RegionLangMask: ' + r.regionLangMask);
        for (const t of r.tables) console.log('  ' + t);
      }
      return;
    }
    const prepared = await prepareGame({ attachment, title, images: Boolean(nup), shouldStop });
    if (shouldStop()) return;
    server = await deployFtp({ attachment, image, ...prepared, port });

    if (nup) {
      console.log('FTP up, downloading into ' + nup);
      await packNup({ host: ip, port, views: prepared.views, title, name, output: nup, edition, control: prepared.control, shouldStop });
      return;
    }

    console.log('FTP up! ftp://<switch 2 ip>:' + port);
    console.log('Ctrl-C to stop the server');
    
    while (!shouldStop()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }, () => server?.close(), () => attachment?.close(), () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getArgs, pickGame, main };
