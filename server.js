const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'gui.html'));
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  res.end(html);
}).listen(port, () => console.log('ROdemoRO → localhost:' + port));
