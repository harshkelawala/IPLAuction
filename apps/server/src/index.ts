import { createServer } from 'node:http';
import { createGameServer } from './server';

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

// TIME_SCALE < 1 speeds every timer up, for testing (e.g. 0.05 runs a game in about a minute).
const timeScale = process.env.TIME_SCALE ? Number(process.env.TIME_SCALE) : undefined;
createGameServer(http, { corsOrigin: origin, timeScale });
http.listen(port, () => console.log(`IPL auction server on http://localhost:${port} (web origin ${origin.join(', ')})`));
