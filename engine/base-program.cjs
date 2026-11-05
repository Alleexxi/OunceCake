// Some cards store a sparse base alongside a same-version patch. Only the composed
// program is a complete filesystem; do not publish the unreadable standalone base.
async function prepareBaseProgram({ mountView, installed, updateGroups, readCodeHeader }) {
  let base;
  try {
    base = await mountView('/base', 'romfs', installed, true);
  } catch (error) {
    const source = error.source;
    if (error.code !== 'GAME_ROMFS_ZERO_HEADER' || source?.metaType !== 0x80 || source.storage !== 2) throw error;

    const companion = updateGroups.find((group) => group.some((item) =>
      item.storage === source.storage && item.version === source.version));
    if (!companion) {
      throw new Error('Game-card base has a zero-filled RomFS header, but no selected same-version card patch is available.', { cause: error });
    }

    const candidates = companion.filter((item) => item.storage === source.storage).map((item) => ({
      storage: item.storage,
      update: { contentTitle: item.contentTitle, version: item.version },
    }));
    console.log('Base RomFS has a zero-filled header; trying composed game-card program with patch ' +
      companion[0].contentTitle + ' v' + source.version + '.');
    console.log('  Base NCA: ' + source.contentPath);
    base = await mountView('/base', 'romfs', candidates);
    base.source.originalSource = source;
    const code = await mountView('/base', 'exefs', candidates.filter((item) => item.storage === base.source.storage));
    code.source.originalSource = source;
    await validateProgramEntries(code.entries, (filename, size) => readCodeHeader(code, filename, size));
    console.log('Composed game-card RomFS and ExeFS validated; exporting them as the base package.');
    return { base, composedUpdate: companion[0] };
  }

  await mountView('/base', 'exefs', installed.filter((item) => item.storage === base.source.storage));
  return { base, composedUpdate: null };
}

async function validateProgramEntries(entries, readHeader) {
  for (const [filename, magic, minimum] of [['/main', 'NSO0', 0x100], ['/main.npdm', 'META', 0x80]]) {
    const file = entries.find((item) => item.path === filename && item.type === 'file');
    if (!file || file.size < minimum) throw new Error('Composed ExeFS has no valid ' + filename);
    const header = await readHeader(filename, 4);
    if (header.toString('ascii') !== magic) throw new Error('Composed ExeFS has an invalid ' + filename + ' header');
  }
}

module.exports = { prepareBaseProgram, validateProgramEntries };
