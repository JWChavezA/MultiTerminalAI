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
  ["#connectionsView", "#pairView", "#homeView", "#terminalView"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = true;
  });
  const target = $("#" + view + "View");
  if (target) target.hidden = false;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (mobileState.token) headers.authorization = `Bearer ${mobileState.token}`;
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "API error");
  return data;
}

// ========== HOME ==========

function renderHome(data) {
  $("#computerName").textContent = data.computerName || "PC";
  const projects = data.projects || [];
  mobileState.projects = projects;

  const list = $("#projectList");
  list.innerHTML = projects.map((project) => {
    const sessions = project.sessions || [];
    const chatsHTML = sessions.map((s) =>
      `<button class="chat-row" data-project="${project.id}" data-session="${s.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span>${escapeHtml(s.name)}</span>
      </button>`
    ).join("");
    return `<div class="project-block">
      <button class="project-header" data-toggle="${project.id}">
        <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        <span>${escapeHtml(project.name)}</span>
        <span class="project-count">${sessions.length}</span>
      </button>
      <div class="project-chats" data-chats="${project.id}">
        ${chatsHTML}
        <button class="new-chat-row" data-new-chat="${project.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
          Nuevo chat
        </button>
      </div>
    </div>`;
  }).join("");

  // Toggle expand/collapse
  list.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.toggle;
      const chats = list.querySelector(`[data-chats="${id}"]`);
      const chevron = btn.querySelector(".chevron");
      const expanded = chats.classList.toggle("expanded");
      if (chevron) chevron.style.transform = expanded ? "rotate(90deg)" : "";
      btn.classList.toggle("open", expanded);
    });
  });

  // Click en chat
  list.querySelectorAll("[data-session]").forEach((btn) => {
    btn.addEventListener("click", () => connectTerminal(btn.dataset.project, btn.dataset.session));
  });

  // Nuevo chat
  list.querySelectorAll("[data-new-chat]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pid = btn.dataset.newChat;
      const project = mobileState.projects.find((p) => p.id === pid);
      if (!project) return;
      const session = await api(`/api/mobile/projects/${pid}/sessions`, {
        method: "POST", body: { name: "Nuevo chat", command: "", shell: "bash" }
      });
      project.sessions.unshift(session);
      renderHome({ computerName: $("#computerName").textContent, projects: mobileState.projects });
      connectTerminal(pid, session.id);
    });
  });
}

async function loadHome() {
  if (!mobileState.token) { show("pair"); return; }
  const data = await api("/api/mobile/projects");
  renderHome(data);
  show("home");
}

// ========== TERMINAL ==========

function ensureTerminal() {
  if (mobileState.terminal) return;
  mobileState.fitAddon = new FitAddon.FitAddon();
  mobileState.terminal = new Terminal({
    cursorBlink: true, convertEol: true,
    fontFamily: 'Menlo, Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    theme: { background: "#080a10", foreground: "#e8eaed", cursor: "#22d3ee", selectionBackground: "#264f3a" }
  });
  mobileState.terminal.loadAddon(mobileState.fitAddon);
  mobileState.terminal.open($("#mobileTerminal"));
  mobileState.terminal.onData((data) => {
    if (mobileState.socket?.readyState === WebSocket.OPEN) {
      const transformed = applyCtrlIfArmed(data);
      mobileState.socket.send(JSON.stringify({ type: "data", data: transformed }));
    }
  });
  window.addEventListener("resize", () => { fitTerminal(); adjustKeyBar(); });
}

function fitTerminal() {
  if (!mobileState.fitAddon) return;
  mobileState.fitAddon.fit();
  if (mobileState.socket?.readyState === WebSocket.OPEN) {
    mobileState.socket.send(JSON.stringify({ type: "resize", cols: mobileState.terminal.cols, rows: mobileState.terminal.rows }));
  }
}

