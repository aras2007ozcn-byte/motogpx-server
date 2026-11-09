/* MotoGPX oyun sunucusu - bağımlılıksız (sadece Node 18+). Oda tabanlı konum aktarıcı.
   Çalıştır:  node server.js        (PORT, ALLOWED_ORIGINS, PUBLIC_DIR ortam değişkenleri isteğe bağlı)
   Uç noktalar:  GET /health   ·   WebSocket /ws   ·   (varsa) ./public klasöründeki site dosyaları

   Protokol (JSON metin çerçeveleri)
     istemci -> sunucu   {t:'join', room, max, v:1}        ilk mesaj; oda adı [a-z0-9_]{1,24}
                         {t:'p', d:{n,b,c,t,x,z,y,l,v,m,mi}} konum/durum yaması
                         {t:'ping', c}                      gecikme ölçümü
     sunucu -> istemci   {t:'hi', id, max, n}               katıldı
                         {t:'full'} / {t:'err', m}          reddedildi (ardından bağlantı kapanır)
                         {t:'s', ts, p:{id:durum,...}}      oda anlık görüntüsü (≈10 kez/sn, değişince)
                         {t:'pong', c}                      */
'use strict';
var http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

var PORT = +process.env.PORT || 8080;
var ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
var PUBLIC = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
var MAX_PER_IP = +process.env.MAX_PER_IP || 12;
var MAX_ROOMS = +process.env.MAX_ROOMS || 500;
var TICK_MS = 100, PING_MS = 10000, DEAD_MS = 30000, MAX_FRAME = 4096, RATE = 40, IDLE_JOIN_MS = 10000;
var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

var rooms = Object.create(null), clients = 0, started = Date.now(), perIp = Object.create(null);

function log() { if (process.env.QUIET !== '1') console.log.apply(console, [new Date().toISOString()].concat([].slice.call(arguments))); }
function clean(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, n); }
function num(v, a, b) { v = +v; return isFinite(v) ? Math.max(a, Math.min(b, v)) : null; }

/* ---------- WebSocket çerçeveleme (RFC 6455, gereken kadar) ---------- */
function frame(op, payload) {
  var len = payload.length, head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | op; return Buffer.concat([head, payload]);
}
function Conn(sock) {
  this.sock = sock; this.buf = Buffer.alloc(0); this.alive = Date.now(); this.closed = false; this.frag = null;
  this.onmsg = null; this.onclose = null;
  var self = this;
  sock.on('data', function (d) { self.buf = Buffer.concat([self.buf, d]); self.parse(); });
  sock.on('close', function () { self.finish(); }); sock.on('error', function () { self.finish(); });
  sock.setNoDelay(true);
}
Conn.prototype.finish = function () { if (this.closed) return; this.closed = true; try { this.sock.destroy(); } catch (e) {} if (this.onclose) this.onclose(); };
Conn.prototype.send = function (obj) { if (this.closed) return; var s = typeof obj === 'string' ? obj : JSON.stringify(obj); try { this.sock.write(frame(1, Buffer.from(s))); } catch (e) {} };
Conn.prototype.ping = function () { if (!this.closed) try { this.sock.write(frame(9, Buffer.alloc(0))); } catch (e) {} };
Conn.prototype.close = function (code) { if (this.closed) return; var b = Buffer.alloc(2); b.writeUInt16BE(code || 1000, 0); try { this.sock.write(frame(8, b)); } catch (e) {} var s = this; setTimeout(function () { s.finish(); }, 200); };
Conn.prototype.parse = function () {
  for (;;) {
    var b = this.buf; if (b.length < 2) return;
    var fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80), len = b[1] & 0x7f, off = 2;
    if (!masked) return this.close(1002);
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2) !== 0) return this.close(1009); len = b.readUInt32BE(6); off = 10; }
    if (len > MAX_FRAME) return this.close(1009);
    if (b.length < off + 4 + len) return;
    var mask = b.slice(off, off + 4), data = Buffer.from(b.slice(off + 4, off + 4 + len));
    for (var i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    this.buf = b.slice(off + 4 + len); this.alive = Date.now();
    if (op === 8) return this.close(1000);
    if (op === 9) { try { this.sock.write(frame(10, data)); } catch (e) {} continue; }
    if (op === 10) continue;
    if (op === 0 || op === 1) {
      if (op === 1) this.frag = data; else if (this.frag) { this.frag = Buffer.concat([this.frag, data]); if (this.frag.length > MAX_FRAME) return this.close(1009); } else return this.close(1002);
      if (fin) { var txt = this.frag.toString('utf8'); this.frag = null; if (this.onmsg) this.onmsg(txt); }
    } else return this.close(1003);
    if (this.closed) return;
  }
};

