const assert = require('node:assert/strict');
const { test } = require('node:test');
const { prepareBaseProgram, validateProgramEntries } = require('../engine/base-program.cjs');
const { readRomfs } = require('../engine/mounts.cjs');
const { resolveProgramContent } = require('../engine/content.cjs');

const title = '040094b02455c000';
const patch = { contentTitle: '040094b02455c800', version: 65536, storage: 2 };
const source = { metaType: 0x80, version: 65536, storage: 2, contentPath: '@Gc/base.nca' };
const installed = [4, 5, 2].map((storage) => ({ storage }));
const codeEntries = [
  { path: '/main', type: 'file', size: 0x100 },
  { path: '/main.npdm', type: 'file', size: 0x80 },
];

function fixture({ failure, groups = [[patch]], composedFailure, badCode = false } = {}) {
  const calls = [];
  const headers = [];
  const baseSource = failure?.source || source;
  return {
    title, installed, updateGroups: groups, calls, headers,
    async mountView(prefix, section, candidates) {
      calls.push({ prefix, section, candidates });
      if (!candidates[0].update && section === 'romfs' && failure) throw failure;
      if (candidates[0].update && composedFailure) throw composedFailure;
      return { source: candidates[0].update ? { metaType: 0x81, selection: 'update', ...candidates[0].update,
        storage: candidates[0].storage } : baseSource, entries: codeEntries };
    },
    async readCodeHeader(mount, filename, length) {
      assert.equal(length, 4);
      headers.push(filename);
      return Buffer.from(badCode ? 'FAIL' : filename === '/main' ? 'NSO0' : 'META');
    },
  };
}
const zeroHeader = (base = source) => Object.assign(new Error('Invalid RomFS: zero-filled header'), {
  code: 'GAME_ROMFS_ZERO_HEADER', source: base,
});

test('zero header prefix gets a distinct error even when the rest of the header contains data', async () => {
  await assert.rejects(readRomfs(async () => Buffer.alloc(0x50), 11835686912), { code: 'GAME_ROMFS_ZERO_HEADER' });
  const prefix = Buffer.alloc(0x50, 0xff);
  prefix.fill(0, 0, 16);
  await assert.rejects(readRomfs(async () => prefix, 11835686912), (error) =>
    error.code === 'GAME_ROMFS_ZERO_HEADER' && /firstU64=0x0 first16hex=00000000000000000000000000000000/.test(error.message));
  await assert.rejects(readRomfs(async () => Buffer.alloc(0x50, 1), 11835686912),
    (error) => error.code === 'GAME_ROMFS_INVALID_HEADER' && /first16hex=01010101010101010101010101010101/.test(error.message));
});

test('readable base keeps its original RomFS and ExeFS path', async () => {
  const f = fixture();
  const result = await prepareBaseProgram(f);
  assert.equal(result.composedUpdate, null);
  assert.deepEqual(f.calls.map((call) => [call.section, call.candidates]), [['romfs', installed], ['exefs', [{ storage: 2 }]]]);
  assert.deepEqual(f.headers, []);
});

test('zero-header card composes its matching patch without opening standalone base ExeFS', async () => {
  const f = fixture({ failure: zeroHeader(), groups: [[{ ...patch, storage: 4 }, patch]] });
  const result = await prepareBaseProgram(f);
  assert.equal(result.composedUpdate.contentTitle, patch.contentTitle);
  assert.equal(result.base.source.version, 65536);
  assert.equal(result.base.source.originalSource, source);
  assert.deepEqual(f.calls.map((call) => [call.prefix, call.section, Boolean(call.candidates[0].update)]),
    [['/base', 'romfs', false], ['/base', 'romfs', true], ['/base', 'exefs', true]]);
  assert.deepEqual(f.calls[1].candidates, [{ storage: 2, update: { contentTitle: patch.contentTitle, version: 65536 } }]);
  assert.deepEqual(f.headers, ['/main', '/main.npdm']);
});

test('missing, skipped or unrelated updates do not enable fallback', async () => {
  for (const groups of [[], [[{ ...patch, contentTitle: '0400999900000800' }]]]) {
    const f = fixture({ failure: zeroHeader(), groups });
    await assert.rejects(prepareBaseProgram(f), /no matching update is selected/);
    assert.equal(f.calls.length, 1);
  }
});

