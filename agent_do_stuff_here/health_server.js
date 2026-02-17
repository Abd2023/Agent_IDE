const http = require('http');
http.createServer((req,res)=>{ if(req.url==='/health'){res.statusCode=500;res.end('db down');return;} res.statusCode=404;res.end('nf');}).listen(4101);
