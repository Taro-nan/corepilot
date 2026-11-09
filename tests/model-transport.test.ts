import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { createModelTransport } from '../src/model/model-transport.js';

test('model proxy uses its own tunnel and leaves ordinary requests direct', async () => {
  const received: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const target = http.createServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: ['fixture'] }));
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress !== 'string');

  const tunnels: string[] = [];
  const sockets = new Set<net.Socket>();
  const proxy = http.createServer();
  proxy.on('connect', (request, client, head) => {
    tunnels.push(request.url ?? '');
    const upstream = net.connect(targetAddress.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(client); sockets.add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  const transport = createModelTransport(`http://127.0.0.1:${proxyAddress.port}`);
  const direct = createModelTransport();
  const origin = `http://127.0.0.1:${targetAddress.port}`;
  try {
    const proxied = await transport.fetch(`${origin}/v1/models`, { headers: { authorization: 'Bearer fixture' } });
    assert.deepEqual(await proxied.json(), { models: ['fixture'] });
    assert.deepEqual(tunnels, [`127.0.0.1:${targetAddress.port}`]);
    assert.deepEqual(received[0], { url: '/v1/models', authorization: 'Bearer fixture' });

    const ordinary = await direct.fetch(`${origin}/health`);
    await ordinary.json();
    assert.equal(tunnels.length, 1, 'ordinary requests must not use the model proxy');
    assert.equal(received[1]?.url, '/health');
    assert.throws(() => createModelTransport('ftp://127.0.0.1:21'), /model\.proxy must use/);
  } finally {
    await transport.close();
    await direct.close();
    for (const socket of sockets) socket.destroy();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>(resolve => target.close(() => resolve())),
      new Promise<void>(resolve => proxy.close(() => resolve())),
    ]);
  }
});