test('metadata corruption, non-application sources, absent partitions and cancellation are not swallowed', async () => {
  for (const error of [new Error('Invalid RomFS: metadata extent'), zeroHeader({ ...source, metaType: 0x82 }),
    zeroHeader({ ...source, selection: 'update' }),
    Object.assign(new Error('absent'), { code: 'GAME_ROMFS_ABSENT' }),
    Object.assign(new Error('cancelled'), { code: 'FTP_CANCELLED' })]) {
    const f = fixture({ failure: error });
    await assert.rejects(prepareBaseProgram(f), (actual) => actual === error);
    assert.equal(f.calls.length, 1);
  }
});

test('reported nonzero internal-storage header tries the newer selected update', async () => {
  const digitalTitle = '01002e7016c46000';
  const digitalSource = { ...source, storage: 4, version: 131072,
    contentPath: '@UserContent://registered/0000008F/0788dcf4f009b8f746fa6fa63420b95d.nca' };
  const header = Buffer.alloc(0x50);
  Buffer.from('72e1005a85d02b5d91bf9d5c40a8cecf', 'hex').copy(header);
  let failure;
  try { await readRomfs(async () => header, 759857152); } catch (error) { failure = error; }
  assert.equal(failure.code, 'GAME_ROMFS_INVALID_HEADER');
  failure.source = digitalSource;
  const update = { contentTitle: '01002e7016c46800', version: 1966080, storage: 4 };
  const f = fixture({ failure, groups: [[{ ...update, version: 65536 }], [update]] });
  f.title = digitalTitle;
  const result = await prepareBaseProgram(f);
  assert.equal(result.composedUpdate, update);
  assert.equal(result.base.source.version, 1966080);
  assert.equal(result.base.source.originalSource, digitalSource);
  assert.deepEqual(f.calls[1].candidates, [{ storage: 4, update: { contentTitle: update.contentTitle, version: update.version } }]);
  assert.deepEqual(f.headers, ['/main', '/main.npdm']);
});

test('composition accepts a selected update on another storage device', async () => {
  const digitalSource = { ...source, storage: 4 };
  const f = fixture({ failure: zeroHeader(digitalSource), groups: [[{ ...patch, version: 131072, storage: 5 }]] });
  const result = await prepareBaseProgram(f);
  assert.equal(result.base.source.storage, 5);
  assert.equal(result.base.source.originalSource.storage, 4);
  assert.equal(result.base.source.version, 131072);
});

test('a selected same-version card companion remains preferred over a newer update', async () => {
  const f = fixture({ failure: zeroHeader(), groups: [[{ ...patch, version: 131072, storage: 4 }], [patch]] });
  const result = await prepareBaseProgram(f);
  assert.equal(result.composedUpdate, patch);
  assert.equal(result.base.source.storage, 2);
});

test('failed composition or invalid composed executable headers abort preparation', async () => {
  const error = new Error('Composed RomFS is invalid');
  await assert.rejects(prepareBaseProgram(fixture({ failure: zeroHeader(), composedFailure: error })), (actual) => actual === error);
  await assert.rejects(prepareBaseProgram(fixture({ failure: zeroHeader(), badCode: true })), /invalid \/main header/);
  for (const entries of [[], [codeEntries[0]], [{ ...codeEntries[0], size: 4 }, codeEntries[1]]]) {
    await assert.rejects(validateProgramEntries(entries, async () => Buffer.from('NSO0')), /no valid/);
  }
  await assert.rejects(validateProgramEntries(codeEntries, async (filename) => Buffer.from(filename === '/main' ? 'NSO0' : 'FAIL')), /main.npdm header/);
});

test('update resolution rejects a changed version or unrelated owner before mounting', async () => {
  for (const [version, owner] of [[131072, title], [65536, '0400000000000000']]) {
    const handles = new Set();
    const key = Buffer.alloc(16);
    key.writeUInt32LE(version, 8);
    key[12] = 0x81;
    const ownerBytes = Buffer.alloc(8);
    ownerBytes.writeBigUInt64LE(BigInt('0x' + owner));
    const a = {
      title, storage: 2, update: patch, service: async () => 1,
      domain: { oneHandle(reply) { handles.add(reply.handle); return reply.handle; } },
      s: { handles, async close(handle) { handles.delete(handle); },
        async ipc(label, handle, command) {
          if (command === 5) return { result: 0, handle: 10 };
          if (command === 6) return { result: 0, data: key };
          if (command === 22) return { result: 0, data: ownerBytes };
          throw new Error('Must reject before resolving program content');
        },
      },
    };
    await assert.rejects(resolveProgramContent(a), version !== 65536 ? /version changed/ : /another application/);
    assert.equal(handles.size, 0);
  }
});
