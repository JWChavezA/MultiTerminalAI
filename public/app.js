const state = {
  projects: [],
  selectedProjectId: null,
  selectedSessionId: null,
  view: "terminal",
  socket: null,
  lastTerminalData: "",
  terminal: null,
  fitAddon: null
};

const $ = (selector) => document.querySelector(selector);
const projectList = $("#projectList");
const terminalHost = $("#terminal");
const actionMenu = $("#actionMenu");
const terminalPanel = document.querySelector(".terminal-panel");
const remotePanel = $("#remotePanel");
const defaultShell = navigator.platform.toLowerCase().includes("win") ? "powershell" : "bash";

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Error inesperado.");
  return data;
}

function selectedProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId);
}

function selectedSession() {
  return selectedProject()?.sessions.find((session) => session.id === state.selectedSessionId);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function uniqueSessionName(project) {
  const base = "Nuevo chat";
  const names = new Set(project.sessions.map((session) => session.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function render() {
  const project = selectedProject();
  const session = selectedSession();

  projectList.innerHTML = "";
  for (const item of state.projects) {
    const group = document.createElement("section");
    group.className = "project-group";
    group.innerHTML = `
      <div class="project-heading ${item.id === state.selectedProjectId ? "active" : ""}">
        <button class="project-select" data-project="${escapeHtml(item.id)}">
          <span>${escapeHtml(item.name)}</span>
        </button>
        <button class="icon-button menu-project" data-project="${escapeHtml(item.id)}">...</button>
      </div>
      <div class="session-list"></div>
    `;

    const sessionList = group.querySelector(".session-list");
    for (const child of item.sessions) {
      const row = document.createElement("div");
      row.className = `session-row ${child.id === state.selectedSessionId ? "active" : ""}`;
      row.innerHTML = `
        <button class="session-select" data-project="${escapeHtml(item.id)}" data-session="${escapeHtml(child.id)}">
          <span>${escapeHtml(child.name)}</span>
          <small>${escapeHtml(child.command || child.shell || defaultShell)}</small>
        </button>
        <button class="icon-button menu-session" data-project="${escapeHtml(item.id)}" data-session="${escapeHtml(child.id)}">...</button>
      `;
      sessionList.append(row);
    }

    projectList.append(group);
  }

  $("#projectName").textContent = project?.name || "Sin proyecto";
  $("#projectPath").textContent = project ? project.path : "Abre una carpeta para empezar.";
  $("#sessionName").textContent = session?.name || "Nuevo chat";
  $("#newSession").disabled = !project;
  $("#sessionMenuButton").disabled = !session;
  $("#openNative").disabled = !session;
  $("#connectTerminal").disabled = !session;
  $("#restartTerminal").disabled = !session;
  terminalPanel.hidden = state.view !== "terminal";
  remotePanel.hidden = state.view !== "remote";
}

function disconnect() {
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

function ensureTerminal() {
  if (state.terminal) return;
  state.fitAddon = new FitAddon.FitAddon();
  state.terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    theme: {
      background: "#0f1115",
      foreground: "#e8eaed",
      cursor: "#f4f4f5",
      selectionBackground: "#3a3a3d"
    }
  });
  state.terminal.loadAddon(state.fitAddon);
  state.terminal.open(terminalHost);
  state.terminal.write("Abre una carpeta y crea un chat.\r\n");
  state.terminal.onData((data) => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "data", data }));
    }
  });
  window.addEventListener("resize", fitTerminal);
}

function fitTerminal() {
  if (!state.terminal || !state.fitAddon) return;
  state.fitAddon.fit();
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "resize", cols: state.terminal.cols, rows: state.terminal.rows }));
  }
}

function connectTerminal() {
  const project = selectedProject();
  const session = selectedSession();
  if (!project || !session) return;
  ensureTerminal();
  disconnect();
  state.terminal.clear();
  state.terminal.write(`Conectando ${project.name} / ${session.name}...\r\n`);
  fitTerminal();
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(
    `${scheme}://${location.host}/terminal?project=${project.id}&session=${session.id}&cols=${state.terminal.cols}&rows=${state.terminal.rows}`
  );
  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "data") {
      state.lastTerminalData += message.data;
      state.lastTerminalData = state.lastTerminalData.slice(-20000);
      state.terminal.write(message.data);
    }
  });
  state.socket.addEventListener("open", () => {
    fitTerminal();
    state.terminal.focus();
    render();
  });
  state.socket.addEventListener("close", () => {
    state.socket = null;
    render();
  });
}

