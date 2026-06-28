import { app, BrowserWindow, dialog, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let appServer;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");
if (process.env.MULTITERMINALAI_REMOTE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.MULTITERMINALAI_REMOTE_DEBUG_PORT);
}

const userDataPath =
  process.env.MULTITERMINALAI_USER_DATA ||
  (app.isPackaged ? join(app.getPath("appData"), "MultiTerminalAI") : join(__dirname, ".appdata"));
app.setPath("userData", userDataPath);

export async function createWindow() {
  const userDataDir = app.getPath("userData");
  const testFolder = process.env.MULTITERMINALAI_TEST_FOLDER || "";
  appServer = await startServer({
    port: 0,
    host: "0.0.0.0",
    publicDir: join(__dirname, "public"),
    vendorDir: join(__dirname, "node_modules"),
    dataDir: userDataDir,
    pickFolder: async () => {
      if (testFolder) return testFolder;
      const result = await dialog.showOpenDialog({
        title: "Escoger carpeta",
        properties: ["openDirectory", "createDirectory"]
      });
      return result.canceled ? null : result.filePaths[0];
    }
  });

  const win = new BrowserWindow({
    width: 1220,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: "MultiTerminalAI",
    backgroundColor: "#111316",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(`http://127.0.0.1:${appServer.port}`);
  return win;
}

if (!process.env.MULTITERMINALAI_NO_AUTO_START) {
  app.whenReady().then(createWindow);
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  appServer?.server.close();
});
