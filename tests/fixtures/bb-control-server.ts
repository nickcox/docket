import { createServer } from 'node:http';

// Separate event loop: idle sockets close even while the test client blocks.
let nextConnection = 0;
let resets = 0;
const connections = new WeakMap<object, number>();
const server = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    if (request.url === '/reset') {
      resets++;
      request.socket.destroy();
      return;
    }
    // Advertise a longer lifetime than the real idle timeout, as in the
    // supervisor's reproduction of plugin installation blocking the client.
    response.setHeader('Keep-Alive', 'timeout=60');
    response.end(JSON.stringify({
      method: request.method, path: request.url, connection: request.headers.connection,
      connectionId: connections.get(request.socket), resets,
      authenticated: request.headers['x-bb-plugin-token'] === 'test-token',
    }));
  });
});
server.keepAliveTimeout = 100;
server.keepAliveTimeoutBuffer = 0;
server.on('connection', socket => { connections.set(socket, ++nextConnection); });
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ port: address.port });
});
process.on('disconnect', () => { server.closeAllConnections(); server.close(); });
