// A base storage may not expose a standalone RomFS. Try the selected application
// update through FS instead, and only publish the composed result after validation.
async function prepareBaseProgram({ title, mountView, installed, updateGroups, readCodeHeader }) {
  let base;
  try {
    base = await mountView('/base', 'romfs', installed, true);
  } catch (error) {
    const source = error.source;
    if (!['GAME_ROMFS_ZERO_HEADER', 'GAME_ROMFS_INVALID_HEADER'].includes(error.code) ||
        source?.metaType !== 0x80 || source.selection) throw error;

    const patchTitle = (BigInt('0x' + title) + 0x800n).toString(16).padStart(16, '0');
    const matching = updateGroups
      .filter((group) => group[0].contentTitle === patchTitle)
      .sort((a, b) => b[0].version - a[0].version);
    // Preserve the confirmed same-version card path when its companion is selected.
    const companion = source.storage === 2 && matching.find((group) => group.some((item) =>
      item.storage === source.storage && item.version === source.version));
    const selected = companion || matching[0];
    if (!selected) {
      throw new Error('The base game could not be read on its own, and no matching update is selected. ' +
        'Yoink needs an available update for this game to try combining them.\n' + error.message, { cause: error });
    }

    const candidates = (companion ? selected.filter((item) => item.storage === source.storage) : selected).map((item) => ({
      storage: item.storage,
      update: { contentTitle: item.contentTitle, version: item.version },
    }));
    console.log('The base game could not be read on its own.');
    console.log('Asking the Switch to combine it with its ' +
      (companion ? 'game-card update' : 'selected update') + '. This may take a while.');
    if (process.env.YOINK_TRACE || process.env.OZ_TRACE) {
      console.log('  [trace] Selected update: ' + selected[0].contentTitle + ' v' + selected[0].version);
      console.log('  [trace] Base NCA: ' + source.contentPath);
      console.log('  [trace] Standalone base error: ' + error.message);
    }
    base = await mountView('/base', 'romfs', candidates);
    base.source.originalSource = source;
    const code = await mountView('/base', 'exefs', candidates.filter((item) => item.storage === base.source.storage));
    code.source.originalSource = source;
    await validateProgramEntries(code.entries, (filename, size) => readCodeHeader(code, filename, size));
    console.log('Base game + update opened and checked successfully. Yoink will dump the combined game files.');
    return { base, composedUpdate: selected[0] };
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
