import electronPath from "electron";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = join(rootDir, ".tmp-button-qa");
const projectDir = join(testRoot, "ButtonProject");
const userDataDir = join(testRoot, "userData");
const debugPort = 9344;
const results = [];

rmSync(testRoot, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
writeFileSync(join(projectDir, "README.txt"), "button qa\n");

function pass(name, detail = "") {
  results.push({ ok: true, name, detail });
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
}

function fail(name, error) {
  results.push({ ok: false, name, detail: error?.message || String(error) });
  console.log(`FAIL ${name} - ${error?.message || error}`);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, options);
      const data = await response.json();
      if (response.ok) return data;
      lastError = new Error(data.error || `HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw lastError || new Error(`Timeout ${url}`);
}

async function waitForTarget() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`, {}, 3000);
    const page = targets.find((target) => target.type === "page");
    if (page) return page;
    await delay(250);
  }
  throw new Error("No CDP page target found.");
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callbacks = pending.get(message.id);
      if (!callbacks) return;
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(message.error.message));
      else callbacks.resolve(message.result);
      return;
    }
    listeners.get(message.method)?.forEach((fn) => fn(message.params));
  });
  return {
    send(method, params = {}) {
      id += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
    },
    close() {
      socket.close();
    }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime exception";
    throw new Error(text);
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(cdp, `Boolean((${expression})())`)) return;
    await delay(150);
  }
  throw new Error(`Timeout waiting for ${expression}`);
}

async function click(cdp, selector, label = selector) {
  const rect = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, disabled: !!el.disabled };
  })()`);
  if (!rect) throw new Error(`Missing ${label}`);
  if (rect.disabled) throw new Error(`${label} disabled`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function domClick(cdp, selector, label = selector) {
  const clicked = await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Missing ${label}`);
}

async function typeText(cdp, text) {
  for (const char of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: char });
  }
}

