const mobileState = {
  token: localStorage.getItem("mtai_token") || "",
  projects: [],
  selectedProjectId: "",
  selectedSessionId: "",
  socket: null,
  terminal: null,
  fitAddon: null
};

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);

function show(view) {
  $("#pairView").hidden = view !== "pair";
  $("#homeView").hidden = view !== "home";
  $("#terminalView").hidden = view !== "terminal";
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (mobileState.token) headers.authorization = `Bearer ${mobileState.token}`;
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Error");
  return data;
}

function renderHome(data) {
  $("#computerName").textContent = data.computerName || "PC";
  const query = $("#searchInput").value.trim().toLowerCase();
  const projects = data.projects || [];
  mobileState.projects = projects;

  $("#projectList").innerHTML = projects
    .filter((project) => project.name.toLowerCase().includes(query))
    .map((project) => `<button class="project-row" data-project="${project.id}">▱ <span>${project.name}</span></button>`)
    .join("");

  const recents = projects.flatMap((project) => project.sessions.map((session) => ({ ...session, project }))).slice(0, 8);
  $("#recentList").innerHTML = recents
    .filter((session) => session.name.toLowerCase().includes(query))
    .map(
      (session) =>
        `<button class="recent-row" data-project="${session.project.id}" data-session="${session.id}"><span>${session.name}</span><small>${session.shell || ""}</small></button>`
    )
    .join("");
}

async function loadHome() {
  if (!mobileState.token) {
    show("pair");
    return;
  }
  const data = await api("/api/mobile/projects");
  renderHome(data);
  show("home");
}

function ensureTerminal() {
  if (mobileState.terminal) return;
  mobileState.fitAddon = new FitAddon.FitAddon();
  mobileState.terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
    fontSize: 12,
    theme: {
      background: "#090b0f",
      foreground: "#f4f4f5",
      cursor: "#3385ff"
    }
  });
  mobileState.terminal.loadAddon(mobileState.fitAddon);
  mobileState.terminal.open($("#mobileTerminal"));
  mobileState.terminal.onData((data) => {
    if (mobileState.socket?.readyState === WebSocket.OPEN) {
      const transformed = typeof applyCtrlIfArmed === "function" ? applyCtrlIfArmed(data) : data;
      mobileState.socket.send(JSON.stringify({ type: "data", data: transformed }));
    }
  });
  window.addEventListener("resize", fitTerminal);
}

function fitTerminal() {
  if (!mobileState.fitAddon) return;
  mobileState.fitAddon.fit();
  if (mobileState.socket?.readyState === WebSocket.OPEN) {
    mobileState.socket.send(JSON.stringify({ type: "resize", cols: mobileState.terminal.cols, rows: mobileState.terminal.rows }));
  }
}

function connectTerminal(projectId, sessionId) {
  const project = mobileState.projects.find((item) => item.id === projectId);
  const session = project?.sessions.find((item) => item.id === sessionId);
  if (!project || !session) return;

  mobileState.selectedProjectId = projectId;
  mobileState.selectedSessionId = sessionId;
  $("#terminalTitle").textContent = session.name;
  $("#terminalSubtitle").textContent = project.name;
  show("terminal");
  ensureTerminal();
  mobileState.terminal.clear();
  mobileState.terminal.write(`Conectando ${project.name} / ${session.name}...\r\n`);
  fitTerminal();

  mobileState.socket?.close();
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  mobileState.socket = new WebSocket(
    `${scheme}://${location.host}/mobile-terminal?project=${projectId}&session=${sessionId}&cols=${mobileState.terminal.cols}&rows=${mobileState.terminal.rows}&token=${encodeURIComponent(mobileState.token)}`
  );
  mobileState.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "data") mobileState.terminal.write(message.data);
  });
  mobileState.socket.addEventListener("open", () => {
    fitTerminal();
    mobileState.terminal.focus();
  });
}

