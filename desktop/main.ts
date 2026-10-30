import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { extname, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { startDesktopBackend } from "../server/desktop-runtime.js";
import { openMusicLogin } from "./music-login.js";
import { desktopTestDirectory } from "./test-mode.js";

protocol.registerSchemesAsPrivileged([{ scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const testData = desktopTestDirectory(process.argv, process.env);
app.setName(testData ? "Claudio Test" : "Claudio");
if (testData) app.setPath("userData", testData);
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let window: BrowserWindow | null = null;
let backend: Awaited<ReturnType<typeof startDesktopBackend>> | null = null;
let quitting = false;
const token = randomBytes(32).toString("hex");
const show = () => { if (window) { window.show(); window.focus(); } };
app.on("second-instance", show);
app.on("activate", show);
app.on("before-quit", event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (backend?.close() ?? Promise.resolve()).finally(() => app.quit());
});

async function start() {
  await app.whenReady();
  if (!testData && !safeStorage.isEncryptionAvailable()) throw new Error("System credential encryption unavailable");
  const runtimePath = pathToFileURL(resolve(__dirname, "backend.mjs")).href;
  const runtime = await import(runtimePath) as { startDesktopBackend: typeof startDesktopBackend };
  // Fixture encryption stays inside the disposable test directory; never open the user's keychain in tests.
  backend = await runtime.startDesktopBackend(app.getPath("userData"), token, testData ? undefined : {
    encryptString: value => safeStorage.encryptString(value),
    decryptString: value => safeStorage.decryptString(value),
  });
  const webRoot = resolve(__dirname, "web");
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
    ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".mp3": "audio/mpeg",
    ".ttf": "font/ttf", ".ico": "image/x-icon" };
  protocol.handle("app", async request => {
    const url = new URL(request.url);
    if (url.host !== "claudio") return new Response(null, { status: 403 });
    if (url.pathname === "/agent-api" || url.pathname.startsWith("/agent-api/")) {
      const headers = new Headers(request.headers);
      for (const name of ["origin", "host", "referer"]) headers.delete(name);
      headers.set("x-claudio-token", token);
      try {
        return await net.fetch(`${backend!.url}/api/lab${url.pathname.slice("/agent-api".length)}${url.search}`, {
          method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
          signal: request.signal,
        });
      } catch { return Response.json({ error: "LOCAL_SERVICE_UNAVAILABLE" }, { status: 503 }); }
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
    const path = resolve(webRoot, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
    if (!path.startsWith(webRoot + sep)) return new Response(null, { status: 403 });
    try {
      const data = await readFile(path);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(data), {
        headers: { "Content-Type": types[extname(path)] ?? "application/octet-stream" },
      });
    } catch { return new Response(null, { status: 404 }); }
  });
  window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 360, minHeight: 560, title: "Claudio",
    backgroundColor: "#181819", show: false,
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 20, y: 16 } } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: resolve(__dirname, "preload.cjs") },
  });
  let musicLogin: ReturnType<typeof openMusicLogin> | undefined;
  ipcMain.handle("claudio:music-login", async event => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== "app://claudio/" || !backend || quitting) {
      throw new Error("Login unavailable");
    }
    if (!musicLogin) {
      musicLogin = openMusicLogin(window, (cookie, signal) => backend!.connectMusicSession(cookie, signal));
      void musicLogin.finally(() => { musicLogin = undefined; });
    }
    return musicLogin;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== "app://claudio/") event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on("close", event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.once("ready-to-show", show);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Claudio", submenu: [{ role: "about" }, {
      label: "声音来源与署名", click: async () => {
        const detail = await readFile(resolve(__dirname, "CREDITS.txt"), "utf8").catch(() => "声音来源声明暂时无法读取。");
        void dialog.showMessageBox({ title: "Claudio", message: "声音来源与署名", detail });
      },
    }, { type: "separator" }, { role: "hide" }, { role: "quit" }] },
    { role: "editMenu" }, { role: "windowMenu" },
  ]));
  await window.loadURL("app://claudio/");
}
if (single) void start().catch(async () => {
  dialog.showErrorBox("Claudio 无法启动", "本地服务未能启动。请退出后重新打开；个人数据会保留。");
  await backend?.close().catch(() => {});
  quitting = true;
  app.quit();
});
