import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";

type Account = { connected: true; profile: { userId: number; nickname: string } };
type Result = ({ status: "connected" } & Account) | { status: "cancelled" } | { status: "error"; message: string };

function officialPage(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "163.com" || url.hostname.endsWith(".163.com"));
  } catch { return false; }
}

export function openMusicLogin(parent: BrowserWindow,
  connect: (cookie: string, signal: AbortSignal) => Promise<Account>): Promise<Result> {
  return new Promise(resolve => {
    // This temporary official-site session has no Claudio preload or backend access.
    const browserSession = session.fromPartition(`claudio-netease-${randomUUID()}`);
    const login = new BrowserWindow({
      parent, title: "登录网易云音乐", width: 1040, height: 760, minWidth: 760, minHeight: 600,
      show: false, autoHideMenuBar: true,
      webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const controller = new AbortController();
    let settled = false;
    let checking = false;
    let attempts = 0;
    const finish = (result: Result) => {
      if (settled) return;
      settled = true;
      controller.abort();
      clearInterval(timer);
      clearTimeout(deadline);
      browserSession.cookies.removeListener("changed", changed);
      parent.removeListener("closed", cancelled);
      if (!login.isDestroyed()) login.close();
      void browserSession.clearStorageData().catch(() => {});
      resolve(result);
    };
    const cancelled = () => finish({ status: "cancelled" });
    const inspect = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        const cookies = await browserSession.cookies.get({ url: "https://music.163.com/" });
        if (settled || !cookies.some(cookie => cookie.name === "MUSIC_U" && cookie.value)) return;
        const cookie = cookies.map(item => `${item.name}=${item.value}`).join("; ");
        const account = await connect(cookie, controller.signal);
        finish({ status: "connected", ...account });
      } catch {
        if (!settled && ++attempts >= 3) finish({
          status: "error", message: "网易登录状态未能确认，已有登录未被替换。请稍后重试。",
        });
      } finally { checking = false; }
    };
    const changed = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
      if (cookie.name === "MUSIC_U" && !removed) void inspect();
    };
    const timer = setInterval(() => void inspect(), 2000);
    const deadline = setTimeout(() => finish({
      status: "error", message: "登录窗口已超时关闭，请重新打开。",
    }), 5 * 60_000);
    browserSession.cookies.on("changed", changed);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    login.webContents.setWindowOpenHandler(({ url }) => {
      if (officialPage(url)) void login.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    const navigate = (event: Electron.Event, url: string) => {
      if (!officialPage(url)) event.preventDefault();
    };
    login.webContents.on("will-navigate", navigate);
    login.webContents.on("will-redirect", navigate);
    login.once("ready-to-show", () => { if (!settled) login.show(); });
    login.once("closed", cancelled);
    parent.once("closed", cancelled);
    void login.loadURL("https://music.163.com/").catch(() => finish({
      status: "error", message: "无法打开网易官方登录页，请检查网络后重试。",
    }));
  });
}
