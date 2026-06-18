// Tiny zero-dependency static server for the Planfect support page.
// Railway sets PORT; the support email is injected from SUPPORT_EMAIL (set it in Railway,
// so the address never lives in the repo).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.SUPPORT_EMAIL || 'support@planfect.app';
const html = fs
  .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace(/__SUPPORT_EMAIL__/g, EMAIL);

http
  .createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  })
  .listen(PORT, () => console.log(`Planfect support site listening on ${PORT}`));
