const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');

function settingsPath() {
  if (process.env.YOINK_CONFIG) return path.resolve(process.env.YOINK_CONFIG);
  const directory = process.platform === 'win32'
    ? path.join(process.env.APPDATA || os.homedir(), 'Yoink')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'yoink');
  return path.join(directory, 'settings.json');
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const cancelled = (signal) => signal?.throwIfAborted();

async function loadSettings(file) {
  try {
    const settings = await readJson(file);
    return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function rememberParent(parent, file) {
  const settings = await loadSettings(file);
  if (settings.runsDirectory === parent) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...settings, runsDirectory: parent }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// Probe only local, read-only status commands. Never load a candidate's application code
// or allocate console memory just to find out whether it is the current run.
function probe(endpoint, command, { signal, timeout = 1200 } = {}) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    let request;
    let socket;
    let timer;
    let settled = false;
    let data = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      request?.destroy();
      socket?.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(signal.reason);
    const receive = (chunk) => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) finish(new Error('RPC status reply is too large'));
    };
    const end = () => {
      try {
        const value = JSON.parse(data);
        if (value.error) throw new Error(value.error);
        finish(null, value);
      } catch (error) { finish(error); }
    };
    timer = setTimeout(() => finish(new Error('RPC status check timed out')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (typeof endpoint === 'number') {
      request = http.request({ host: '127.0.0.1', port: endpoint, path: '/', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        socket = response;
        response.setEncoding('utf8');
        response.on('data', receive);
        response.on('error', finish);
        response.on('aborted', () => finish(new Error('RPC status reply was interrupted')));
        response.on('end', () => response.statusCode === 200 ? end() : finish(new Error('RPC status HTTP ' + response.statusCode)));
      });
      request.on('error', finish);
      request.end(JSON.stringify({ command }));
    } else {
      socket = net.createConnection(endpoint);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ command }) + '\n'));
      socket.on('data', receive);
      socket.on('error', finish);
      socket.on('end', end);
    }
  });
}

async function metadata(run) {
  const engine = path.join(run, 'switch2');
  const [current, proof, connection, stat] = await Promise.all([
    readJson(path.join(engine, 'current-acquisition.json')),
    readJson(path.join(engine, 'ro/root/current-root.json')),
    readJson(path.join(run, 'connection.json')),
    fs.stat(path.join(engine, 'current-acquisition.json')),
    fs.access(path.join(engine, 'app/session.cjs')),
  ]);
  if (!current.session || current.session !== proof.session || current.report !== proof.report ||
      connection.addresses?.session !== current.session || connection.addresses?.platform !== 2 ||
      !Number.isInteger(proof.rootHandle) || proof.rootHandle <= 0 ||
      typeof current.socketPath !== 'string' || !current.socketPath ||
      !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535) {
    throw new Error('Incomplete or mismatched RPC run metadata');
  }
  return { run, current, connection, time: Date.parse(current.finished) || stat.mtimeMs };
}

async function verify(info, options) {
  const [bridge, native] = await Promise.all([
    probe(info.connection.port, 'status', options),
    probe(info.current.socketPath, 'root-native-info', options),
  ]);
  if (bridge.ready !== true || native.session !== info.current.session || !Array.isArray(native.services)) {
    throw new Error('The application or filesystem RPC endpoint is no longer ready');
  }
  return info.run;
}

async function findLiveRun(parent, { signal, onStatus = () => {}, ...options } = {}) {
  cancelled(signal);
  const entries = await fs.readdir(parent, { withFileTypes: true });
  const candidates = await Promise.allSettled(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('switch2-'))
    .map((entry) => metadata(path.join(parent, entry.name))));
  const ordered = candidates.filter((candidate) => candidate.status === 'fulfilled')
    .map((candidate) => candidate.value).sort((a, b) => b.time - a.time || a.run.localeCompare(b.run));
  for (const info of ordered) {
    cancelled(signal);
    onStatus('Checking RPC run ' + path.basename(info.run));
    try { return await verify(info, { signal, ...options }); }
    catch { cancelled(signal); }
  }
  throw new Error('No live RPC run was found in ' + parent + '. Start ns2jb with --rpc and keep SmileBASIC open.');
}

function inputPath(value) {
  let text = value.trim();
  if (text.length >= 2 && (text.startsWith('"') && text.endsWith('"') || text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
  if (!text) throw new Error('Enter an ns2jb run folder or its parent runs folder.');
  if (/^~[/\\]/.test(text)) text = path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

async function selectRun(value, options) {
  const directory = await fs.realpath(inputPath(value));
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('The RPC path must be a folder.');
  if (path.basename(directory).startsWith('switch2-')) return verify(await metadata(directory), options);
  // Also allow a specifically named/copied run directory, rather than requiring ns2jb's prefix.
  try { await fs.access(path.join(directory, 'switch2/current-acquisition.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return findLiveRun(directory, options);
  }
  return verify(await metadata(directory), options);
}

async function resolveRun({ provided, configFile = settingsPath(), prompt, signal, onStatus = () => {}, timeout } = {}) {
  cancelled(signal);
  const settings = await loadSettings(configFile);
  let reason = 'Enter the run folder printed by ns2jb, or the parent runs folder.';
  let value = provided;
  if (!provided && typeof settings.runsDirectory === 'string') {
    onStatus('Looking for a live RPC run');
    try { return await findLiveRun(settings.runsDirectory, { signal, timeout, onStatus }); }
    catch (error) { cancelled(signal); reason = error.message; }
  }
  for (;;) {
    cancelled(signal);
    if (!value) {
      if (!prompt) throw new Error(reason + '\nPass a run path: node yoink.cjs <run-directory>.');
      value = await prompt({ reason, parent: settings.runsDirectory || '' });
      if (value === null || value === undefined) return null;
    }
    try {
      onStatus('Validating the RPC run');
      const run = await selectRun(value, { signal, timeout, onStatus });
      cancelled(signal);
      try { await rememberParent(path.dirname(run), configFile); }
      catch (error) { onStatus('Could not save the runs folder: ' + error.message); }
      return run;
    } catch (error) {
      cancelled(signal);
      if (!prompt) throw error;
      reason = error.message;
      value = undefined;
    }
  }
}

module.exports = { resolveRun, findLiveRun, settingsPath };
