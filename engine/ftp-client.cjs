const net = require('node:net');

// tiny ftp client, just enough to pull files back off our own server

const REPLY_TIMEOUT = 60000;
const DONE_TIMEOUT = 30000; // how long to wait for "226" once all the data is in
const NOOP_EVERY = 30000;
// how long a data connection may sit without a byte before it's treated as stalled and resumed.
// composed update RomFS reads on slow storage can pause for minutes; YOINK_STALL_SECONDS overrides it
const STALL_TIMEOUT = (Number(process.env.YOINK_STALL_SECONDS) || 300) * 1000;
const RESUME_ATTEMPTS = Number(process.env.YOINK_RESUME_ATTEMPTS ?? 5);

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);
    socket.setTimeout(30000, () => socket.destroy(new Error('Timed out connecting to ' + host + ':' + port)));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeAllListeners('timeout');
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

const timedOut = (what) => Object.assign(new Error('Timed out waiting for the FTP server to answer ' + what), {
  code: 'FTP_TIMEOUT',
});

class FtpClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
  }

  static async open(host, port) {
    const client = new FtpClient(host, port);
    try {
      await client.reconnect();
      return client;
    } catch (error) {
      client.socket?.destroy();
      throw error;
    }
  }

  // the control connection sits idle for the whole of a big transfer and wsl/windows networking
  // has been seen silently dropping it, so we can swap in a fresh one when that happens
  async reconnect() {
    this.socket?.destroy();
    const socket = await connect(this.host, this.port);

    this.socket = socket;
    this.input = '';
    this.replies = [];
    this.waiting = [];
    this.failure = null;
    this.current = null;
    this.noops = 0;

    socket.setKeepAlive(true, 15000);
    socket.setEncoding('utf8');
    socket.on('data', (part) => this.socket === socket && this.receive(part));
    socket.on('error', (error) => this.socket === socket && this.fail(error));
    socket.on('close', () => this.socket === socket && this.fail(new Error('FTP control connection closed')));

    await this.expect(null, [220]);
    await this.expect('TYPE I', [200]);
  }

  receive(part) {
    this.input += part;
    let end;

    while ((end = this.input.indexOf('\n')) >= 0) {
      const line = this.input.slice(0, end).replace(/\r$/, '');
      this.input = this.input.slice(end + 1);

      // multi line replies look like "211-..." up to "211 ..."
      if (this.current) {
        this.current.lines.push(line);
        if (line.startsWith(this.current.code + ' ')) this.finish(this.current);
        continue;
      }

      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) continue;

      const reply = { code: Number(match[1]), lines: [line] };
      if (match[2] === '-') this.current = reply;
      else this.finish(reply);
    }
  }

  finish(reply) {
    this.current = null;
    reply.text = reply.lines.join('\n');

    // answers to our keepalive NOOPs, they show up after the transfer's own reply
    if (this.noops && reply.code === 200) {
      this.noops--;
      return;
    }

    const next = this.waiting.shift();
    if (next) next.resolve(reply);
    else this.replies.push(reply);
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const next of this.waiting.splice(0)) next.reject(error);
  }

  reply(what, timeout = REPLY_TIMEOUT) {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.failure) return Promise.reject(this.failure);

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(timedOut(what));
      }, timeout);
      this.waiting.push(waiter);
    });
  }

  async expect(command, codes, timeout) {
    if (command !== null) this.socket.write(command + '\r\n');
    const reply = await this.reply(command || 'the greeting', timeout);

    if (!codes.includes(reply.code)) {
      throw new Error('FTP ' + (command || 'greeting') + ' failed: ' + reply.text);
    }

    return reply;
  }

  // streams a file through onChunk (awaited, so slow consumers slow the transfer down instead of eating ram).
  // a data connection that goes quiet or drops early is resumed where it stopped with REST on a fresh
  // control connection, so one hiccup in a multi-gigabyte image doesn't throw the whole dump away
  async retrieve(filename, size, onChunk) {
    let received = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        received = await this.transfer(filename, size, received, onChunk);
      } catch (error) {
        if (!error.resumable || attempt >= RESUME_ATTEMPTS) throw error;
        received = error.received;
        console.warn('\n  (' + error.message + '; resuming at byte ' + received + ', attempt ' +
          (attempt + 1) + '/' + RESUME_ATTEMPTS + ')');
        const delay = Number(process.env.YOINK_RESUME_DELAY_MS ?? 1000);
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay * 2 ** attempt, 15 * delay)));
        await this.reconnect();
        continue;
      }
      return;
    }
  }

  async transfer(filename, size, offset, onChunk) {
    let received = offset;
    // anything that isn't our own consumer failing or the server refusing the file can be picked up again
    const resumable = (error) => Object.assign(error, { resumable: true, received });

    let data;
    try {
      const passive = await this.expect('EPSV', [229]);
      const port = Number(/\(\|\|\|(\d+)\|\)/.exec(passive.text)?.[1]);
      if (!port) throw new Error('FTP EPSV reply was not understood: ' + passive.text);
      data = await connect(this.host, port);
      if (offset) await this.expect('REST ' + offset, [350]);
    } catch (error) {
      data?.destroy();
      throw error.code === 'FTP_TIMEOUT' || this.failure || error.syscall ? resumable(error) : error;
    }

    data.on('error', () => {}); // surfaces through the for await below instead
    let stalled = false;
    data.setTimeout(STALL_TIMEOUT, () => {
      stalled = true;
      data.destroy(new Error('FTP data connection stalled on ' + filename));
    });

    let keepalive;
    try {
      await this.expect('RETR ' + filename, [150]);

      // the server only reads these once the transfer is done, but they keep the connection alive
      keepalive = setInterval(() => {
        this.noops++;
        this.socket.write('NOOP\r\n');
      }, NOOP_EVERY);

      try {
        for await (const chunk of data) {
          if (received + chunk.length > size) throw new Error('FTP sent more data than expected for ' + filename);
          await onChunk(chunk);
          received += chunk.length;
        }
      } catch (error) {
        if (stalled || error.syscall) throw resumable(error);
        throw error;
      }
    } finally {
      clearInterval(keepalive);
      data.destroy();
    }

    if (received !== size) {
      throw resumable(new Error('FTP transfer of ' + filename + ' was short: ' + received + ' of ' + size + ' bytes'));
    }

    try {
      await this.expect(null, [226], DONE_TIMEOUT);
    } catch (error) {
      // every byte made it, so only the control connection died. carry on with a new one
      if (error.code !== 'FTP_TIMEOUT' && !this.failure) throw error;
      console.warn('\n  (FTP control connection went quiet after ' + filename + ', reconnecting)');
      await this.reconnect();
    }

    return received;
  }

  async close() {
    if (this.failure) return this.socket.destroy();

    try {
      this.socket.write('QUIT\r\n');
      await this.reply('QUIT', 1000);
    } catch {}

    this.socket.destroy();
  }
}

module.exports = { FtpClient };
