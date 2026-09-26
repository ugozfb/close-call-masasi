#!/usr/bin/env node
// Close Call Masasi yerel sunucusu. Bagimliliksiz.
//  - Yalniz 127.0.0.1'e baglanir; disaridan erisilemez.
//  - ui/ ve src/ klasorlerini sunar (baska hicbir dosyayi sunmaz).
//  - /tc/r/<oda>... isteklerini sabit hedef https://technocore.chat/r/<oda>... adresine iletir (GET ve POST).
//    Tarayici boylece CORS ayarina bagli kalmaz. Ozel anahtar bu sunucuya hic gelmez: tarayici imzalar,
//    sunucu yalniz imzali mesaji (DID, imza, nonce, metin) iletir.
// Kullanim:  node ui\serve.mjs            -> http://127.0.0.1:5199/ui/
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Yalniz test icin: sahte technocore'a yonlendirme (CLOSECALL_TEST=1 ile birlikte).
const TEST = process.env.CLOSECALL_TEST === "1";
const UPSTREAM = TEST && process.env.CLOSECALL_UPSTREAM ? process.env.CLOSECALL_UPSTREAM : "https://technocore.chat";
const PORT = Number(process.argv[2] || process.env.PORT || 5199);
const SERVED = TEST ? ["ui", "src", "tools/ui-test"] : ["ui", "src"];
const ROOM_PATH = /^\/r\/[a-z0-9][a-z0-9_-]{0,47}(\/export)?$/;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const CSP = "default-src 'self'; connect-src 'self' https://technocore.chat; img-src 'self' data:; style-src 'self'; "
  + "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": CSP, ...extra,
  });
  res.end(body);
}

async function readBody(req, max = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error("govde cok buyuk");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function proxy(req, res, url) {
  const sub = url.pathname.slice("/tc".length);
  if (!ROOM_PATH.test(sub)) return send(res, 400, "yalniz /r/<oda> ve /r/<oda>/export iletilir");
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, "yalniz GET ve POST");
  const init = { method: req.method, headers: {} };
  if (req.method === "POST") {
    init.body = await readBody(req);
    init.headers["content-type"] = "application/json";
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const up = await fetch(UPSTREAM + sub + url.search, { ...init, signal: ctl.signal });
    const buf = Buffer.from(await up.arrayBuffer());
    const extra = {};
    for (const h of ["retry-after", "x-room-generation"]) if (up.headers.get(h)) extra[h] = up.headers.get(h);
    send(res, up.status, buf, up.headers.get("content-type") || "text/plain; charset=utf-8", extra);
  } catch (e) {
    send(res, 502, `technocore'a ulasilamadi: ${e && e.message ? e.message : e}`);
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/" || p === "/ui") return send(res, 302, "", "text/plain", { Location: "/ui/" });
  if (p.endsWith("/")) p += "index.html";
  const file = path.resolve(ROOT, "." + p);
  const ok = SERVED.some((d) => file.startsWith(path.join(ROOT, d) + path.sep));
  if (!ok) return send(res, 404, "bulunamadi");
  try {
    let body = await readFile(file);
    // Yalniz test modunda: arayuzden once sahte hakem anahtarini ayarlayan betik eklenir.
    // Normal kullanimda sayfa oldugu gibi sunulur.
    if (TEST && file === path.join(ROOT, "ui", "index.html")) {
      body = Buffer.from(String(body).replace('<script type="module" src="app.mjs"></script>',
        '<script src="/tools/ui-test/setup.js"></script>\n  <script type="module" src="app.mjs"></script>'));
    }
    send(res, 200, body, TYPES[path.extname(file)] || "application/octet-stream");
  } catch {
    send(res, 404, "bulunamadi");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/tc/")) return await proxy(req, res, url);
    if (req.method !== "GET") return send(res, 405, "yalniz GET");
    return await serveStatic(res, url);
  } catch (e) {
    send(res, 500, String(e && e.message ? e.message : e));
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} kullanimda. Baska bir port icin: node ui\\serve.mjs ${PORT + 1}`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Close Call Masasi: http://127.0.0.1:${PORT}/ui/`);
  console.log(`technocore koprusu: ${UPSTREAM}${TEST ? "  (TEST MODU)" : ""}`);
  console.log("Durdurmak icin Ctrl + C.");
});
