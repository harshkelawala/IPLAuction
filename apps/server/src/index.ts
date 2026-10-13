import { createServer } from 'node:http';
import { createGameServer } from './server.js';

const port = Number(process.env.PORT ?? 4000);
const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',');

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});

createGameServer(http, { corsOrigin: origin });
http.listen(port, () => console.log(`IPL auction server on http://localhost:${port} (web origin ${origin.join(', ')})`));
