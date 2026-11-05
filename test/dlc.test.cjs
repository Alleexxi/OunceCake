const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseDlcMetadata, matchingDlc, verifyDlcSnapshot } = require('../engine/dlc.cjs');
const { discoverDlc, discoverDataPatches, resolveDlcContent } = require('../engine/content.cjs');
const { selectDataPatch } = require('../engine/program.cjs');
const { createGameFiles } = require('../engine/mounts.cjs');

const title = '0100abcd00010000';
const addonId = '0100abcd00011001';
const patchId = '0100000000001001'; // deliberately not addonId ^ 0x800
const dataId = '0400abcd00011001';
const idBytes = (id) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt('0x' + id)); return bytes; };
const key = (id, type, version = 4) => {
  const bytes = Buffer.alloc(16); idBytes(id).copy(bytes); bytes.writeUInt32LE(version, 8); bytes[12] = type; return bytes;
};
const entry = { contentId: '12'.repeat(16), attributes: 3, contentType: 2, programIndex: 0 };
function metadata(type, { owner = title, contents = [entry], dataTitle = addonId, dataPatchTitle = patchId } = {}) {
  const extended = 0x18;
  const bytes = Buffer.alloc(8 + extended + contents.length * 24);
  bytes.writeUInt16LE(extended); bytes.writeUInt16LE(contents.length, 2);
  if (type === 0x82) { idBytes(owner).copy(bytes, 8); if (dataPatchTitle) idBytes(dataPatchTitle).copy(bytes, 24); }
  else { idBytes(dataTitle).copy(bytes, 8); idBytes(owner).copy(bytes, 16); }
  for (let i = 0; i < contents.length; i++) {
    const at = 8 + extended + i * 24;
    Buffer.from(contents[i].contentId, 'hex').copy(bytes, at);
    bytes[at + 21] = contents[i].attributes;
    bytes[at + 22] = contents[i].contentType;
    bytes[at + 23] = contents[i].programIndex;
  }
  return bytes;
}

function context() {
  const memory = Buffer.alloc(0x80000);
  const s = { base: 0x100000, bytes: memory.length, handles: new Set(), calls: [],
    async readOwned(address, size) { return Buffer.from(memory.subarray(address - this.base, address - this.base + size)); },
    async write(address, bytes) { bytes.copy(memory, address - this.base); },
    async close(handle) { this.handles.delete(handle); },
  };
  const reply = (data = Buffer.alloc(0)) => ({ result: 0, data });
  const domain = { oneHandle(result) { s.handles.add(result.handle); return result.handle; } };
  return { s, domain, root: 99, run: 'mock-run', service: async () => 1, memory, reply };
}

test('DLC metadata supplies owner, explicit patch links and all content indexes', () => {
  const meta = parseDlcMetadata(metadata(0x82, { contents: [
    { ...entry, programIndex: 3 }, { ...entry, contentType: 0 },
  ] }), 0x82);
  assert.equal(meta.owner, title);
  assert.equal(meta.dataPatchTitle, patchId);
  assert.deepEqual(meta.contents.map((item) => [item.contentType, item.programIndex]), [[0, 0], [2, 3]]);
  assert.equal(parseDlcMetadata(metadata(0x84), 0x84).dataTitle, addonId);
  assert.throws(() => parseDlcMetadata(metadata(0x82).subarray(0, 20), 0x82), /Truncated/);
});

test('patch matching uses both metadata references instead of ID arithmetic', () => {
  const patch = { contentTitle: patchId, dataTitle: addonId };
  const base = { contentTitle: addonId, dataPatchTitle: patchId };
  assert.deepEqual(matchingDlc(patch, [base, { ...base, dataPatchTitle: '0100000000002001' }]), [base]);
});

