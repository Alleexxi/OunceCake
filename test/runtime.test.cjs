const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { resolveRun, findLiveRun } = require('../engine/runtime.cjs');
const { getArgs } = require('../yoink.cjs');

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yoink-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const parent = path.join(directory, 'runs with spaces');
  await fs.mkdir(parent);
  return { directory, parent, configFile: path.join(directory, 'config', 'settings.json') };
}

async function endpoint(t, session, { ready = true, nativeSession = session, stall = false } = {}) {
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  };
  const bridge = http.createServer((request, response) => {
    if (stall) return;
    let data = '';
    request.on('data', (part) => { data += part; });
    request.on('end', () => {
      assert.equal(JSON.parse(data).command, 'status');
      response.end(JSON.stringify({ ready }));
    });
  });
  bridge.on('connection', track);
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\yoink-' + randomUUID()
    : path.join(os.tmpdir(), 'yoink-' + randomUUID() + '.sock');
  const memory = net.createServer((socket) => {
    track(socket);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (part) => {
      data += part;
      if (!data.includes('\n')) return;
      assert.equal(JSON.parse(data).command, 'root-native-info');
      socket.end(JSON.stringify({ session: nativeSession, services: [] }));
    });
  });
  const listen = (server, address) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, resolve);
  });
  await Promise.all([listen(bridge, { host: '127.0.0.1', port: 0 }), listen(memory, socketPath)]);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([bridge, memory].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  return { port: bridge.address().port, socketPath };
}

async function runFolder(parent, session, endpoint, time = Date.now()) {
  const run = path.join(parent, session);
  const engine = path.join(run, 'switch2');
  await Promise.all([fs.mkdir(path.join(engine, 'ro/root'), { recursive: true }), fs.mkdir(path.join(engine, 'app'), { recursive: true })]);
  const report = session + '/report.json';
  const json = (file, value) => fs.writeFile(file, JSON.stringify(value));
  await Promise.all([
    json(path.join(engine, 'current-acquisition.json'), { session, report, socketPath: endpoint.socketPath, finished: new Date(time).toISOString() }),
    json(path.join(engine, 'ro/root/current-root.json'), { session, report, rootHandle: 123 }),
    json(path.join(run, 'connection.json'), { port: endpoint.port, addresses: { session, platform: 2 } }),
    fs.writeFile(path.join(engine, 'app/session.cjs'), "throw new Error('Discovery must not execute candidate code');"),
  ]);
  return run;
}

test('explicit run saves its parent and preserves other settings', async (t) => {
  const { parent, configFile } = await workspace(t);
  const run = await runFolder(parent, 'switch2-first', await endpoint(t, 'switch2-first'));
  await fs.mkdir(path.dirname(configFile));
  await fs.writeFile(configFile, JSON.stringify({ color: false }));
  assert.equal(await resolveRun({ provided: run, configFile }), run);
  assert.deepEqual(JSON.parse(await fs.readFile(configFile)), { color: false, runsDirectory: parent });
});

test('saved parent follows a newer live run instead of remembering one run', async (t) => {
  const { parent, configFile } = await workspace(t);
  const old = await runFolder(parent, 'switch2-old', await endpoint(t, 'switch2-old'), 1000);
  await resolveRun({ provided: old, configFile });
  const current = await runFolder(parent, 'switch2-current', await endpoint(t, 'switch2-current'), 2000);
  assert.equal(await resolveRun({ configFile }), current);
});

test('newest incomplete and stopped folders do not hide an older live run', async (t) => {
  const { parent } = await workspace(t);
  const active = await runFolder(parent, 'switch2-active', await endpoint(t, 'switch2-active'), 1000);
  await runFolder(parent, 'switch2-stopped', await endpoint(t, 'switch2-stopped', { ready: false }), 2000);
  await fs.mkdir(path.join(parent, 'switch2-incomplete'));
  assert.equal(await findLiveRun(parent), active);
});

test('matching HTTP readiness cannot validate another session memory endpoint', async (t) => {
  const { parent, configFile } = await workspace(t);
  const stale = await runFolder(parent, 'switch2-stale', await endpoint(t, 'switch2-stale', { nativeSession: 'switch2-other' }));
  await assert.rejects(resolveRun({ provided: stale, configFile }), /no longer ready/);
  await assert.rejects(fs.access(configFile), { code: 'ENOENT' });
});

test('unresponsive endpoints time out and discovery continues', async (t) => {
  const { parent } = await workspace(t);
  const active = await runFolder(parent, 'switch2-active', await endpoint(t, 'switch2-active'), 1000);
  await runFolder(parent, 'switch2-hung', await endpoint(t, 'switch2-hung', { stall: true }), 2000);
  assert.equal(await findLiveRun(parent, { timeout: 100 }), active);
});

test('first-run prompt accepts a quoted parent folder and retries invalid input', async (t) => {
  const { parent, configFile } = await workspace(t);
  const active = await runFolder(parent, 'switch2-active', await endpoint(t, 'switch2-active'));
  const reasons = [];
  const answers = [path.join(parent, 'missing'), '"' + parent + '"'];
  const run = await resolveRun({ configFile, prompt: async ({ reason }) => { reasons.push(reason); return answers.shift(); } });
  assert.equal(run, active);
  assert.equal(reasons.length, 2);
  assert.match(reasons[1], /ENOENT/);
  assert.equal(JSON.parse(await fs.readFile(configFile)).runsDirectory, parent);
});

test('stale saved locations prompt again and can be cancelled', async (t) => {
  const { parent, configFile } = await workspace(t);
  await fs.mkdir(path.dirname(configFile));
  await fs.writeFile(configFile, JSON.stringify({ runsDirectory: parent }));
  const run = await resolveRun({ configFile, prompt: async (details) => {
    assert.equal(details.parent, parent);
    assert.match(details.reason, /No live RPC run/);
    return null;
  } });
  assert.equal(run, null);
});

test('scripts without a saved run receive an actionable error', async (t) => {
  const { configFile } = await workspace(t);
  await assert.rejects(resolveRun({ configFile }), /node yoink.cjs <run-directory>/);
});

test('lookup cancellation interrupts a pending network probe', async (t) => {
  const { parent } = await workspace(t);
  await runFolder(parent, 'switch2-hung', await endpoint(t, 'switch2-hung', { stall: true }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Cancelled lookup')), 30);
  try { await assert.rejects(findLiveRun(parent, { signal: controller.signal }), /Cancelled lookup/); }
  finally { clearTimeout(timer); }
});

test('CLI accepts no run, a standalone title ID, and explicit paths', () => {
  assert.equal(getArgs([]).run, undefined);
  assert.equal(getArgs(['0100f43008c44000']).title, '0100f43008c44000');
  assert.equal(getArgs(['0100f43008c44000']).run, undefined);
  assert.equal(getArgs(['runs']).run, path.resolve('runs'));
  assert.equal(getArgs(['runs', '0100f43008c44000']).title, '0100f43008c44000');
});