// Key bar se adapta al teclado: fixed encima del IME en todo momento.
function adjustKeyBar() {
  const keyBar = $("#keyBar");
  if (!keyBar) return;
  // Forzar position fixed siempre (así no se mueve al hacer scroll)
  keyBar.style.position = "fixed";
  keyBar.style.left = "0";
  keyBar.style.right = "0";
  if (window.visualViewport) {
    const kbHeight = window.innerHeight - window.visualViewport.height;
    if (kbHeight > 100) {
      // Teclado visible: pegar al borde superior del teclado
      keyBar.style.bottom = kbHeight + "px";
    } else {
      // Teclado oculto: pegar al fondo
      keyBar.style.bottom = "0px";
    }
  } else {
    keyBar.style.bottom = "0px";
  }
  // Ajustar padding del xterm para que el scroll no se esconda bajo la key bar
  const terminal = $(".mobile-terminal");
  if (terminal) {
    const keyBarHeight = keyBar.offsetHeight || 0;
    const kbHeight = window.visualViewport ? (window.innerHeight - window.visualViewport.height) : 0;
    const bottomInset = keyBarHeight + kbHeight;
    terminal.style.paddingBottom = bottomInset + "px";
  }
  // Re-fit del xterm para que use el nuevo espacio
  if (mobileState.fitAddon && mobileState.terminal) {
    setTimeout(() => mobileState.fitAddon.fit(), 30);
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", adjustKeyBar);
  window.visualViewport.addEventListener("scroll", adjustKeyBar);
}
window.addEventListener("scroll", adjustKeyBar);
window.addEventListener("resize", adjustKeyBar);
setTimeout(adjustKeyBar, 100);

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
  mobileState.socket.addEventListener("open", () => { fitTerminal(); mobileState.terminal.focus(); });
}

// ========== PAIRING ==========

async function requestPair() {
  const code = $("#pairCode").value.trim();
  const deviceName = $("#deviceName").value.trim() || navigator.userAgent.split(" ")[0] || "Telefono";
  $("#pairStatus").textContent = "Esperando aprobación...";
  const result = await api("/api/mobile/pair", { method: "POST", body: { code, deviceName } });
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const status = await api(`/api/mobile/pair/${result.requestId}`);
    if (status.status === "accepted") {
      mobileState.token = status.token;
      localStorage.setItem("mtai_token", status.token);
      if (typeof NativeBridge !== "undefined" && NativeBridge.reportToken) NativeBridge.reportToken(status.token);
      await loadHome();
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  $("#pairStatus").textContent = "La solicitud sigue pendiente.";
}

$("#pairButton").addEventListener("click", () => requestPair().catch((error) => ($("#pairStatus").textContent = error.message)));

// ========== BUTTONS ==========

$("#terminalBack").addEventListener("click", () => { mobileState.socket?.close(); show("home"); });
$("#backButton")?.addEventListener("click", () => {
  mobileState.socket?.close();
  if (typeof NativeBridge !== "undefined" && NativeBridge.showManager) NativeBridge.showManager();
});

// ========== KEY BAR ==========

function sendSocketData(data) {
  if (mobileState.socket?.readyState === WebSocket.OPEN) mobileState.socket.send(JSON.stringify({ type: "data", data }));
}

const ctrlKey = $("#ctrlKey");
ctrlKey?.addEventListener("click", () => { ctrlKey.classList.toggle("active"); mobileState.terminal?.focus(); });

document.querySelectorAll("#keyBar .key[data-seq]").forEach((btn) => {
  btn.addEventListener("click", () => { sendSocketData(btn.dataset.seq || ""); mobileState.terminal?.focus(); });
});

function applyCtrlIfArmed(raw) {
  if (!ctrlKey?.classList.contains("active")) return raw;
  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code >= 0x61 && code <= 0x7a) { ctrlKey.classList.remove("active"); return String.fromCharCode(code - 0x60); }
    if (code >= 0x41 && code <= 0x5a) { ctrlKey.classList.remove("active"); return String.fromCharCode(code - 0x40); }
  }
  return raw;
}

// ========== TERMINAL MENU ==========

const terminalMenu = $("#terminalMenu");
const terminalMore = $("#terminalMore");
function closeMenu() { if (terminalMenu && !terminalMenu.hidden) terminalMenu.hidden = true; }