test('DLC and data-patch discovery filter unrelated owners and retain exact keys', async () => {
  for (const type of [0x82, 0x84]) {
    const a = context();
    const wanted = key(type === 0x82 ? addonId : patchId, type);
    const wrong = key('0100abcd00011002', type);
    const records = new Map([[wanted.toString('hex'), metadata(type)], [wrong.toString('hex'), metadata(type, { owner: '0100999900000000' })]]);
    a.s.ipc = async (label, handle, command, input, options) => {
      if (handle === 1 && command === 5) return input[0] === 4 ? { ...a.reply(), handle: 10 } : { result: input[0] === 5 ? 0x21005 : 0x20a05 };
      if (command === 5) {
        assert.equal(input[0], type);
        await a.s.write(options.receive[0].address, Buffer.concat([wanted, wrong]));
        const data = Buffer.alloc(8); data.writeInt32LE(2); data.writeInt32LE(2, 4); return a.reply(data);
      }
      const meta = records.get(input.toString('hex'));
      assert.ok(meta);
      if (command === 10) { const data = Buffer.alloc(4); data.writeUInt32LE(meta.length); return a.reply(data); }
      if (command === 1) { await a.s.write(options.receive[0].address, meta); return a.reply(); }
      throw new Error('Unexpected metadata command ' + command);
    };
    const recordsFound = await (type === 0x82 ? discoverDlc : discoverDataPatches)({ ...a, title });
    assert.equal(recordsFound.length, 1);
    assert.deepEqual(recordsFound[0].metaKey, wanted);
    assert.equal(recordsFound[0].dataTitle || recordsFound[0].dataPatchTitle, type === 0x82 ? patchId : addonId);
    assert.equal(a.s.handles.size, 0);
  }
});

function resolution(owner = title) {
  const a = context();
  a.s.ipc = async (label, handle, command, input) => {
    a.s.calls.push({ command, input });
    if (handle === 1 && command === 5) return { ...a.reply(), handle: 10 };
    if (handle === 1 && command === 4) return { ...a.reply(), handle: 11 };
    if (command === 22) return a.reply(idBytes(owner));
    throw new Error('Resolution must use the pinned DLC key and content, command ' + command);
  };
  a.domain.send = async (s, label, handle, wire) => {
    if (wire.readUInt32LE(24) === 8) {
      assert.deepEqual(wire.subarray(32, 48), Buffer.from(entry.contentId, 'hex'));
      await s.write(s.base + 0x3000, Buffer.from('@User/Contents/base.nca\0')); return a.reply();
    }
    assert.equal(wire.readUInt32LE(24), 618);
    return a.reply(idBytes(dataId));
  };
  return a;
}

test('DLC resolution pins its version and content, including nonzero Data indexes', async () => {
  const a = resolution();
  const metaKey = key(addonId, 0x82, 7);
  const dlc = { contentTitle: addonId, version: 7, metaKey, contents: [{ ...entry, programIndex: 3 }], dataPatchTitle: patchId };
  const source = await resolveDlcContent({ ...a, title, storage: 4, dlc });
  assert.equal(source.version, 7);
  assert.equal(source.programIndex, 3);
  assert.equal(source.runtimeProgramId, dataId);
  assert.equal(source.dataPatchTitle, patchId);
  assert.deepEqual(a.s.calls.find((call) => call.command === 22).input, metaKey);
  assert.equal(a.s.handles.size, 0);
});

test('DLC resolution rejects a mismatched application owner and closes its database', async () => {
  const a = resolution('0100999900000000');
  await assert.rejects(resolveDlcContent({ ...a, title, storage: 4,
    dlc: { contentTitle: addonId, metaKey: key(addonId, 0x82), contents: [entry] } }), /another application/);
  assert.equal(a.s.handles.size, 0);
});

test('mounting a DLC selects its metadata Data index instead of assuming index zero', async () => {
  const a = resolution();
  const send = a.domain.send;
  a.domain.send = async (s, label, handle, wire) => wire.readUInt32LE(24) === 206
    ? { ...a.reply(), handle: 12 } : send(s, label, handle, wire);
  const ipc = a.s.ipc;
  a.s.ipc = async (label, handle, command, ...args) => {
    if (handle === 12 && command === 4) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(1024n); return a.reply(bytes); }
    return ipc(label, handle, command, ...args);
  };
  const files = createGameFiles(a);
  const mounted = await files.open({ title, storage: 4,
    dlc: { contentTitle: addonId, metaKey: key(addonId, 0x82), contents: [{ ...entry, programIndex: 3 }] } });
  assert.equal(mounted.source.programIndex, 3);
  await files.close(mounted);
  assert.equal(a.s.handles.size, 0);
});

