// Local preview: serve edited assets against the existing RamCraft API.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, 'panel/static');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml'};
http.createServer((req,res) => {
  if (req.url.startsWith('/api/')) {
    const upstream = http.request({hostname:'192.168.1.63',port:8110,path:req.url,method:req.method,headers:{...req.headers,host:'192.168.1.63:8110'}}, r => {res.writeHead(r.statusCode, {...r.headers,'cache-control':'no-store'});r.pipe(res);});
    upstream.on('error', () => {if (!res.headersSent) res.writeHead(502);res.end('Panel unavailable');});
    req.pipe(upstream); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname); } catch {res.writeHead(400);return res.end();}
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) {res.writeHead(403);return res.end();}
  fs.readFile(file,(err,data) => {if (err) {res.writeHead(404);return res.end();} res.writeHead(200,{'content-type':types[path.extname(file)] || 'application/octet-stream','cache-control':'no-store'});res.end(data);});
}).listen(8111,'127.0.0.1',()=>console.log('RamCraft preview: http://127.0.0.1:8111'));
