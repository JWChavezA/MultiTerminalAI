import { WebSocket } from "ws";
const wsUrl = "ws://localhost:9222/devtools/page/79B7894E5DA8607BE86228A2E469FA23";
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve) => {
    id++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
ws.on("open", async () => {
  await new Promise(r => setTimeout(r, 500));
  const r1 = await send("Runtime.evaluate", {
    expression: `(() => {
      const menu = document.querySelector("#terminalMenu");
      if (!menu) return "NO_MENU";
      return JSON.stringify({
        hidden: menu.hidden,
        style: menu.getAttribute("style"),
        parent: menu.parentElement?.id,
        buttons: Array.from(menu.querySelectorAll("button")).map(b => ({
          text: b.textContent.trim(),
          action: b.dataset.action,
          bounds: b.getBoundingClientRect()
        }))
      }, null, 2);
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(r1.result?.value, null, 2));
  ws.close();
  process.exit(0);
});
ws.on("error", (e) => { console.error("ERR", e.message); process.exit(1); });