test('snapshot check rejects changed DLC versions or content before FTP starts', async () => {
  const source = { contentTitle: addonId, metaKey: key(addonId, 0x82), ...entry, programIndex: 3 };
  const s = { ipc: async (label, database, command, input) => {
    assert.equal(command, 20); assert.equal(input[1], 3);
    return { result: 0, data: Buffer.from(entry.contentId, 'hex') };
  } };
  await verifyDlcSnapshot({ s, database: 10, latestKey: source.metaKey, sources: [source] });
  await assert.rejects(verifyDlcSnapshot({ s, database: 10, latestKey: key(addonId, 0x82, 99), sources: [source] }), /DLC changed/);
  s.ipc = async () => ({ result: 0, data: Buffer.alloc(16) });
  await assert.rejects(verifyDlcSnapshot({ s, database: 10, latestKey: source.metaKey, sources: [source] }), /content changed/);
});

function patchContext({ previous = 'none', failRemove = false } = {}) {
  const a = context();
  const source = { contentTitle: patchId, dataTitle: addonId, contentPath: '@User/patch.nca', attributes: 2,
    originalSource: { contentTitle: addonId, runtimeProgramId: dataId, dataPatchTitle: patchId, contentPath: '@User/base.nca', attributes: 1 } };
  a.s.ipc = async (label, handle, command, input) => {
    a.s.calls.push({ label, command, input: Buffer.from(input || []) });
    if (command === 3) return { ...a.reply(), handle: 10 };
    if (command === 5) {
      assert.deepEqual(input, idBytes(dataId));
      if (previous === 'none') return { result: 0xe08 };
      await a.s.write(a.s.base + 0x4800, Buffer.from('@User/old-base.nca\0'));
      await a.s.write(a.s.base + 0x4c00, Buffer.from(previous === 'two' ? '@User/old-patch.nca\0' : '\0'));
      return a.reply(Buffer.alloc(32, 1));
    }
    if (command === 4) return failRemove ? { result: 0xe08 } : a.reply();
    if (command === 7 || command === 6) { assert.deepEqual(input.subarray(0, 8), idBytes(dataId)); return a.reply(); }
    throw new Error('Unexpected DLC resolver command ' + command);
  };
  return { a, source };
}

test('patch mounting uses the NCA data ID and unregisters its temporary owner', async () => {
  const { a, source } = patchContext();
  assert.equal(await selectDataPatch({ attachment: a, title, source, operation: ({ addonId }) => addonId }), dataId);
  const registered = a.s.calls.find((call) => call.command === 7);
  const removed = a.s.calls.find((call) => call.command === 4);
  assert.deepEqual(registered.input.subarray(8, 16), removed.input);
  assert.equal(a.s.handles.size, 0);
});

test('patch cleanup restores previous single-path and two-path registrations after mount failure', async () => {
  for (const previous of ['one', 'two']) {
    const { a, source } = patchContext({ previous });
    await assert.rejects(selectDataPatch({ attachment: a, title, source, operation: () => { throw new Error('mount failed'); } }), /mount failed/);
    const restore = a.s.calls.at(-1);
    assert.equal(restore.command, previous === 'one' ? 6 : 7);
    assert.deepEqual(restore.input.subarray(8, 16), idBytes(title));
    assert.equal(a.s.handles.size, 0);
  }
});

test('cleanup still restores the prior registration if removing the temporary owner fails', async () => {
  const { a, source } = patchContext({ previous: 'two', failRemove: true });
  await assert.rejects(selectDataPatch({ attachment: a, title, source, operation: () => true }), /UnregisterApplicationAddOnContent/);
  assert.equal(a.s.calls.at(-1).command, 7);
  assert.equal(a.s.handles.size, 0);
});
