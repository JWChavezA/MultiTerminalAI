import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.js";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = join(rootDir, ".tmp-mobile-e2e");
const projectDir = join(testRoot, "MobileProject");
const dataDir = join(testRoot, "data");

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function api(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "API error");
  return data;
}

async function waitForMessage(socket, pattern, timeoutMs = 10000) {
  let output = "";
  socket.addEventListener("message", (event) => {
    output += event.data;
  });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (output.includes(pattern)) return output;
    await delay(100);
  }
  throw new Error(`Timeout esperando salida ${pattern}`);
}

const { server, port } = await startServer({
  port: 0,
  dataDir,
  publicDir: join(rootDir, "public"),
  vendorDir: join(rootDir, "node_modules")
});

let ok = false;
try {
  const project = await api(port, "/api/projects", { method: "POST", body: { name: "MobileProject", path: projectDir } });
  const mobileHtml = await fetch(`http://127.0.0.1:${port}/mobile/`).then((response) => response.text());
  if (!mobileHtml.includes("MultiTerminalAI Remote")) throw new Error("La app movil no se sirve correctamente.");
  const session = await api(port, `/api/projects/${project.id}/sessions`, {
    method: "POST",
    body: { name: "Mobile shell", command: "", shell: process.platform === "win32" ? "cmd" : "bash" }
  });

  const pair = await api(port, "/api/remote/pair-code", { method: "POST" });
  if (!pair.qr?.startsWith("data:image/png;base64,")) throw new Error("No se genero QR de emparejamiento.");
  const request = await api(port, "/api/mobile/pair", { method: "POST", body: { code: pair.code, deviceName: "E2E Phone" } });
  const remote = await api(port, "/api/remote/state");
  if (!remote.pending.some((item) => item.id === request.requestId)) throw new Error("La solicitud movil no quedo pendiente.");

  await api(port, `/api/remote/pending/${request.requestId}/accept`, { method: "POST" });
  const accepted = await api(port, `/api/mobile/pair/${request.requestId}`);
  if (accepted.status !== "accepted" || !accepted.token) throw new Error("El movil no recibio token tras aceptar.");

  const mobileProjects = await api(port, "/api/mobile/projects", {
    headers: { authorization: `Bearer ${accepted.token}` }
  });
  if (!mobileProjects.projects.some((item) => item.name === "MobileProject")) throw new Error("El movil no puede listar proyectos.");

  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/mobile-terminal?project=${project.id}&session=${session.id}&cols=100&rows=30&token=${encodeURIComponent(accepted.token)}`
  );
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  socket.send(JSON.stringify({ type: "data", data: "echo MOBILE_OK\r" }));
  await waitForMessage(socket, "MOBILE_OK");
  socket.close();

  const reconnect = new WebSocket(
    `ws://127.0.0.1:${port}/mobile-terminal?project=${project.id}&session=${session.id}&cols=100&rows=30&token=${encodeURIComponent(accepted.token)}`
  );
  await new Promise((resolveOpen, rejectOpen) => {
    reconnect.addEventListener("open", resolveOpen, { once: true });
    reconnect.addEventListener("error", rejectOpen, { once: true });
  });
  await waitForMessage(reconnect, "MOBILE_OK");
  reconnect.send(JSON.stringify({ type: "data", data: process.platform === "win32" ? "exit\r" : "exit\r" }));
  reconnect.close();

  console.log("Mobile remote E2E OK: pairing, token, projects, reconnect and mobile terminal work.");
  ok = true;
} finally {
  server.close();
  if (ok) process.exit(0);
}
