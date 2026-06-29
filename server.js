import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const QRCode = require("qrcode");
const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
let publicDir = join(rootDir, "public");
let vendorDir = join(rootDir, "node_modules");
let dataDir = join(rootDir, "data");
let dbPath = join(dataDir, "state.json");
let port = Number(process.env.PORT || 4173);
let host = process.env.HOST || "127.0.0.1";
let pickFolder = null;

const sockets = new Map();
const shells = new Map();
const scrollback = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function ensureStore() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, JSON.stringify({ projects: [], remote: defaultRemoteState() }, null, 2));
  }
}

function readStore() {
  ensureStore();
  const state = JSON.parse(readFileSync(dbPath, "utf8"));
  state.projects ||= [];
  state.remote ||= defaultRemoteState();
  state.remote.pairCodes ||= [];
  state.remote.pending ||= [];
  state.remote.grants ||= [];
  state.remote.connections ||= [];
  return state;
}

function writeStore(state) {
  ensureStore();
  writeFileSync(dbPath, JSON.stringify(state, null, 2));
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultRemoteState() {
  return {
    computerName: process.env.COMPUTERNAME || process.env.HOSTNAME || "MultiTerminalAI",
    pairCodes: [],
    pending: [],
    grants: [],
    connections: []
  };
}

function makeSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function publicRemoteState(remote) {
  return {
    computerName: remote.computerName,
    pending: remote.pending.map((item) => ({
      id: item.id,
      deviceName: item.deviceName,
      createdAt: item.createdAt
    })),
    connections: remote.connections.map((item) => ({
      id: item.id,
      deviceName: item.deviceName,
      createdAt: item.createdAt,
      lastSeenAt: item.lastSeenAt
    }))
  };
}

function requireMobileAuth(req, state) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new Error("No autorizado.");
  const tokenHash = hashToken(token);
  const connection = state.remote.connections.find((item) => item.tokenHash === tokenHash);
  if (!connection) throw new Error("No autorizado.");
  connection.lastSeenAt = new Date().toISOString();
  return connection;
}

function cleanupPairCodes(remote) {
  const now = Date.now();
  remote.pairCodes = remote.pairCodes.filter((item) => new Date(item.expiresAt).getTime() > now && !item.usedAt);
}

function normalizeProject(input) {
  const name = String(input.name || "").trim();
  const path = resolve(String(input.path || "").trim());
  if (!name) throw new Error("El proyecto necesita nombre.");
  if (!existsSync(path)) throw new Error("La carpeta no existe.");
  return {
    id: input.id || makeId("project"),
    name,
    path,
    sessions: Array.isArray(input.sessions) ? input.sessions : []
  };
}

function normalizeSession(input) {
  const name = String(input.name || "").trim();
  const command = String(input.command || "").trim();
  if (!name) throw new Error("La sesion necesita nombre.");
  return {
    id: input.id || makeId("session"),
    name,
    command,
    shell: input.shell || (process.platform === "win32" ? "powershell" : "bash")
  };
}

function findProject(state, projectId) {
  return state.projects.find((project) => project.id === projectId);
}

function findSession(state, projectId, sessionId) {
  const project = findProject(state, projectId);
  if (!project) return {};
  return { project, session: project.sessions.find((item) => item.id === sessionId) };
}

function shellCommand(shell, command) {
  // Si hay un comando especifico (como "claude"), ejecutarlo directamente
  // sin bash de por medio. Asi las flechas/Esc/Ctrl van directo al proceso
  // y no son interceptadas por readline.
  if (command && command.trim()) {
    // Expandir el comando: soportar argumentos simples
    const parts = command.trim().split(/\s+/);
    const file = parts[0];
    const args = parts.slice(1);
    return { file, args, initial: "" };
  }
  if (shell === "cmd" && process.platform === "win32") {
    return { file: "cmd.exe", args: [], initial: "" };
  }
  if (shell === "bash" || process.platform !== "win32") {
    return { file: process.env.SHELL || "bash", args: ["-i"], initial: "" };
  }
  return { file: "powershell.exe", args: ["-NoLogo"], initial: "" };
}