terminalMore?.addEventListener("click", (e) => { e.stopPropagation(); if (terminalMenu) terminalMenu.hidden = !terminalMenu.hidden; });
document.addEventListener("click", (e) => { if (terminalMenu && !terminalMenu.hidden && !terminalMenu.contains(e.target) && !terminalMore.contains(e.target)) terminalMenu.hidden = true; }, true);
$("#mobileTerminal")?.addEventListener("click", closeMenu);

terminalMenu?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  terminalMenu.hidden = true;
  const sel = mobileState.terminal?.getSelection?.() || "";

  switch (action) {
    case "restart": connectTerminal(mobileState.selectedProjectId, mobileState.selectedSessionId); break;
    case "disconnect": mobileState.socket?.close(); show("home"); break;
    case "close": mobileState.socket?.close(); show("home"); break;
    case "urlscan": {
      const buf = mobileState.terminal?.buffer?.active;
      const lines = [];
      if (buf) for (let i = 0; i < buf.length; i++) { const l = buf.getLine(i); if (l) lines.push(l.translateToString(true)); }
      const urls = Array.from(new Set(lines.join("\n").match(/https?:\/\/[^\s)]+/g) || []));
      if (urls.length > 0) window.open(urls[0], "_blank", "noopener");
      break;
    }
    case "copySelection":
      if (sel) { try { await navigator.clipboard.writeText(sel); } catch {} }
      break;
    case "paste": {
      let text = "";
      try { text = await navigator.clipboard.readText(); } catch {}
      if (text) sendSocketData(text);
      break;
    }
  }
});

$("#terminalPaste")?.addEventListener("click", async () => {
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch {}
  if (text) sendSocketData(text);
});

// ========== CONNECTIONS MANAGER ==========

function showConnectionsManager() {
  const list = $("#connList");
  if (!list) return;

  function render() {
    let conns = [];
    try { conns = JSON.parse(NativeBridge.getConnections() || "[]"); } catch (e) {}
    const activeId = NativeBridge.getActiveId();

    if (conns.length === 0) {
      list.innerHTML = `<div class="conn-empty">
        <div class="conn-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        </div>
        <h3>Bienvenido</h3>
        <p>Conectate a tus servidores MultiTerminalAI para empezar a controlar sesiones de terminal desde tu telefono.</p>
      </div>`;
      return;
    }

    list.innerHTML = conns.map((c) => {
      const isActive = c.id === activeId;
      const host = (() => { try { return new URL(c.url).host; } catch { return c.url; } })();
      return `<div class="conn-card ${isActive ? "active" : ""}" data-id="${c.id}">
        <div class="conn-card-pulse ${isActive ? "on" : ""}"></div>
        <div class="conn-card-body">
          <div class="conn-card-row"><strong>${escapeHtml(c.name)}</strong>${isActive ? '<span class="conn-badge">Activa</span>' : ""}</div>
          <div class="conn-card-url">${escapeHtml(host)}</div>
        </div>
        <div class="conn-card-actions">
          <button class="conn-icon-btn" data-action="edit" data-id="${c.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
          <button class="conn-icon-btn delete" data-action="remove" data-id="${c.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></svg></button>
        </div>
      </div>`;
    }).join("");

    list.querySelectorAll(".conn-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".conn-icon-btn")) return;
        const id = card.dataset.id;
        if (id !== NativeBridge.getActiveId()) NativeBridge.setActive(id);
      });
    });
    list.querySelectorAll(".conn-icon-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (btn.dataset.action === "edit") NativeBridge.edit(id);
        else if (btn.dataset.action === "remove") { if (confirm("¿Eliminar?")) NativeBridge.remove(id); }
      });
    });
  }

  $("#connAddButton")?.addEventListener("click", () => NativeBridge.addNew());
  $("#connScanButton")?.addEventListener("click", startQRScanner);
  show("connections");
  render();
}

// ========== QR SCANNER ==========
let qrStream = null;
let qrScanning = false;

$("#qrCloseButton")?.addEventListener("click", stopQRScanner);

