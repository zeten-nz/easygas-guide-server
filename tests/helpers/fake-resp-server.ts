/**
 * Tiny in-process RESP server for tests that need a REAL ioredis client talking
 * over a REAL socket without a Redis installation: it answers INFO (ready check),
 * PING and anything else with +OK, and counts accepted TCP connections so a test
 * can prove how many connects a code path actually opened. Not a Redis
 * implementation — no data commands.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface FakeRespServer {
  readonly url: string;
  /** Number of TCP connections accepted so far. */
  connections(): number;
  close(): Promise<void>;
}

const COMMAND = /\*(\d+)\r\n((?:\$\d+\r\n[^\r]*\r\n)+)/g;

export async function startFakeRespServer(opts: { acceptDelayMs?: number } = {}): Promise<FakeRespServer> {
  let accepted = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (buf) => {
      const text = buf.toString('utf8');
      for (const m of text.matchAll(COMMAND)) {
        const name = (m[2].split('\r\n')[1] ?? '').toUpperCase();
        const reply =
          name === 'PING'
            ? '+PONG\r\n'
            : name === 'INFO'
              ? `$${'# Server\r\nredis_version:7.0.0\r\nloading:0\r\n'.length}\r\n# Server\r\nredis_version:7.0.0\r\nloading:0\r\n\r\n`
              : '+OK\r\n';
        if (opts.acceptDelayMs) {
          const t = setTimeout(() => socket.write(reply), opts.acceptDelayMs);
          t.unref(); // a delayed reply must never keep the test process alive
          socket.once('close', () => clearTimeout(t));
        } else socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `redis://127.0.0.1:${port}`,
    connections: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