function openNativeTerminal(project, session) {
  const command = session.command || "";
  const title = `${project.name} - ${session.name}`;
  if (process.platform !== "win32") {
    const shell = process.env.SHELL || "bash";
    const shellArgs = command ? ["-lc", `${command}; exec ${shell}`] : ["-i"];
    const candidates =
      process.platform === "darwin"
        ? [{ file: "open", args: ["-a", "Terminal", project.path] }]
        : [
            { file: "x-terminal-emulator", args: ["-T", title, "-e", shell, ...shellArgs] },
            { file: "gnome-terminal", args: ["--title", title, "--working-directory", project.path, "--", shell, ...shellArgs] },
            { file: "konsole", args: ["--workdir", project.path, "-p", `tabtitle=${title}`, "-e", shell, ...shellArgs] },
            { file: "xfce4-terminal", args: ["--title", title, "--working-directory", project.path, "-e", `${shell} ${shellArgs.join(" ")}`] },
            { file: "xterm", args: ["-T", title, "-e", shell, ...shellArgs] }
          ];
    const launch = (index = 0) => {
      const candidate = candidates[index];
      if (!candidate) return;
      const child = spawn(candidate.file, candidate.args, { cwd: project.path, detached: true, stdio: "ignore" });
      child.on("error", () => launch(index + 1));
      child.unref();
    };
    launch();
    return;
  }

  const wtArgs = [
    "new-tab",
    "--title",
    title,
    "-d",
    project.path,
    "powershell.exe",
    "-NoLogo",
    "-NoExit"
  ];
  if (command) wtArgs.push("-Command", command);

  const wt = spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore" });
  wt.on("error", () => {
    const fallback = spawn("powershell.exe", ["-NoLogo", "-NoExit", "-Command", command || "pwd"], {
      cwd: project.path,
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    fallback.unref();
  });
  wt.unref();
}

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function readFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = Boolean(secondByte & 0x80);
    let payloadLength = secondByte & 0x7f;
    let cursor = offset + 2;

    if (payloadLength === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(cursor);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Frame WebSocket demasiado grande.");
      payloadLength = Number(bigLength);
      cursor += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (cursor + maskLength + payloadLength > buffer.length) break;

    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += maskLength;
    const payload = buffer.subarray(cursor, cursor + payloadLength);
    cursor += payloadLength;

    let data = payload;
    if (mask) {
      data = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index += 1) {
        data[index] = payload[index] ^ mask[index % 4];
      }
    }

    frames.push({ opcode, text: data.toString("utf8") });
    offset = cursor;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

function broadcast(shellId, message) {
  const shellSockets = sockets.get(shellId);
  if (!shellSockets) return;
  for (const socket of shellSockets) {
    if (socket.writable) socket.write(encodeFrame(message));
  }
}

function sendTerminalData(shellId, data) {
  const previous = scrollback.get(shellId) || "";
  scrollback.set(shellId, (previous + data).slice(-120000));
  broadcast(shellId, JSON.stringify({ type: "data", data }));
}

function startShell(shellId, project, session, size = {}) {
  if (shells.has(shellId)) return shells.get(shellId);
  const command = shellCommand(session.shell, session.command);
  const child = pty.spawn(command.file, command.args, {
    cwd: project.path,
    env: { ...process.env, TERM: "xterm-256color", FORCE_COLOR: "1" },
    cols: Number(size.cols || 100),
    rows: Number(size.rows || 30),
    name: "xterm-256color"
  });
  shells.set(shellId, child);
  sendTerminalData(shellId, `\r\n[${project.name} / ${session.name}]\r\n`);
  if (command.initial) child.write(`${command.initial}\r`);
  child.onData((data) => sendTerminalData(shellId, data));
  child.onExit(({ exitCode }) => {
    shells.delete(shellId);
    sendTerminalData(shellId, `\r\n[proceso terminado: ${exitCode ?? "sin codigo"}]\r\n`);
  });
  return child;
}

function stopShell(shellId) {
  const child = shells.get(shellId);
  if (child) {
    child.kill();
    shells.delete(shellId);
  }
  scrollback.delete(shellId);
}

async function handleApi(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const state = readStore();

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, state);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/remote/state") {
      cleanupPairCodes(state.remote);
      writeStore(state);
      sendJson(res, 200, publicRemoteState(state.remote));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/remote/pair-code") {
      cleanupPairCodes(state.remote);
      const code = makeSecret(12);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      state.remote.pairCodes.push({ code, createdAt: new Date().toISOString(), expiresAt });
      writeStore(state);
      const remoteHost = req.headers.host || `localhost:${port}`;
      const pairUrl = `http://${remoteHost}/mobile/?pair=${encodeURIComponent(code)}`;
      sendJson(res, 201, {
        code,
        expiresAt,
        url: pairUrl,
        qr: await QRCode.toDataURL(pairUrl, {
          margin: 2,
          color: {
            dark: "#f4f4f5",
            light: "#000000"
          }
        })
      });
      return;
    }

    const pendingMatch = url.pathname.match(/^\/api\/remote\/pending\/([^/]+)\/(accept|reject)$/);
    if (req.method === "POST" && pendingMatch) {
      const pending = state.remote.pending.find((item) => item.id === pendingMatch[1]);
      if (!pending) throw new Error("Solicitud no encontrada.");
      state.remote.pending = state.remote.pending.filter((item) => item.id !== pending.id);

      if (pendingMatch[2] === "reject") {
        writeStore(state);
        sendJson(res, 200, { ok: true });
        return;
      }

      const token = makeSecret(32);
      const connection = {
        id: makeId("device"),
        deviceName: pending.deviceName,
        tokenHash: hashToken(token),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
      };
      state.remote.connections.push(connection);
      state.remote.grants.push({
        requestId: pending.id,
        token,
        connection: { id: connection.id, deviceName: connection.deviceName },
        createdAt: new Date().toISOString()
      });
      writeStore(state);
      sendJson(res, 200, { connection: { id: connection.id, deviceName: connection.deviceName } });
      return;
    }

    const connectionMatch = url.pathname.match(/^\/api\/remote\/connections\/([^/]+)$/);
    if (req.method === "DELETE" && connectionMatch) {
      state.remote.connections = state.remote.connections.filter((item) => item.id !== connectionMatch[1]);
      writeStore(state);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mobile/info") {
      sendJson(res, 200, { computerName: state.remote.computerName });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mobile/pair") {
      cleanupPairCodes(state.remote);
      const body = await readBody(req);
      const code = String(body.code || "").trim();
      const deviceName = String(body.deviceName || "").trim() || "Telefono";
      const pairCode = state.remote.pairCodes.find((item) => item.code === code);
      if (!pairCode) throw new Error("Codigo de emparejamiento invalido o expirado.");

      const existing = state.remote.pending.find((item) => item.code === code && item.deviceName === deviceName);
      const request = existing || {
        id: makeId("pair"),
        code,
        deviceName,
        createdAt: new Date().toISOString()
      };
      if (!existing) state.remote.pending.push(request);
      writeStore(state);
      sendJson(res, 202, { requestId: request.id, status: "pending" });
      return;
    }

    const mobilePairStatusMatch = url.pathname.match(/^\/api\/mobile\/pair\/([^/]+)$/);
    if (req.method === "GET" && mobilePairStatusMatch) {
      const requestId = mobilePairStatusMatch[1];
      const grant = state.remote.grants.find((item) => item.requestId === requestId);
      if (grant) {
        state.remote.grants = state.remote.grants.filter((item) => item.requestId !== requestId);
        writeStore(state);
        sendJson(res, 200, { status: "accepted", token: grant.token, connection: grant.connection });
        return;
      }
      const pending = state.remote.pending.find((item) => item.id === requestId);
      if (pending) {
        sendJson(res, 200, { status: "pending" });
        return;
      }
      sendJson(res, 200, { status: "unknown" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mobile/projects") {
      requireMobileAuth(req, state);
      writeStore(state);
      sendJson(res, 200, {
        computerName: state.remote.computerName,
        projects: state.projects.map((project) => ({
          id: project.id,
          name: project.name,
          sessions: project.sessions.map((session) => ({
            id: session.id,
            name: session.name,
            command: session.command,
            shell: session.shell
          }))
        }))
      });
      return;
    }

    const mobileSessionListMatch = url.pathname.match(/^\/api\/mobile\/projects\/([^/]+)\/sessions$/);
    if (req.method === "POST" && mobileSessionListMatch) {
      requireMobileAuth(req, state);
      const project = findProject(state, mobileSessionListMatch[1]);
      if (!project) throw new Error("Proyecto no encontrado.");
      const session = normalizeSession(await readBody(req));
      project.sessions.push(session);
      writeStore(state);
      sendJson(res, 201, session);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pick-folder") {
      if (!pickFolder) throw new Error("El selector de carpetas solo esta disponible en la app de escritorio.");
      const path = await pickFolder();
      sendJson(res, 200, path ? { path, name: basename(path) || path } : { canceled: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/projects") {
      const project = normalizeProject(await readBody(req));
      state.projects.push(project);
      writeStore(state);
      sendJson(res, 201, project);
      return;
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === "PUT" && projectMatch) {
      const index = state.projects.findIndex((project) => project.id === projectMatch[1]);
      if (index === -1) throw new Error("Proyecto no encontrado.");
      const body = await readBody(req);
      state.projects[index] = {
        ...state.projects[index],
        ...normalizeProject({
          ...body,
          id: projectMatch[1],
          sessions: body.sessions || state.projects[index].sessions
        })
      };
      writeStore(state);
      sendJson(res, 200, state.projects[index]);
      return;
    }

    if (req.method === "DELETE" && projectMatch) {
      state.projects = state.projects.filter((project) => project.id !== projectMatch[1]);
      writeStore(state);
      sendJson(res, 200, { ok: true });
      return;
    }

    const sessionListMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (req.method === "POST" && sessionListMatch) {
      const project = findProject(state, sessionListMatch[1]);
      if (!project) throw new Error("Proyecto no encontrado.");
      const session = normalizeSession(await readBody(req));
      project.sessions.push(session);
      writeStore(state);
      sendJson(res, 201, session);
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const { project, session } = findSession(state, sessionMatch[1], sessionMatch[2]);
      if (!project || !session) throw new Error("Sesion no encontrada.");
      if (req.method === "PUT") {
        Object.assign(session, normalizeSession({ ...(await readBody(req)), id: session.id }));
        writeStore(state);
        sendJson(res, 200, session);
        return;
      }
      if (req.method === "DELETE") {
        project.sessions = project.sessions.filter((item) => item.id !== session.id);
        writeStore(state);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    const openMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/open$/);
    if (req.method === "POST" && openMatch) {
      const { project, session } = findSession(state, openMatch[1], openMatch[2]);
      if (!project || !session) throw new Error("Sesion no encontrada.");
      openNativeTerminal(project, session);
      sendJson(res, 200, { ok: true });
      return;
    }

    const stopMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      stopShell(`${stopMatch[1]}:${stopMatch[2]}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "No encontrado." });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/vendor/")) {
    const vendorPath = resolve(vendorDir, `.${url.pathname.replace("/vendor", "")}`);
    if (!vendorPath.startsWith(vendorDir) || !existsSync(vendorPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const body = readFileSync(vendorPath);
    res.writeHead(200, { "content-type": mimeTypes[extname(vendorPath)] || "application/octet-stream" });
    res.end(body);
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
  const filePath = resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  res.end(body);
}

export function startServer(options = {}) {
  publicDir = options.publicDir ? resolve(options.publicDir) : publicDir;
  vendorDir = options.vendorDir ? resolve(options.vendorDir) : vendorDir;
  dataDir = options.dataDir ? resolve(options.dataDir) : dataDir;
  pickFolder = typeof options.pickFolder === "function" ? options.pickFolder : null;
  dbPath = join(dataDir, "state.json");
  port = Number(options.port ?? port);
  host = options.host || host;

  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/")) {
      void handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname !== "/terminal" && url.pathname !== "/mobile-terminal") {
      socket.destroy();
      return;
    }
    const remoteAddress = req.socket.remoteAddress || "";
    const isLoopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
    if (url.pathname === "/terminal" && !isLoopback) {
      socket.destroy();
      return;
    }
    const projectId = url.searchParams.get("project");
    const sessionId = url.searchParams.get("session");
    const state = readStore();
    if (url.pathname === "/mobile-terminal") {
      const token = url.searchParams.get("token") || "";
      const tokenHash = hashToken(token);
      const connection = state.remote.connections.find((item) => item.tokenHash === tokenHash);
      if (!connection) {
        socket.destroy();
        return;
      }
      connection.lastSeenAt = new Date().toISOString();
      writeStore(state);
    }
    const { project, session } = findSession(state, projectId, sessionId);
    if (!project || !session) {
      socket.destroy();
      return;
    }

    const key = req.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`
    );

    const shellId = `${project.id}:${session.id}`;
    let incoming = Buffer.alloc(0);
    if (!sockets.has(shellId)) sockets.set(shellId, new Set());
    sockets.get(shellId).add(socket);
    const child = startShell(shellId, project, session, {
      cols: Number(url.searchParams.get("cols") || 100),
      rows: Number(url.searchParams.get("rows") || 30)
    });
    const history = scrollback.get(shellId);
    if (history) socket.write(encodeFrame(JSON.stringify({ type: "data", data: history })));
    socket.on("data", (buffer) => {
      try {
        incoming = Buffer.concat([incoming, buffer]);
        const parsed = readFrames(incoming);
        incoming = parsed.remaining;

        for (const frame of parsed.frames) {
          if (frame.opcode === 0x8) {
            socket.end();
            return;
          }
          if (frame.opcode !== 0x1) continue;
          const message = JSON.parse(frame.text);
          if (message.type === "data") child.write(message.data);
          if (message.type === "resize") child.resize(Number(message.cols), Number(message.rows));
        }
      } catch (error) {
        socket.write(encodeFrame(JSON.stringify({ type: "data", data: `\r\n[websocket error: ${error.message}]\r\n` })));
      }
    });
    const removeSocket = () => {
      const shellSockets = sockets.get(shellId);
      if (!shellSockets) return;
      shellSockets.delete(socket);
      if (shellSockets.size === 0) sockets.delete(shellId);
    };
    socket.on("close", removeSocket);
    socket.on("error", removeSocket);
  });

  return new Promise((resolveServer) => {
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`MultiTerminalAI listo en http://${host}:${actualPort}`);
      resolveServer({ server, port: actualPort });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
