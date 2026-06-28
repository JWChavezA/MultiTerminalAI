import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = join(rootDir, ".tmp-ws-e2e");
const projectDir = join(testRoot, "WsProject");
const dataDir = join(testRoot, "data");

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

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
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function readServerFrames(buffer) {
  const output = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (cursor + length > buffer.length) break;
    output.push(buffer.subarray(cursor, cursor + length).toString("utf8"));
    offset = cursor + length;
  }
  return output.join("");
}

async function api(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "API error");
  return data;
}

const { server, port } = await startServer({ port: 0, dataDir, publicDir: join(rootDir, "public"), vendorDir: join(rootDir, "node_modules") });

let ok = false;
try {
  const project = await api(port, "/api/projects", { method: "POST", body: { name: "WsProject", path: projectDir } });
  const session = await api(port, `/api/projects/${project.id}/sessions`, {
    method: "POST",
    body: { name: "Fragment test", command: "", shell: process.platform === "win32" ? "cmd" : "bash" }
  });

  const socket = net.connect(port, "127.0.0.1");
  const key = randomBytes(16).toString("base64");
  let received = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
  });

  socket.write(
    `GET /terminal?project=${project.id}&session=${session.id}&cols=100&rows=30 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n"
  );

  const started = Date.now();
  while (!received.includes(Buffer.from("\r\n\r\n"))) {
    if (Date.now() - started > 5000) throw new Error("Timeout en handshake WebSocket.");
    await delay(50);
  }

  const command = process.platform === "win32" ? "echo FRAG_OK && exit\r" : "echo FRAG_OK; exit\r";
  const frame = makeClientFrame(JSON.stringify({ type: "data", data: command }));
  socket.write(frame.subarray(0, 5));
  await delay(25);
  socket.write(frame.subarray(5));

  const outputStarted = Date.now();
  while (!readServerFrames(received.subarray(received.indexOf("\r\n\r\n") + 4)).includes("FRAG_OK")) {
    if (Date.now() - outputStarted > 10000) throw new Error("El servidor no proceso el frame fragmentado.");
    await delay(100);
  }

  socket.end();
  console.log("WS fragment E2E OK: frame partido procesado sin error.");
  ok = true;
} finally {
  server.close();
  if (ok) process.exit(0);
}