/* ---------- odalar ---------- */
function getRoom(name, max) {
  var r = rooms[name];
  if (!r) { if (Object.keys(rooms).length >= MAX_ROOMS) return null; r = rooms[name] = { name: name, max: max, peers: Object.create(null), n: 0, dirty: false, created: Date.now() }; }
  return r;
}
function leave(c) {
  var r = c.room; if (!r) return; c.room = null;
  if (r.peers[c.id]) { delete r.peers[c.id]; r.n--; r.dirty = true; r.gone = true; }
  if (r.n <= 0) delete rooms[r.name];
}
function sanitize(d, st) {
  if (!d || typeof d !== 'object') return;
  var v;
  if ('n' in d) st.n = clean(d.n, 18);
  if ('b' in d) st.b = d.b === 'gsx' || d.b === 'mt09' || d.b === 'cbr650r' || d.b === 'charger' ? d.b : 'r125';
  if ('c' in d) st.c = /^#[0-9a-f]{6}$/i.test(d.c) ? d.c : '#8aa0b8';
  if ('t' in d && (v = num(d.t, 0, 4e15)) !== null) st.t = v;
  ['x', 'z'].forEach(function (k) { if (k in d) { if (d[k] === null) delete st[k]; else if ((v = num(d[k], -1e6, 1e6)) !== null) st[k] = Math.round(v * 100) / 100; } });
  if ('y' in d && (v = num(d.y, -50, 50)) !== null) st.y = Math.round(v * 1000) / 1000;
  if ('l' in d && (v = num(d.l, -3.2, 3.2)) !== null) st.l = Math.round(v * 1000) / 1000;
  if ('v' in d && (v = num(d.v, -200, 600)) !== null) st.v = Math.round(v * 10) / 10;
  if ('m' in d) st.m = clean(d.m, 100);
  if ('mi' in d && (v = num(d.mi, 0, 4e15)) !== null) st.mi = v;
}
function handle(c, txt) {
  var m; try { m = JSON.parse(txt); } catch (e) { return c.close(1003); }
  if (!m || typeof m !== 'object') return c.close(1003);
  var now = Date.now(); c.tokens = Math.min(RATE * 2, (c.tokens == null ? RATE : c.tokens) + (now - (c.tokT || now)) / 1000 * RATE); c.tokT = now;
  if (c.tokens < 1) return; c.tokens -= 1;
  if (m.t === 'ping') return c.send({ t: 'pong', c: num(m.c, 0, 4e15) });
  if (m.t === 'join') {
    if (c.room) return;
    var name = String(m.room || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24); if (!name) { c.send({ t: 'err', m: 'Oda adı geçersiz.' }); return c.close(1008); }
    var max = Math.max(2, Math.min(8, (m.max | 0) || 8)), r = getRoom(name, max);
    if (!r) { c.send({ t: 'err', m: 'Sunucu dolu, biraz sonra dene.' }); return c.close(1013); }
    if (r.n >= r.max) { c.send({ t: 'full' }); return c.close(1008); }
    c.id = crypto.randomBytes(4).toString('hex'); c.room = r; r.peers[c.id] = { conn: c, st: { t: now } }; r.n++; r.dirty = true;
    c.send({ t: 'hi', id: c.id, max: r.max, n: r.n, ts: now }); log('join', name, r.n + '/' + r.max);
    return;
  }
  if (m.t === 'p' && c.room) { var pr = c.room.peers[c.id]; if (pr) { sanitize(m.d, pr.st); c.room.dirty = true; } }
}
setInterval(function () {
  var now = Date.now();
  Object.keys(rooms).forEach(function (k) {
    var r = rooms[k]; if (!r || (!r.dirty && now - (r.sent || 0) < 2000)) return; r.dirty = false; r.sent = now;
    var p = {}; Object.keys(r.peers).forEach(function (id) { var st = r.peers[id].st; if (typeof st.x === 'number' && typeof st.z === 'number') p[id] = st; else p[id] = { n: st.n, b: st.b, c: st.c, t: st.t }; });
    var msg = JSON.stringify({ t: 's', ts: now, p: p });
    Object.keys(r.peers).forEach(function (id) { r.peers[id].conn.send(msg); });
  });
}, TICK_MS);
setInterval(function () {
  var now = Date.now();
  Object.keys(rooms).forEach(function (k) { var r = rooms[k]; if (!r) return; Object.keys(r.peers).forEach(function (id) { var c = r.peers[id].conn; if (now - c.alive > DEAD_MS) c.finish(); else c.ping(); }); });
}, PING_MS);

