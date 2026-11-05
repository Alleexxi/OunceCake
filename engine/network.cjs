const { success, withCleanup, closeHandles } = require('./protocol.cjs');

// Ask the connected console, so discovery also works when the PC runs inside WSL.
// IPC layout: https://github.com/switchbrew/libnx/blob/master/nx/source/services/nifm.c
async function getConsoleIp({ s, domain, service }) {
  let general;
  return withCleanup(async () => {
    const nifm = await service('nifm:u');
    general = domain.oneHandle(success(await s.ipc(
      'Open console network information', nifm, 5, Buffer.alloc(8), { pid: true },
    ), 'Open console network information'));
    const reply = success(await s.ipc('Get console IP address', general, 12), 'Get console IP address');
    const address = reply.data.subarray(0, 4);
    if (address.length !== 4 || address.every((byte) => byte === 0)) {
      throw new Error('The console has no IPv4 address');
    }
    return [...address].join('.');
  }, () => closeHandles(s, general ? [general] : []));
}

module.exports = { getConsoleIp };
