// DLC metadata handling adapted from misshexa66/OunceCake commit 9a5e8c0.
// https://github.com/misshexa66/OunceCake/commit/9a5e8c0b11f4c75b8553c2ee641c6225af80ec5b
const { success } = require('./protocol.cjs');

function parseDlcMetadata(meta, metaType) {
  if (!Buffer.isBuffer(meta) || meta.length < 8 || ![0x82, 0x84].includes(metaType)) {
    throw new Error('Invalid DLC metadata');
  }
  const extendedSize = meta.readUInt16LE();
  const count = meta.readUInt16LE(2);
  const contentAt = 8 + extendedSize;
  if (extendedSize < (metaType === 0x84 ? 16 : 8) || contentAt + count * 24 > meta.length) {
    throw new Error('Truncated DLC metadata');
  }
  const id = (at) => meta.readBigUInt64LE(at).toString(16).padStart(16, '0');
  const contents = [];
  for (let i = 0; i < count; i++) {
    const info = meta.subarray(contentAt + i * 24, contentAt + (i + 1) * 24);
    contents.push({ contentId: info.subarray(0, 16).toString('hex'), attributes: info[21] & 15,
      contentType: info[22], programIndex: info[23] });
  }
  const result = { owner: id(metaType === 0x82 ? 8 : 16),
    contents: contents.sort((a, b) => a.programIndex - b.programIndex || a.contentType - b.contentType) };
  if (metaType === 0x84) {
    result.dataTitle = id(8);
    if (result.dataTitle === '0000000000000000') throw new Error('DLC patch has no original DLC ID');
  } else if (extendedSize >= 0x18 && meta.readBigUInt64LE(24)) result.dataPatchTitle = id(24);
  return result;
}

function matchingDlc(patch, records) {
  return records.filter((record) => record.contentTitle === patch.dataTitle &&
    (!record.dataPatchTitle || record.dataPatchTitle === patch.contentTitle));
}

async function verifyDlcSnapshot({ s, database, latestKey, sources }) {
  for (const source of sources) {
    if (!source.metaKey || !latestKey.equals(source.metaKey)) throw new Error('Installed DLC changed: ' + source.contentTitle);
    const input = Buffer.alloc(24);
    input[0] = source.contentType;
    input[1] = source.programIndex || 0;
    source.metaKey.copy(input, 8);
    const content = success(await s.ipc('FTP pin DLC content', database, 20, input), 'FTP pin DLC content');
    if (!content.data.subarray(0, 16).equals(Buffer.from(source.contentId, 'hex'))) {
      throw new Error('Installed DLC content changed: ' + source.contentTitle);
    }
  }
}

module.exports = { parseDlcMetadata, matchingDlc, verifyDlcSnapshot };
