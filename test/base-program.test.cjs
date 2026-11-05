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
  return {
    installed, updateGroups: groups, calls, headers,
    async mountView(prefix, section, candidates) {
      calls.push({ prefix, section, candidates });
      if (!candidates[0].update && section === 'romfs' && failure) throw failure;
      if (candidates[0].update && composedFailure) throw composedFailure;
      return { source: candidates[0].update ? { ...source, selection: 'update', ...patch } : source, entries: codeEntries };
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

test('zero header gets a distinct error; other malformed headers stay fatal', async () => {
  await assert.rejects(readRomfs(async () => Buffer.alloc(0x50), 11835686912), { code: 'GAME_ROMFS_ZERO_HEADER' });
  await assert.rejects(readRomfs(async () => Buffer.alloc(0x50, 1), 11835686912),
    (error) => !error.code && /Invalid RomFS/.test(error.message));
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

test('missing, skipped, different-version or different-storage companions do not enable fallback', async () => {
  for (const groups of [[], [[{ ...patch, version: 131072 }]], [[{ ...patch, storage: 4 }]]]) {
    const f = fixture({ failure: zeroHeader(), groups });
    await assert.rejects(prepareBaseProgram(f), /no selected same-version card patch/);
    assert.equal(f.calls.length, 1);
  }
});

test('nonzero corruption, digital zero headers, absent partitions and cancellation are not swallowed', async () => {
  for (const error of [new Error('Invalid RomFS: metadata extent'), zeroHeader({ ...source, storage: 4 }),
    Object.assign(new Error('absent'), { code: 'GAME_ROMFS_ABSENT' }),
    Object.assign(new Error('cancelled'), { code: 'FTP_CANCELLED' })]) {
    const f = fixture({ failure: error });
    await assert.rejects(prepareBaseProgram(f), (actual) => actual === error);
    assert.equal(f.calls.length, 1);
  }
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
