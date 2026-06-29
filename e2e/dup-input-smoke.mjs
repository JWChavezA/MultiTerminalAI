// Detecta duplicación real en el canal de input del terminal.
// Version simple, basada en readServerFrames del ws-fragment-smoke.

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = join(rootDir, ".tmp-dup-e2e");
const projectDir = join(testRoot, "DupProject");
const dataDir = join(testRoot, "data");

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClientFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function readServerFrames(buffer) {
  const out = [];
  let o = 0;
  while (o + 2 <= buffer.length) {
    let len = buffer[o + 1] & 0x7f;
    let c = o + 2;
    if (len === 126) { if (c + 2 > buffer.length) break; len = buffer.readUInt16BE(c); c += 2; }
    else if (len === 127) { if (c + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(c)); c += 8; }
    if (c + len > buffer.length) break;
    out.push(buffer.subarray(c, c + len).toString("utf8"));
    o = c + len;
  }
  return out.join("");
}

async function api(port, path, options = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "API error");
  return d;
}

function openSocket(port, qs) {
  return new Promise((resolveOpen, rejectOpen) => {
    const sock = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    sock.on("data", (b) => { buffer = Buffer.concat([buffer, b]); });
    sock.on("error", rejectOpen);
    sock.on("connect", () => {
      sock.write(
        `GET ${qs} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
      const start = Date.now();
      const wait = () => {
        if (buffer.includes(Buffer.from("\r\n\r\n"))) {
          const headersEnd = buffer.indexOf(Buffer.from("\r\n\r\n")) + 4;
          resolveOpen({
            sock,
            snapshot: () => {
              const frames = readServerFrames(buffer.subarray(headersEnd));
              return frames;
            },
            waitFor: async (predicate, timeoutMs) => {
              const t0 = Date.now();
              while (Date.now() - t0 < timeoutMs) {
                const text = readServerFrames(buffer.subarray(headersEnd));
                if (predicate(text)) return text;
                await delay(50);
              }
              return readServerFrames(buffer.subarray(headersEnd));
            }
          });
        } else if (Date.now() - start > 5000) rejectOpen(new Error("WS handshake timeout"));
        else setTimeout(wait, 30);
      };
      wait();
    });
  });
}

function count(haystack, needle) {
  let c = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { c++; idx += needle.length; }
  return c;
}

const { server, port } = await startServer({
  port: 0, dataDir,
  publicDir: join(rootDir, "public"),
  vendorDir: join(rootDir, "node_modules")
});

let exitCode = 1;
let A, B;
try {
  const project = await api(port, "/api/projects", { method: "POST", body: { name: "DupProject", path: projectDir } });
  const session = await api(port, `/api/projects/${project.id}/sessions`, {
    method: "POST", body: { name: "Dup test", command: "", shell: "bash" }
  });

  A = await openSocket(port, `/terminal?project=${project.id}&session=${session.id}&cols=120&rows=30`);
  B = await openSocket(port, `/terminal?project=${project.id}&session=${session.id}&cols=120&rows=30`);

  // Espera banner inicial y asentamiento
  await delay(500);

  const TAG = `UNIQ_${randomBytes(6).toString("hex")}`;
  // Sin \r para que bash NO ejecute: solo escribe al buffer y hace eco.
  // Eso aísla lo que el frontend hace: onData -> ws.send -> server -> child.write -> PTY echo.
  const INPUT = `${TAG}`;

  A.sock.write(makeClientFrame(JSON.stringify({ type: "data", data: INPUT })));

  // Espera hasta 2s a que el eco llegue a A (la entrada cruza ws -> server -> pty -> broadcast -> A)
  const aText = await A.waitFor((t) => t.includes(TAG), 2000);
  await delay(300);
  const bText = await B.waitFor((t) => t.includes(TAG), 2000);

  // Para quedarnos SOLO con lo recibido desde este momento, limpiamos la snapshot pre-envio
  // (no es trivial con buffer incremental, asi que contamos en todo lo recibido y comparamos
  //  con un baseline previo al envio)
  const aHits = count(aText, TAG);
  const bHits = count(bText, TAG);

  console.log(`TAG = ${TAG}`);
  console.log(`A frames decoded (len=${aText.length}) hits=${aHits}`);
  console.log(`B frames decoded (len=${bText.length}) hits=${bHits}`);

  let fail = false;
  if (aHits !== 1) { console.log(`  FAIL: A recibio ${aHits} copias del TAG, esperaba 1`); fail = true; }
  if (bHits !== 1) { console.log(`  FAIL: B recibio ${bHits} copias del TAG, esperaba 1`); fail = true; }

  if (fail) {
    console.log("\n=== Texto A ===");
    console.log(JSON.stringify(aText));
    console.log("=== Texto B ===");
    console.log(JSON.stringify(bText));
    throw new Error("Dup detected");
  }
  console.log("\nDup-input smoke OK: cada socket recibe exactamente 1 copia del eco (sin duplicacion).");
  exitCode = 0;
} catch (e) {
  console.error("Dup-input smoke FAIL:", e.message);
  exitCode = 1;
} finally {
  if (A?.sock) A.sock.end();
  if (B?.sock) B.sock.end();
  await delay(100);
  server.close();
  process.exit(exitCode);
}