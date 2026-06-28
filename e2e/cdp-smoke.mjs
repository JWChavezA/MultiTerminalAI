import electronPath from "electron";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = join(rootDir, ".tmp-e2e");
const projectDir = join(testRoot, "SmokeProject");
const userDataDir = join(testRoot, "userData");
const debugPort = 9339;

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fetchJson(url, timeoutMs = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error(`Timeout consultando ${url}`);
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });

  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message));
    else callbacks.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      id += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    }
  };
}

async function waitForPageTarget() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, 3000);
    const page = targets.find((target) => target.type === "page");
    if (page) return page;
    await delay(250);
  }
  throw new Error("No se encontro la pagina de Electron por CDP.");
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate fallo");
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(cdp, `Boolean((${expression})())`)) return;
    await delay(200);
  }
  throw new Error(`Timeout esperando: ${expression}`);
}

const child = spawn(electronPath, ["."], {
  cwd: rootDir,
  env: {
    ...process.env,
    MULTITERMINALAI_TEST_FOLDER: projectDir,
    MULTITERMINALAI_USER_DATA: userDataDir,
    MULTITERMINALAI_REMOTE_DEBUG_PORT: String(debugPort)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let cdp;
try {
  const page = await waitForPageTarget();

  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  await waitFor(cdp, `() => document.querySelector("#newProject")`);
  await evaluate(cdp, `document.querySelector("#newProject").click()`);
  await waitFor(cdp, `() => document.body.textContent.includes("SmokeProject")`);

  await evaluate(cdp, `document.querySelector("#newSession").click()`);
  await waitFor(cdp, `() => document.body.textContent.includes("Nuevo chat")`);
  await waitFor(cdp, `() => state.socket?.readyState === WebSocket.OPEN`, 20000);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  await evaluate(cdp, `state.socket.send(JSON.stringify({ type: "data", data: "echo E2E_OK\\r" }))`);
  await waitFor(cdp, `() => state.lastTerminalData.includes("E2E_OK") || (document.querySelector(".xterm-rows")?.textContent || "").includes("E2E_OK")`, 20000);

  const body = await evaluate(cdp, `document.body.textContent`);
  const terminalText = await evaluate(cdp, `document.querySelector(".xterm-rows")?.textContent || ""`);

  if (!body.includes("SmokeProject")) throw new Error("No se creo/selecciono el proyecto.");
  if (!body.includes("Nuevo chat")) throw new Error("No se creo el chat por defecto.");
  const terminalData = await evaluate(cdp, `state.lastTerminalData`);
  if (!terminalText.includes("E2E_OK") && !terminalData.includes("E2E_OK")) {
    throw new Error("La terminal integrada no ejecuto el comando de prueba.");
  }

  console.log("E2E OK: carpeta, chat y terminal integrada funcionan.");
} finally {
  cdp?.close();
  child.kill();
}
