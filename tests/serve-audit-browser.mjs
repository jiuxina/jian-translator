/* Isolated manual browser fixture: only repository web assets and synthetic I/O. */
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const port = Number(process.argv[2] || 8898);
const events = [];
const types = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (url.pathname === '/__audit/evidence' && request.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      events.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/__audit/report') {
      const report = { synthetic: true, browser: 'Codex internal browser', events };
      const output = path.join(root, '.build/audit-internal-browser');
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'events.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' }).end(JSON.stringify(report));
      return;
    }
    let file;
    if (url.pathname === '/__audit/fixture.js') file = path.join(root, 'tests/audit-browser-fixture.js');
    else if (url.pathname === '/__audit/controls') file = path.join(root, 'tests/audit-browser-controls.html');
    else {
      file = path.resolve(webRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      const relative = path.relative(webRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
    }
    let bytes = await readFile(file);
    if (file === path.join(webRoot, 'index.html')) {
      bytes = Buffer.from(bytes.toString('utf8').replace('<head>', '<head><script src="/__audit/fixture.js"></script>'));
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(bytes);
  } catch (error) {
    response.writeHead(404).end('Synthetic fixture resource unavailable');
  }
}).listen(port, '127.0.0.1', () => console.log(`Synthetic audit fixture: http://127.0.0.1:${port}/?debug=1`));