async function load() {
  const data = await api("/api/state");
  state.projects = data.projects || [];
  if (!selectedProject()) state.selectedProjectId = state.projects[0]?.id || null;
  if (!selectedSession()) state.selectedSessionId = selectedProject()?.sessions[0]?.id || null;
  render();
}

async function loadRemoteState() {
  const remote = await api("/api/remote/state");
  $("#pendingConnections").innerHTML =
    remote.pending.length === 0
      ? `<p class="empty">No hay solicitudes pendientes.</p>`
      : remote.pending
          .map(
            (item) => `
              <div class="remote-row">
                <div><strong>${escapeHtml(item.deviceName)}</strong><br /><small>${escapeHtml(item.createdAt)}</small></div>
                <div class="actions">
                  <button data-accept="${escapeHtml(item.id)}">Aceptar</button>
                  <button class="danger" data-reject="${escapeHtml(item.id)}">Rechazar</button>
                </div>
              </div>
            `
          )
          .join("");

  $("#authorizedConnections").innerHTML =
    remote.connections.length === 0
      ? `<p class="empty">No hay telefonos autorizados.</p>`
      : remote.connections
          .map(
            (item) => `
              <div class="remote-row">
                <div><strong>${escapeHtml(item.deviceName)}</strong><br /><small>Ultimo uso: ${escapeHtml(item.lastSeenAt)}</small></div>
                <button class="danger" data-revoke="${escapeHtml(item.id)}">Revocar</button>
              </div>
            `
          )
          .join("");
}

async function openFolderProject() {
  const picked = await api("/api/pick-folder", { method: "POST" });
  if (picked.canceled) return;

  const existing = state.projects.find((project) => project.path.toLowerCase() === picked.path.toLowerCase());
  if (existing) {
    state.selectedProjectId = existing.id;
    state.selectedSessionId = existing.sessions[0]?.id || null;
    await load();
    return;
  }

  const project = await api("/api/projects", {
    method: "POST",
    body: { name: picked.name || "Proyecto", path: picked.path }
  });
  state.selectedProjectId = project.id;
  state.selectedSessionId = null;
  await load();
}

async function createSession() {
  let project = selectedProject();
  if (!project) {
    await openFolderProject();
    project = selectedProject();
    if (!project) return;
  }

  const created = await api(`/api/projects/${project.id}/sessions`, {
    method: "POST",
    body: { name: uniqueSessionName(project), command: "", shell: defaultShell }
  });
  state.selectedSessionId = created.id;
  await load();
  connectTerminal();
}

async function renameProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const name = prompt("Nombre del proyecto", project.name)?.trim();
  if (!name || name === project.name) return;
  await api(`/api/projects/${project.id}`, { method: "PUT", body: { name, path: project.path } });
  await load();
}

async function deleteProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project || !confirm(`Eliminar "${project.name}" de la lista?`)) return;
  await api(`/api/projects/${project.id}`, { method: "DELETE" });
  state.selectedProjectId = null;
  state.selectedSessionId = null;
  disconnect();
  await load();
}

async function renameSession(projectId, sessionId) {
  const project = state.projects.find((item) => item.id === projectId);
  const session = project?.sessions.find((item) => item.id === sessionId);
  if (!project || !session) return;
  const name = prompt("Nombre del chat", session.name)?.trim();
  if (!name || name === session.name) return;
  await api(`/api/projects/${project.id}/sessions/${session.id}`, {
    method: "PUT",
    body: { ...session, name }
  });
  await load();
}

async function deleteSession(projectId, sessionId) {
  const project = state.projects.find((item) => item.id === projectId);
  const session = project?.sessions.find((item) => item.id === sessionId);
  if (!project || !session || !confirm(`Eliminar "${session.name}"?`)) return;
  await api(`/api/projects/${project.id}/sessions/${session.id}`, { method: "DELETE" });
  if (state.selectedSessionId === session.id) {
    disconnect();
    state.selectedSessionId = null;
  }
  await load();
}

function showMenu(button, items) {
  actionMenu.innerHTML = "";
  const rect = button.getBoundingClientRect();
  actionMenu.style.left = `${Math.min(rect.left, window.innerWidth - 190)}px`;
  actionMenu.style.top = `${rect.bottom + 6}px`;
  for (const item of items) {
    const entry = document.createElement("button");
    entry.textContent = item.label;
    entry.className = item.danger ? "danger" : "";
    entry.addEventListener("click", async () => {
      actionMenu.hidden = true;
      await item.run();
    });
    actionMenu.append(entry);
  }
  actionMenu.hidden = false;
}

