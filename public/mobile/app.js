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
  $("#connectionsView").hidden = view !== "connections";
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
    .map((project) => `<button class="project-row" data-project="${project.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span>${project.name}</span></button>`)
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

// back en home = ir al gestor de conexiones
$("#backButton")?.addEventListener("click", () => {
  mobileState.socket?.close();
  NativeBridge.showManager();
});
// terminalRestart fue removido del HTML; el menu "..." ahora tiene la opcion "Reiniciar"
const terminalRestartEl = $("#terminalRestart");
if (terminalRestartEl) {
  terminalRestartEl.addEventListener("click", () => connectTerminal(mobileState.selectedProjectId, mobileState.selectedSessionId));
}
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

// Si llegamos con ?show=connections, mostrar gestor; sino flujo normal
if (params.get("show") === "connections") {
  showConnectionsManager();
} else {
  loadHome().catch(() => show("pair"));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/mobile/sw.js").catch(() => {});
}

// === Connections Manager ===
// Lee conexiones del bridge nativo, las pinta, permite agregar/editar/eliminar/activar.
function showConnectionsManager() {
  const list = $("#connList");
  if (!list) return;

  function render() {
    let conns = [];
    try { conns = JSON.parse(NativeBridge.getConnections() || "[]"); } catch (e) {}
    const activeId = NativeBridge.getActiveId();

    if (conns.length === 0) {
      list.innerHTML = `<div class="conn-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        <p>No tienes conexiones guardadas</p>
        <span>Agrega una para empezar</span>
      </div>`;
      return;
    }

    list.innerHTML = conns.map((c) => {
      const isActive = c.id === activeId;
      const host = (() => { try { return new URL(c.url).host; } catch { return c.url; } })();
      return `
        <div class="conn-card ${isActive ? "active" : ""}" data-id="${c.id}">
          <div class="conn-card-pulse ${isActive ? "on" : ""}"></div>
          <div class="conn-card-body">
            <div class="conn-card-row">
              <strong>${escapeHtml(c.name)}</strong>
              ${isActive ? '<span class="conn-badge">Activa</span>' : ""}
            </div>
            <div class="conn-card-url">${escapeHtml(host)}</div>
          </div>
          <div class="conn-card-actions">
            <button class="conn-icon-btn edit" data-action="edit" data-id="${c.id}" title="Editar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
            <button class="conn-icon-btn delete" data-action="remove" data-id="${c.id}" title="Eliminar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join("");

    // Click en la card = activar (excepto si toca un boton de accion)
    list.querySelectorAll(".conn-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".conn-icon-btn")) return;
        const id = card.dataset.id;
        if (id !== NativeBridge.getActiveId()) {
          NativeBridge.setActive(id);
        }
      });
    });
    list.querySelectorAll(".conn-icon-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (btn.dataset.action === "edit") {
          NativeBridge.edit(id);
        } else if (btn.dataset.action === "remove") {
          if (confirm("¿Eliminar esta conexion?")) {
            NativeBridge.remove(id);
            render();
          }
        }
      });
    });
  }

  $("#connAddButton")?.addEventListener("click", () => NativeBridge.addNew());
  $("#connBackButton")?.addEventListener("click", () => NativeBridge.goToActive());

  show("connections");
  render();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// === Menu de sesion (ConnectBot style) ===
const terminalMenu = $("#terminalMenu");
const terminalMore = $("#terminalMore");
const mobileTerminal = $("#mobileTerminal");
const terminalView = $("#terminalView");
function closeTerminalMenu() {
  if (terminalMenu && !terminalMenu.hidden) terminalMenu.hidden = true;
}
if (terminalMore && terminalMenu) {
  terminalMore.addEventListener("click", (event) => {
    event.stopPropagation();
    terminalMenu.hidden = !terminalMenu.hidden;
  });
  // Cerrar menu al tap en cualquier parte fuera del menu y fuera del boton More.
  // Usamos capture phase para que dispare antes que xterm.js capture sus eventos.
  document.addEventListener("click", (event) => {
    if (terminalMenu.hidden) return;
    if (terminalMenu.contains(event.target)) return;
    if (terminalMore.contains(event.target)) return;
    terminalMenu.hidden = true;
  }, true);
  // Cerrar menu al tap en el area del terminal (xterm) -- xterm.js no propaga clicks al document.
  if (mobileTerminal) {
    mobileTerminal.addEventListener("click", () => closeTerminalMenu());
  }
  // Cerrar menu con ESC
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeTerminalMenu();
  });
}

const terminalScreen = $("#terminalView");
const terminalHeader = $("#terminalHeader");
let autoHide = false;

function showToast(message) {
  const existing = document.querySelector(".copy-toast");
  if (existing) existing.remove();
  const div = document.createElement("div");
  div.className = "copy-toast";
  div.textContent = message;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1600);
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback: text area
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

async function readClipboard() {
  // Intentar clipboard API primero
  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text) return text;
    }
  } catch {}
  // Fallback: pegar el contenido de un textarea temporal.
  // Esto NO funciona sin interaccion del usuario en la mayoria de navegadores,
  // pero al menos muestra el flujo completo si se copia/pega manualmente.
  return "";
}

// Handlers del menu
if (terminalMenu) {
  terminalMenu.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    terminalMenu.hidden = true;

    const sel = mobileState.terminal?.getSelection?.() || "";

    switch (action) {
      case "restart":
        connectTerminal(mobileState.selectedProjectId, mobileState.selectedSessionId);
        break;
      case "disconnect":
        // Solo cierra el WebSocket; el PTY sigue vivo en el desktop
        mobileState.socket?.close();
        showToast("Desconectado. PTY sigue vivo.");
        show("home");
        break;
      case "close":
        // Cierra WebSocket y vuelve al inicio (mismo comportamiento que el back button)
        mobileState.socket?.close();
        show("home");
        break;
      case "autohide":
        autoHide = !autoHide;
        if (terminalScreen) terminalScreen.classList.toggle("no-header", autoHide);
        btn.textContent = autoHide ? "↕ Mostrar barra" : "↕ Ocultar barra";
        setTimeout(() => fitTerminal(), 50);
        break;
      case "urlscan": {
        // Lee el buffer del terminal (ultimas lineas pintadas) y busca URLs
        const buf = mobileState.terminal?.buffer?.active;
        const lines = [];
        if (buf) {
          for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
        }
        const text = lines.join("\n");
        const urlRe = /https?:\/\/[^\s)]+/g;
        const urls = Array.from(new Set(text.match(urlRe) || []));
        if (urls.length === 0) {
          showToast("No se encontraron URLs");
        } else {
          // Abrir la primera (o mostrar lista). Simplificamos: abrir primera.
          window.open(urls[0], "_blank", "noopener");
          showToast(`Abriendo ${urls[0]} (${urls.length} encontradas)`);
        }
        break;
      }
      case "copySelection":
        if (!sel) {
          showToast("Nada seleccionado (long-press en el terminal)");
          break;
        }
        if (await copyToClipboard(sel)) showToast(`Copiado: ${sel.length} chars`);
        else showToast("Error al copiar");
        break;
      case "paste": {
        const text = await readClipboard();
        if (!text) {
          showToast("Portapapeles vacio");
          break;
        }
        sendSocketData(text);
        showToast(`Pegado: ${text.length} chars`);
        break;
      }
    }
  });
}

// Boton Paste en la top bar
const terminalPaste = $("#terminalPaste");
if (terminalPaste) {
  terminalPaste.addEventListener("click", async () => {
    const text = await readClipboard();
    if (!text) { showToast("Portapapeles vacio"); return; }
    sendSocketData(text);
    showToast(`Pegado: ${text.length} chars`);
  });
}

// Long press en el terminal: xterm.js ya hace seleccion built-in (tambien la toolbar de copy en iOS/Android).
// En Android WebView, long-press muestra el menu contextual del sistema (Select text). Eso es suficiente.
// Ademas, xterm expone un boton de "copy" cuando hay seleccion en algunos addons; nosotros usamos terminal.getSelection().
