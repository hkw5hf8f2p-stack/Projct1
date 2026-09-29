// Dependency-free static server: node server.mjs [port]. Serves files by path, ignoring the query string.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)); const port=+process.argv[2]||4402;
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
http.createServer((q,r)=>{let p=decodeURIComponent(new URL(q.url,'http://x').pathname);let f=path.join(root,p);
if(!f.startsWith(root)){r.writeHead(403).end();return}
if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,'index.html');
if(!fs.existsSync(f)){r.writeHead(404).end('not found');return}
r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(r)}).listen(port,()=>console.log('twin2 on '+port));