async function requestPair() {
  const code = $("#pairCode").value.trim();
  const deviceName = $("#deviceName").value.trim() || navigator.userAgent.split(" ")[0] || "Telefono";
  $("#pairStatus").textContent = "Esperando aprobación en el ordenador...";
  const result = await api("/api/mobile/pair", { method: "POST", body: { code, deviceName } });
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const status = await api(`/api/mobile/pair/${result.requestId}`);
    if (status.status === "accepted") {
      mobileState.token = status.token;
      localStorage.setItem("mtai_token", status.token);
      await loadHome();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  $("#pairStatus").textContent = "La solicitud sigue pendiente. Vuelve a intentar en un momento.";
}

$("#pairButton").addEventListener("click", () => requestPair().catch((error) => ($("#pairStatus").textContent = error.message)));
$("#projectList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-project]");
  if (!button) return;
  const project = mobileState.projects.find((item) => item.id === button.dataset.project);
  const session = project?.sessions[0];
  if (session) connectTerminal(project.id, session.id);
});
$("#recentList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-session]");
  if (button) connectTerminal(button.dataset.project, button.dataset.session);
});
$("#searchInput").addEventListener("input", () => renderHome({ computerName: $("#computerName").textContent, projects: mobileState.projects }));
$("#chatButton").addEventListener("click", async () => {
  const project = mobileState.projects[0];
  if (!project) return;
  const session = await api(`/api/mobile/projects/${project.id}/sessions`, {
    method: "POST",
    body: { name: "Nuevo chat", command: "", shell: navigator.platform.toLowerCase().includes("win") ? "powershell" : "bash" }
  });
  project.sessions.unshift(session);
  renderHome({ computerName: $("#computerName").textContent, projects: mobileState.projects });
  connectTerminal(project.id, session.id);
});
$("#terminalBack").addEventListener("click", () => {
  mobileState.socket?.close();
  show("home");
});
$("#terminalRestart").addEventListener("click", () => connectTerminal(mobileState.selectedProjectId, mobileState.selectedSessionId));
$("#commandForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("#commandInput").value;
  if (value && mobileState.socket?.readyState === WebSocket.OPEN) {
    const transformed = typeof applyCtrlIfArmed === "function" ? applyCtrlIfArmed(value) : value;
    mobileState.socket.send(JSON.stringify({ type: "data", data: `${transformed}\r` }));
    $("#commandInput").value = "";
  }
});

// Teclas rapidas: flechas, Esc, Tab, Del mandan secuencias ANSI por el socket.
// Ctrl queda armado y convierte el PROXIMO caracter en Ctrl+key (ASCII 1..26).
// Cuando el modo Ctrl esta activo, al escribir en el terminal o en el input command,
// el caracter se envia como Ctrl+letter por el socket.
function sendSocketData(data) {
  if (mobileState.socket?.readyState === WebSocket.OPEN) {
    mobileState.socket.send(JSON.stringify({ type: "data", data }));
  }
}

const ctrlKey = $("#ctrlKey");
if (ctrlKey) {
  ctrlKey.addEventListener("click", () => {
    ctrlKey.classList.toggle("active");
  });
}

// Toggle del teclado nativo: si esta visible, lo ocultamos (deja el WebView con foco);
// si no, lo mostramos y damos foco al input command.
const showKeyboard = $("#showKeyboard");
if (showKeyboard) {
  showKeyboard.addEventListener("click", () => {
    const inputFocused = document.activeElement === commandInput;
    if (inputFocused) {
      // Devolver foco al xterm y ocultar teclado nativo
      mobileState.terminal?.focus();
      commandInput?.blur();
    } else {
      commandInput?.focus();
    }
  });
}

document.querySelectorAll("#keyBar .key[data-seq]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const seq = btn.dataset.seq || "";
    sendSocketData(seq);
    // Tras enviar, devuelve foco al terminal para que el usuario pueda seguir escribiendo
    mobileState.terminal?.focus();
  });
});

// Interceptar el siguiente input (terminal o commandInput) cuando Ctrl este activo.
function applyCtrlIfArmed(raw) {
  if (!ctrlKey?.classList.contains("active")) return raw;
  // Para Ctrl+letter: si el caracter es una letra a-z/A-Z, mandar control+letra (1..26)
  // Otros caracteres (flechas, espacios) pasan normales.
  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code >= 0x61 && code <= 0x7a) {
      ctrlKey.classList.remove("active");
      return String.fromCharCode(code - 0x60); // Ctrl+a..z
    }
    if (code >= 0x41 && code <= 0x5a) {
      ctrlKey.classList.remove("active");
      return String.fromCharCode(code - 0x40); // Ctrl+A..Z
    }
  }
  return raw;
}

// Hook del input command: si Ctrl esta armado y se mete UN SOLO caracter,
// lo enviamos inmediatamente como Ctrl+key y vaciamos el input.
const commandInput = $("#commandInput");
if (commandInput) {
  commandInput.addEventListener("input", () => {
    if (!ctrlKey?.classList.contains("active")) return;
    const value = commandInput.value;
    if (value.length === 0) return;
    const transformed = applyCtrlIfArmed(value);
    if (transformed !== value) {
      sendSocketData(transformed);
      commandInput.value = "";
    }
  });
}

$("#pairCode").value = params.get("pair") || "";
$("#deviceName").value = localStorage.getItem("mtai_device_name") || "Mi teléfono";
loadHome().catch(() => show("pair"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/mobile/sw.js").catch(() => {});
}
