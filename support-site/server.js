// Tiny zero-dependency static server for the Planfect support page.
// Railway sets PORT; the support email is injected from SUPPORT_EMAIL (set it in Railway,
// so the address never lives in the repo).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.SUPPORT_EMAIL || 'support@planfect.app';
const page = (file) =>
  fs.readFileSync(path.join(__dirname, 'public', file), 'utf8').replace(/__SUPPORT_EMAIL__/g, EMAIL);
const support = page('index.html');
const privacy = page('privacy.html');
const showcase = page('showcase.html');

http
  .createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    // Static screenshots (served by us, so the showcase doesn't depend on the GitHub repo being
    // public). Read as binary; reject anything that escapes public/screenshots.
    if (url.startsWith('/screenshots/')) {
      const rel = path.normalize(url).replace(/^(\.\.(\/|\\|$))+/, '');
      const fp = path.join(__dirname, 'public', rel);
      const root = path.join(__dirname, 'public', 'screenshots');
      if (fp !== root && !fp.startsWith(root + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('forbidden');
      }
      return fs.readFile(fp, (err, buf) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          return res.end('not found');
        }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        res.end(buf);
      });
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(url === '/privacy' ? privacy : url === '/showcase' ? showcase : support);
  })
  .listen(PORT, () => console.log(`Planfect support site listening on ${PORT}`));
