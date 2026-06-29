// Burst dup test: cuenta frames JSON del server que contengan el burst entero como data.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = join(rootDir, ".tmp-burst-e2e");
const projectDir = join(testRoot, "BurstProject");
const dataDir = join(testRoot, "data");

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClientFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Parser WebSocket servidor (frames sin mascara)
function readServerFrames(buffer) {
  const frames = [];
  let o = 0;
  while (o + 2 <= buffer.length) {
    const b1 = buffer[o + 1];
    let len = b1 & 0x7f;
    let c = o + 2;
    if (len === 126) { if (c + 2 > buffer.length) break; len = buffer.readUInt16BE(c); c += 2; }
    else if (len === 127) { if (c + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(c)); c += 8; }
    if (c + len > buffer.length) break;
    const opcode = buffer[o] & 0x0f;
    frames.push({ opcode, text: buffer.subarray(c, c + len).toString("utf8") });
    o = c + len;
  }
  return frames;
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
            allFrames: () => {
              const frames = readServerFrames(buffer.subarray(headersEnd));
              const dataFrames = [];
              for (const f of frames) {
                if (f.opcode !== 0x1) continue;
                try {
                  const j = JSON.parse(f.text);
                  if (j.type === "data") dataFrames.push(j.data);
                } catch {}
              }
              return dataFrames;
            },
            waitForData: async (predicate, timeoutMs) => {
              const t0 = Date.now();
              while (Date.now() - t0 < timeoutMs) {
                const frames = readServerFrames(buffer.subarray(headersEnd));
                for (const f of frames) {
                  if (f.opcode !== 0x1) continue;
                  try {
                    const j = JSON.parse(f.text);
                    if (j.type === "data" && predicate(j.data)) return true;
                  } catch {}
                }
                await delay(50);
              }
              return false;
            }
          });
        } else if (Date.now() - start > 5000) rejectOpen(new Error("WS handshake timeout"));
        else setTimeout(wait, 30);
      };
      wait();
    });
  });
}

const { server, port } = await startServer({
  port: 0, dataDir,
  publicDir: join(rootDir, "public"),
  vendorDir: join(rootDir, "node_modules")
});

let exitCode = 1;
let A;
try {
  const project = await api(port, "/api/projects", { method: "POST", body: { name: "BurstProject", path: projectDir } });
  const session = await api(port, `/api/projects/${project.id}/sessions`, {
    method: "POST", body: { name: "Burst test", command: "", shell: "bash" }
  });

  A = await openSocket(port, `/terminal?project=${project.id}&session=${session.id}&cols=120&rows=30`);
  await delay(500);

  const burst = "abcdefghij".repeat(50); // 500 chars, sin \r -> solo eco PTY
  A.sock.write(makeClientFrame(JSON.stringify({ type: "data", data: burst })));

  // Espera a que el burst vuelva entero en UN frame data
  const ok = await A.waitForData((d) => d === burst, 3000);
  if (!ok) {
    const frames = A.allFrames();
    console.log("No se recibio el burst completo. Frames data recibidos:");
    for (const d of frames) console.log(`  len=${d.length} preview=${JSON.stringify(d.slice(0, 60))}`);
    throw new Error("burst no llego");
  }
  await delay(300);

  // Ahora cuenta: ¿cuántos frames data contienen el burst ENTERO?
  const allDataFrames = A.allFrames();
  const matching = allDataFrames.filter((d) => d === burst);
  console.log(`burst enviado=${burst.length} chars`);
  console.log(`total frames data recibidos=${allDataFrames.length}`);
  console.log(`frames con data EXACTA = burst: ${matching.length}`);

  if (matching.length !== 1) {
    throw new Error(`Dup-burst: el server envio el burst ${matching.length} veces (esperaba 1)`);
  }

  // Verificacion adicional: ¿el burst aparece tambien en otros frames partidos?
  const fragments = allDataFrames.filter((d) => d.includes(burst));
  if (fragments.length !== 1) {
    throw new Error(`Dup-burst: ${fragments.length} frames contienen el burst como sub-string (esperaba 1)`);
  }

  console.log("\nDup-burst smoke OK: el server envia el burst exactamente 1 vez, sin duplicacion.");
  exitCode = 0;
} catch (e) {
  console.error("Dup-burst smoke FAIL:", e.message);
  exitCode = 1;
} finally {
  if (A?.sock) A.sock.end();
  await delay(100);
  server.close();
  process.exit(exitCode);
}