async function runStep(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

const child = spawn(electronPath, ["."] , {
  cwd: rootDir,
  env: {
    ...process.env,
    MULTITERMINALAI_TEST_FOLDER: projectDir,
    MULTITERMINALAI_USER_DATA: userDataDir,
    MULTITERMINALAI_REMOTE_DEBUG_PORT: String(debugPort)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let appPort = null;
child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  const match = text.match(/http:\/\/[^:]+:(\d+)/);
  if (match) appPort = Number(match[1]);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let cdp;
try {
  const target = await waitForTarget();
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const dialogStub = `
    window.confirm = () => true;
    window.prompt = (message = "", value = "") => String(message).includes("proyecto") ? "ButtonProject Renamed" : "Chat Renamed";
  `;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: dialogStub });
  await evaluate(cdp, dialogStub);
  cdp.on("Page.javascriptDialogOpening", async (event) => {
    const accept = event.type === "prompt" || event.type === "confirm" || event.type === "alert";
    const promptText = event.message.includes("proyecto") ? "ButtonProject Renamed" : "Chat Renamed";
    await cdp.send("Page.handleJavaScriptDialog", { accept, promptText }).catch(() => {});
  });

  await waitFor(cdp, `() => document.querySelector("#newProject") && ${JSON.stringify(Boolean(appPort))}`);

  await runStep("desktop initial disabled controls", async () => {
    const disabled = await evaluate(cdp, `["#newSession","#connectTerminal","#restartTerminal","#openNative","#sessionMenuButton"].every((s) => document.querySelector(s)?.disabled)`);
    if (!disabled) throw new Error("Expected startup controls to be disabled.");
  });

  await runStep("desktop Limpiar", () => click(cdp, "#clearTerminal", "Limpiar"));
  await runStep("desktop Abrir carpeta", async () => {
    await click(cdp, "#newProject", "Abrir carpeta");
    await waitFor(cdp, `() => document.body.textContent.includes("ButtonProject")`);
  });
  await runStep("desktop Nuevo chat", async () => {
    await click(cdp, "#newSession", "Nuevo chat");
    await waitFor(cdp, `() => state.socket?.readyState === WebSocket.OPEN`, 20000);
  });
  await runStep("desktop Iniciar", async () => {
    await click(cdp, "#connectTerminal", "Iniciar");
    await waitFor(cdp, `() => state.socket?.readyState === WebSocket.OPEN`, 20000);
  });
  await runStep("desktop Reiniciar", async () => {
    await click(cdp, "#restartTerminal", "Reiniciar");
    await waitFor(cdp, `() => state.socket?.readyState === WebSocket.OPEN`, 20000);
  });
  await runStep("desktop project/session select", async () => {
    await click(cdp, ".project-select", "project select");
    await click(cdp, ".session-select", "session select");
    await waitFor(cdp, `() => state.socket?.readyState === WebSocket.OPEN`, 20000);
  });
  await runStep("desktop session menu opens", async () => {
    await click(cdp, "#sessionMenuButton", "session menu");
    await waitFor(cdp, `() => !document.querySelector("#actionMenu").hidden && document.querySelector("#actionMenu").textContent.includes("Renombrar chat")`);
  });
  await runStep("desktop Renombrar chat", async () => {
    await click(cdp, "#actionMenu button", "Renombrar chat");
    await waitFor(cdp, `() => document.body.textContent.includes("Chat Renamed")`);
  });
  await runStep("desktop project menu opens", async () => {
    await click(cdp, ".menu-project", "project menu");
    await waitFor(cdp, `() => !document.querySelector("#actionMenu").hidden && document.querySelector("#actionMenu").textContent.includes("Renombrar proyecto")`);
  });
  await runStep("desktop Renombrar proyecto", async () => {
    await click(cdp, "#actionMenu button", "Renombrar proyecto");
    await waitFor(cdp, `() => document.body.textContent.includes("ButtonProject Renamed")`);
  });

  await runStep("desktop Remoto", async () => {
    await click(cdp, "#remoteView", "Remoto");
    await waitFor(cdp, `() => !document.querySelector("#remotePanel").hidden`);
  });
  await runStep("desktop Crear enlace de emparejamiento", async () => {
    await click(cdp, "#createPairCode", "Crear enlace");
    await waitFor(cdp, `() => document.querySelector("#pairCodeBox img") && document.querySelector("#pairCodeBox").textContent.includes("Codigo")`);
  });
  await runStep("desktop popup Rechazar", async () => {
    const pair = await fetchJson(`http://127.0.0.1:${appPort}/api/remote/pair-code`, { method: "POST" });
    await fetchJson(`http://127.0.0.1:${appPort}/api/mobile/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pair.code, deviceName: "Popup Reject" })
    });
    await waitFor(cdp, `() => !document.querySelector("#remoteRequestModal").hidden && document.body.textContent.includes("Popup Reject")`, 10000);
    await click(cdp, "#remoteRequestReject", "popup reject");
    await waitFor(cdp, `() => document.querySelector("#remoteRequestModal").hidden`);
  });
  await runStep("desktop popup Aceptar", async () => {
    const pair = await fetchJson(`http://127.0.0.1:${appPort}/api/remote/pair-code`, { method: "POST" });
    await fetchJson(`http://127.0.0.1:${appPort}/api/mobile/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pair.code, deviceName: "Popup Accept" })
    });
    await waitFor(cdp, `() => !document.querySelector("#remoteRequestModal").hidden && document.body.textContent.includes("Popup Accept")`, 10000);
    await click(cdp, "#remoteRequestAccept", "popup accept");
    await waitFor(cdp, `() => document.querySelector("#remoteRequestModal").hidden`);
  });
  await runStep("desktop Revocar", async () => {
    await waitFor(cdp, `() => document.querySelector("[data-revoke]")`, 10000);
    const before = await evaluate(cdp, `document.querySelectorAll("[data-revoke]").length`);
    await click(cdp, "[data-revoke]", "Revocar");
    await waitFor(cdp, `() => document.querySelectorAll("[data-revoke]").length < ${before}`);
  });
  await runStep("desktop lista Aceptar/Rechazar", async () => {
    let pair = await fetchJson(`http://127.0.0.1:${appPort}/api/remote/pair-code`, { method: "POST" });
    await fetchJson(`http://127.0.0.1:${appPort}/api/mobile/pair`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pair.code, deviceName: "List Accept" })
    });
    await evaluate(cdp, `(async () => {
      const remote = await api("/api/remote/state");
      state.remotePendingIds = new Set(remote.pending.map((item) => item.id));
      hideRemoteRequestModal();
      state.activeRemoteRequest = null;
      await loadRemoteState(remote);
    })()`);
    await waitFor(cdp, `() => document.querySelector("[data-accept]")`);
    await click(cdp, "[data-accept]", "list accept");
    await waitFor(cdp, `() => document.querySelector("[data-revoke]")`);
    await click(cdp, "[data-revoke]", "list revoke");

    pair = await fetchJson(`http://127.0.0.1:${appPort}/api/remote/pair-code`, { method: "POST" });
    await fetchJson(`http://127.0.0.1:${appPort}/api/mobile/pair`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pair.code, deviceName: "List Reject" })
    });
    await evaluate(cdp, `(async () => {
      const remote = await api("/api/remote/state");
      state.remotePendingIds = new Set(remote.pending.map((item) => item.id));
      hideRemoteRequestModal();
      state.activeRemoteRequest = null;
      await loadRemoteState(remote);
    })()`);
    await waitFor(cdp, `() => document.querySelector("[data-reject]")`);
    const pendingBeforeReject = await evaluate(cdp, `document.querySelectorAll("[data-reject]").length`);
    await click(cdp, "[data-reject]", "list reject");
    await waitFor(cdp, `() => document.querySelectorAll("[data-reject]").length < ${pendingBeforeReject}`);
  });

  await runStep("mobile pairing button", async () => {
    const pair = await fetchJson(`http://127.0.0.1:${appPort}/api/remote/pair-code`, { method: "POST" });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/mobile/?pair=${encodeURIComponent(pair.code)}` });
    await waitFor(cdp, `() => document.querySelector("#pairButton")`);
    await evaluate(cdp, `document.querySelector("#deviceName").value = "Mobile Button"`);
    await click(cdp, "#pairButton", "Solicitar acceso");
    await waitFor(cdp, `() => document.querySelector("#pairStatus").textContent.includes("Esperando")`);
    const remote = await fetchJson(`http://127.0.0.1:${appPort}/api/remote/state`);
    const request = remote.pending.find((item) => item.deviceName === "Mobile Button");
    if (!request) throw new Error("No mobile pending request.");
    await fetchJson(`http://127.0.0.1:${appPort}/api/remote/pending/${request.id}/accept`, { method: "POST" });
    await waitFor(cdp, `() => document.body.textContent.includes("ButtonProject Renamed") || document.body.textContent.includes("ButtonProject")`, 20000);
  });
  await runStep("mobile project expand/new chat/open chat", async () => {
    await click(cdp, ".project-header", "project header");
    await waitFor(cdp, `() => document.querySelector(".project-chats.expanded .new-chat-row")`);
    await domClick(cdp, ".project-chats.expanded .new-chat-row", "mobile new chat");
    await waitFor(cdp, `() => document.querySelector("#terminalView") && !document.querySelector("#terminalView").hidden`, 20000);
    await click(cdp, "#terminalBack", "terminal back");
    await waitFor(cdp, `() => document.querySelector("#homeView") && !document.querySelector("#homeView").hidden`, 10000);
    await click(cdp, ".project-header", "project header reopen");
    await waitFor(cdp, `() => document.querySelector(".project-chats.expanded .chat-row")`);
    await domClick(cdp, ".project-chats.expanded .chat-row", "mobile chat row");
    await waitFor(cdp, `() => document.querySelector("#terminalView") && !document.querySelector("#terminalView").hidden`, 20000);
  });
  await runStep("mobile key bar buttons", async () => {
    const count = await evaluate(cdp, `(() => {
      const buttons = [document.querySelector("#ctrlKey"), ...document.querySelectorAll("#keyBar [data-seq]")].filter(Boolean);
      buttons.forEach((button) => button.click());
      return buttons.length;
    })()`);
    if (count < 7) throw new Error(`Expected 7 key buttons, clicked ${count}.`);
  });
  await runStep("mobile terminal paste/menu/back", async () => {
    await click(cdp, "#terminalPaste", "terminal paste");
    await click(cdp, "#terminalMore", "terminal more");
    await waitFor(cdp, `() => !document.querySelector("#terminalMenu").hidden`);
    for (const action of ["urlscan", "copySelection", "paste", "restart", "disconnect"]) {
      await click(cdp, `[data-action="${action}"]`, action);
      if (action === "restart") {
        await waitFor(cdp, `() => !document.querySelector("#terminalView").hidden`, 10000);
        await click(cdp, "#terminalMore", "terminal more reopen");
      } else if (action !== "disconnect") {
        await click(cdp, "#terminalMore", "terminal more reopen");
      }
    }
    await waitFor(cdp, `() => !document.querySelector("#homeView").hidden`, 10000);
  });
  await runStep("mobile connections buttons visible", async () => {
    await evaluate(cdp, `showConnectionsManager()`);
    await waitFor(cdp, `() => !document.querySelector("#connectionsView").hidden`);
    await click(cdp, "#connScanButton", "conn scan");
    await waitFor(cdp, `() => document.querySelector("#qrScanner") || document.querySelector("input[type=file]")`, 10000);
    await evaluate(cdp, `document.querySelector("input[type=file]")?.remove(); stopQRScanner?.();`);
    await click(cdp, "#connAddButton", "conn add");
  });

  const failed = results.filter((item) => !item.ok);
  console.log(`\nBUTTON_QA_SUMMARY passed=${results.length - failed.length} failed=${failed.length}`);
  if (failed.length) process.exitCode = 1;
} finally {
  cdp?.close();
  child.kill();
}