async function startQRScanner() {
  // Usar input file con capture=environment para abrir la camara nativa de Android
  // Esto funciona en WebView sin necesidad de HTTPS (a diferencia de getUserMedia)
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.capture = "environment";
  input.style.display = "none";
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (typeof jsQR !== "undefined") {
          const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
          if (code && code.data) {
            handleQRResult(code.data);
          } else {
            alert("No se detecto un QR valido en la imagen. Intenta de nuevo.");
          }
        } else {
          alert("Decoder QR no disponible");
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    input.remove();
  };
  document.body.appendChild(input);
  input.click();
}

function scanQRLoop() {
  if (!qrScanning) return;
  const video = $("#qrVideo");
  const canvas = $("#qrCanvas");
  if (video.readyState === video.HAVE_ENOUGH_DATA && typeof jsQR !== "undefined") {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (code && code.data) {
      stopQRScanner();
      handleQRResult(code.data);
      return;
    }
  }
  requestAnimationFrame(scanQRLoop);
}

function stopQRScanner() {
  qrScanning = false;
  if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
  const s = $("#qrScanner");
  if (s) s.hidden = true;
}

async function handleQRResult(qrData) {
  const status = $("#qrStatus");
  let url, pairCode;
  try {
    const parsed = new URL(qrData);
    url = parsed.origin + parsed.pathname;
    if (!url.endsWith("/mobile/")) { if (!url.endsWith("/")) url += "/"; url += "mobile/"; }
    pairCode = parsed.searchParams.get("pair") || "";
  } catch (e) {
    alert("QR invalido: " + qrData.slice(0, 60));
    return;
  }
  if (status) { status.textContent = "Conectando a " + new URL(url).host + "..."; status.className = "qr-status success"; }
  // Crear conexion via bridge
  if (typeof NativeBridge !== "undefined" && NativeBridge.addConnection) {
    NativeBridge.addConnection(url);
  }
  // Si hay codigo de pair, hacer pairing automatico
  if (pairCode) {
    try {
      const baseUrl = url.replace("/mobile/", "");
      const pairRes = await fetch(baseUrl + "/api/mobile/pair", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pairCode, deviceName: localStorage.getItem("mtai_device_name") || "Mi telefono" })
      }).then(r => r.json());
      if (pairRes.requestId) {
        if (status) status.textContent = "Esperando aprobacion...";
        const t0 = Date.now();
        while (Date.now() - t0 < 60000) {
          await new Promise(r => setTimeout(r, 1500));
          const st = await fetch(baseUrl + "/api/mobile/pair/" + pairRes.requestId).then(r => r.json());
          if (st.status === "accepted") {
            mobileState.token = st.token;
            localStorage.setItem("mtai_token", st.token);
            if (typeof NativeBridge !== "undefined" && NativeBridge.reportToken) NativeBridge.reportToken(st.token);
            if (status) status.textContent = "Conectado!";
            setTimeout(() => location.href = url, 1000);
            return;
          }
          if (st.status === "rejected") {
            if (status) { status.textContent = "Rechazado en el escritorio"; status.className = "qr-status error"; }
            return;
          }
        }
        if (status) { status.textContent = "Timeout"; status.className = "qr-status error"; }
      }
    } catch (err) {
      if (status) { status.textContent = "Error: " + err.message; status.className = "qr-status error"; }
    }
  } else {
    // Sin pair code: solo crear la conexion y cargar
    setTimeout(() => location.href = url, 1000);
  }
}

// ========== INIT ==========

$("#pairCode").value = params.get("pair") || "";
$("#deviceName").value = localStorage.getItem("mtai_device_name") || "Mi teléfono";

// Auto-pairing si viene con ?pair=CODE
const autoPair = params.get("pair");
if (autoPair) {
  show("pair");
  // Auto-enviar despues de un breve delay
  setTimeout(() => {
    requestPair().then(() => {
      console.log("Auto-pair exitoso");
    }).catch((err) => {
      $("#pairStatus").textContent = err.message;
    });
  }, 500);
} else if (params.get("show") === "connections") {
  showConnectionsManager();
} else {
  loadHome().catch(() => show("pair"));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/mobile/sw.js").catch(() => {});
}
