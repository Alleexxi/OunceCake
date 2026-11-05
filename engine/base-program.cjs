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
      throw new Error('The base game could not be read on its own, and no selected same-version card patch is available. Yoink needs the matching update on this game card to try combining them.', { cause: error });
    }

    const candidates = companion.filter((item) => item.storage === source.storage).map((item) => ({
      storage: item.storage,
      update: { contentTitle: item.contentTitle, version: item.version },
    }));
    console.log('The base game could not be read on its own.');
    console.log('Asking the Switch to combine it with the update on this game card. This may take a while.');
    if (process.env.YOINK_TRACE || process.env.OZ_TRACE) {
      console.log('  [trace] Card update: ' + companion[0].contentTitle + ' v' + source.version);
      console.log('  [trace] Base NCA: ' + source.contentPath);
    }
    base = await mountView('/base', 'romfs', candidates);
    base.source.originalSource = source;
    const code = await mountView('/base', 'exefs', candidates.filter((item) => item.storage === base.source.storage));
    code.source.originalSource = source;
    await validateProgramEntries(code.entries, (filename, size) => readCodeHeader(code, filename, size));
    console.log('Base game + card update opened and checked successfully. Yoink will dump the combined game files.');
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