projectList.addEventListener("click", async (event) => {
  const projectButton = event.target.closest(".project-select");
  const sessionButton = event.target.closest(".session-select");
  const projectMenu = event.target.closest(".menu-project");
  const sessionMenu = event.target.closest(".menu-session");

  if (projectButton) {
    state.view = "terminal";
    state.selectedProjectId = projectButton.dataset.project;
    state.selectedSessionId = selectedProject()?.sessions[0]?.id || null;
    disconnect();
    render();
  }

  if (sessionButton) {
    state.view = "terminal";
    state.selectedProjectId = sessionButton.dataset.project;
    state.selectedSessionId = sessionButton.dataset.session;
    disconnect();
    render();
    connectTerminal();
  }

  if (projectMenu) {
    const projectId = projectMenu.dataset.project;
    showMenu(projectMenu, [
      { label: "Renombrar proyecto", run: () => renameProject(projectId) },
      { label: "Eliminar proyecto", danger: true, run: () => deleteProject(projectId) }
    ]);
  }

  if (sessionMenu) {
    const projectId = sessionMenu.dataset.project;
    const sessionId = sessionMenu.dataset.session;
    showMenu(sessionMenu, [
      { label: "Renombrar chat", run: () => renameSession(projectId, sessionId) },
      { label: "Eliminar chat", danger: true, run: () => deleteSession(projectId, sessionId) }
    ]);
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".action-menu") && !event.target.closest(".icon-button")) {
    actionMenu.hidden = true;
  }
});

$("#newProject").addEventListener("click", openFolderProject);
$("#newSession").addEventListener("click", createSession);
$("#remoteView").addEventListener("click", async () => {
  state.view = "remote";
  disconnect();
  render();
  await loadRemoteState();
});

$("#createPairCode").addEventListener("click", async () => {
  const pair = await api("/api/remote/pair-code", { method: "POST" });
  const box = $("#pairCodeBox");
  box.hidden = false;
  box.innerHTML = `
    <img class="pair-qr" src="${escapeHtml(pair.qr)}" alt="QR de emparejamiento" />
    <strong>Codigo:</strong> ${escapeHtml(pair.code)}
    <strong>Enlace:</strong> ${escapeHtml(pair.url)}
    <small>Abre este enlace desde el telefono conectado a Tailscale. Expira en 10 minutos.</small>
  `;
});

remotePanel.addEventListener("click", async (event) => {
  const accept = event.target.closest("[data-accept]");
  const reject = event.target.closest("[data-reject]");
  const revoke = event.target.closest("[data-revoke]");

  if (accept) await api(`/api/remote/pending/${accept.dataset.accept}/accept`, { method: "POST" });
  if (reject) await api(`/api/remote/pending/${reject.dataset.reject}/reject`, { method: "POST" });
  if (revoke && confirm("Revocar este telefono?")) await api(`/api/remote/connections/${revoke.dataset.revoke}`, { method: "DELETE" });
  if (accept || reject || revoke) await loadRemoteState();
});
$("#sessionMenuButton").addEventListener("click", (event) => {
  const project = selectedProject();
  const session = selectedSession();
  if (!project || !session) return;
  showMenu(event.currentTarget, [
    { label: "Renombrar chat", run: () => renameSession(project.id, session.id) },
    { label: "Eliminar chat", danger: true, run: () => deleteSession(project.id, session.id) }
  ]);
});

$("#clearTerminal").addEventListener("click", () => {
  ensureTerminal();
  state.terminal.clear();
});

$("#openNative").addEventListener("click", async () => {
  const project = selectedProject();
  const session = selectedSession();
  if (!project || !session) return;
  await api(`/api/projects/${project.id}/sessions/${session.id}/open`, { method: "POST" });
});

$("#connectTerminal").addEventListener("click", connectTerminal);

$("#restartTerminal").addEventListener("click", async () => {
  const project = selectedProject();
  const session = selectedSession();
  if (!project || !session) return;
  disconnect();
  await api(`/api/projects/${project.id}/sessions/${session.id}/stop`, { method: "POST" });
  connectTerminal();
});

load().catch((error) => {
  ensureTerminal();
  state.terminal.write(`${error.message}\r\n`);
});

ensureTerminal();