/* ---------- HTTP ---------- */
var MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8' };
var server = http.createServer(function (req, res) {
  var url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ ok: true, v: 1, rooms: Object.keys(rooms).length, clients: clients, up: Math.round((Date.now() - started) / 1000) })); }
  if (!fs.existsSync(PUBLIC)) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('MotoGPX oyun sunucusu çalışıyor. WebSocket: /ws'); }
  var rel = decodeURIComponent(url); if (rel.slice(-1) === '/') rel += 'index.html';
  var fp = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\]|\.\.)+/, ''));
  if (fp.indexOf(PUBLIC) !== 0) { res.writeHead(403); return res.end(); }
  fs.stat(fp, function (er, st) {
    if (er || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'public, max-age=300' });
    fs.createReadStream(fp).pipe(res);
  });
});
server.on('upgrade', function (req, sock) {
  var url = (req.url || '').split('?')[0], key = req.headers['sec-websocket-key'], origin = req.headers.origin || '';
  var ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || sock.remoteAddress || '').trim();
  function no(code, why) { try { sock.write('HTTP/1.1 ' + code + ' ' + why + '\r\nConnection: close\r\n\r\n'); } catch (e) {} sock.destroy(); }
  if (url !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') return no(400, 'Bad Request');
  if (ORIGINS.indexOf('*') < 0 && origin && ORIGINS.indexOf(origin) < 0) return no(403, 'Forbidden');
  if ((perIp[ip] || 0) >= MAX_PER_IP) return no(429, 'Too Many Requests');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
  perIp[ip] = (perIp[ip] || 0) + 1; clients++;
  var c = new Conn(sock), joinT = setTimeout(function () { if (!c.room) c.close(1008); }, IDLE_JOIN_MS);
  c.onmsg = function (t) { handle(c, t); };
  c.onclose = function () { clearTimeout(joinT); leave(c); clients--; perIp[ip] = Math.max(0, (perIp[ip] || 1) - 1); if (!perIp[ip]) delete perIp[ip]; };
});
server.on('clientError', function (e, s) { try { s.destroy(); } catch (x) {} });
if (require.main === module) server.listen(PORT, function () { log('MotoGPX sunucusu dinliyor: ' + PORT + (fs.existsSync(PUBLIC) ? ' · site: ' + PUBLIC : '')); });
module.exports = { server: server, rooms: rooms };
