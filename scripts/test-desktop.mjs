import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { _electron as electron, expect } from "@playwright/test";

const executablePath = resolve(process.env.CLAUDIO_APP_EXECUTABLE ??
  `release/${JSON.parse(readFileSync("package.json", "utf8")).version}/mac-arm64/Claudio.app/Contents/MacOS/Claudio`);
const directory = realpathSync(mkdtempSync(join(tmpdir(), "claudio-desktop-test-")));
let application;
async function launch() {
  application = await electron.launch({ executablePath, args: [`--claudio-test-data=${directory}`, "--mute-audio", "--use-mock-keychain"],
    cwd: directory, env: { ...process.env, CLAUDIO_DESKTOP_TEST: "1" }, timeout: 45000 });
  const page = await application.firstWindow();
  await page.waitForURL("app://claudio/");
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  return page;
}
try {
  let page = await launch();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const health = await page.evaluate(async () => (await fetch("/agent-api/health")).json());
  assert.equal(health.modelConfigured, false);
  assert.equal(health.musicProvider, "netease");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => window.claudioDesktop?.platform), "darwin");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.desktop), "mac");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".topbar")).getPropertyValue("-webkit-app-region")), "drag");
  assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition()),
    { x: 20, y: 16 });
  assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), directory);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "模型与语音服务" }).click();
  await page.getByLabel("API Key", { exact: true }).waitFor({ state: "visible" });
  await expect(page.getByLabel("模型", { exact: true })).toHaveValue("deepseek-flash");
  await page.getByRole("tab", { name: "语音播报", exact: true }).click();
  await page.getByLabel("API Key", { exact: true }).fill("desktop-fixture-unused-key");
  await page.getByRole("button", { name: "保存并生效" }).click();
  await page.getByRole("button", { name: "移除密钥" }).waitFor();
  assert.equal(readFileSync(join(directory, "credentials", "ai-services.enc")).includes(Buffer.from("desktop-fixture-unused-key")), false);
  await page.getByRole("button", { name: "返回设置" }).click();
  await page.getByRole("button", { name: "头像与称呼" }).click();
  await page.getByLabel("称呼", { exact: true }).fill("桌面测试");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();
  // Serve an offline official-site fixture in the isolated login session only.
  await application.evaluate(({ app }) => {
    app.on("session-created", target => {
      target.protocol.handle("https", () => new Response("<!doctype html><h1>登录测试页</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }));
    });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "网易云音乐", exact: true }).click();
  const loginWindow = application.waitForEvent("window");
  await page.getByRole("button", { name: "在网易官方页面登录", exact: true }).click();
  const officialPage = await loginWindow;
  await officialPage.getByRole("heading", { name: "登录测试页" }).waitFor();
  assert.equal(await officialPage.evaluate(() => typeof window.claudioDesktop), "undefined");
  assert.equal(await officialPage.evaluate(() => typeof window.require), "undefined");
  await officialPage.evaluate(() => { window.location.href = "https://example.com/"; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(new URL(officialPage.url()).hostname, "music.163.com");
  await (await application.browserWindow(officialPage)).evaluate(window => window.close());
  await page.getByText("已取消登录。", { exact: true }).waitFor();
  assert.equal(readdirSync(join(directory, "credentials")).includes("netease-credential.enc"), false);
  await page.getByRole("button", { name: "关闭设置" }).click();
  const transport = await page.evaluate(async () => {
    const response = await fetch("/agent-api/sessions", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientSessionId: "desktop-fixture" }) });
    if (!response.ok) throw new Error(`Create session ${response.status}`);
    const event = await new Promise((resolve, reject) => {
      const stream = new EventSource("/agent-api/sessions/desktop-fixture/events");
      const timer = setTimeout(() => { stream.close(); reject(new Error("SSE delivery timeout")); }, 10000);
      stream.onopen = () => { void fetch("/agent-api/sessions/desktop-fixture/settings", { method: "PATCH",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          autoSpeech: false, proactive: false, allowPreview: true,
        }) }).catch(reject); };
      stream.onmessage = message => { clearTimeout(timer); stream.close(); resolve(JSON.parse(message.data).type); };
    });
    const voice = await fetch("/ambient/rain-v2.mp3");
    const bytes = (await voice.arrayBuffer()).byteLength;
    const audio = new Audio("/ambient/rain-v2.mp3");
    audio.volume = 0;
    await audio.play();
    await new Promise(resolve => setTimeout(resolve, 300));
    const position = audio.currentTime;
    audio.pause();
    await audio.play();
    const resumed = audio.currentTime >= position;
    audio.pause();
    return { event, bytes, resumed, position };
  });
  assert.equal(transport.event, "settings.updated");
  assert.equal(transport.bytes > 100000, true);
  assert.equal(transport.position > 0, true);
  assert.equal(transport.resumed, true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await application.evaluate(({ app }) => app.emit("activate"));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  for (const width of [390, 1180, 1440]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 844), width);
    await page.waitForFunction(width => innerWidth === width, width);
    const heading = await page.locator(".topbar h1").boundingBox();
    const header = await page.locator(".topbar").boundingBox();
    assert.equal(heading.x, header.x);
    assert.equal(heading.y >= 44, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
    await page.screenshot({ path: join(tmpdir(), `claudio-desktop-${width}-day.png`) });
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "夜间", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.screenshot({ path: join(tmpdir(), "claudio-desktop-1440-night.png") });
  for (const size of [{ width: 390, height: 560 }, { width: 500, height: 900 }, { width: 1180, height: 560 }]) {
    const actual = await application.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(size.width, size.height);
      // macOS may constrain tall windows to the current display's work area.
      return window.getContentSize();
    }, size);
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, actual);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const close = page.getByRole("button", { name: "关闭设置", exact: true });
    const top = await close.evaluate(button => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!button.contains(hit)) throw new Error("Settings close button is obstructed");
      if (getComputedStyle(button).getPropertyValue("-webkit-app-region") !== "no-drag") throw new Error("Close button became a drag region");
      return rect.top;
    });
    assert.equal(top >= 44, true);
    await page.locator(".settings-content").evaluate(content => { content.scrollTop = content.scrollHeight; });
    assert.equal(await close.evaluate(button => button.getBoundingClientRect().top), top);
    await page.screenshot({ path: join(tmpdir(), `claudio-desktop-settings-${size.width}-${size.height}.png`) });
    for (const section of ["我的偏好与记忆", "模型与语音服务"]) {
      await page.getByRole("button", { name: new RegExp(`^${section}`) }).click();
      const back = page.getByRole("button", { name: "返回设置", exact: true });
      for (const button of [back, close]) {
        assert.equal(await button.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return rect.top >= 44 && rect.bottom <= innerHeight &&
            element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) &&
            getComputedStyle(element).getPropertyValue("-webkit-app-region") === "no-drag";
        }), true);
      }
      await back.click();
    }
    await close.click();
    await expect(page.locator(".settings-dialog")).not.toBeVisible();
    assert.equal(await page.locator(".window-drag-region").evaluate(element => element.getBoundingClientRect().width), actual[0]);
  }
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;

  page = await launch();
  const restored = await page.evaluate(async () => ({
    profile: JSON.parse(localStorage.getItem("claudio-profile")),
    session: (await fetch("/agent-api/sessions/desktop-fixture")).status,
  }));
  assert.equal(restored.profile.name, "桌面测试");
  assert.equal(restored.session, 200);
  assert.equal(await page.evaluate(async () => (await (await fetch("/agent-api/services")).json()).speech.configured), true);
  assert.equal(readdirSync(directory).includes("claudio.sqlite"), true);
  assert.equal(readdirSync(join(directory, "credentials")).includes("ai-services.key"), true);
  await application.close();
  application = undefined;
  console.log("PASS: packaged ARM64 app, titlebar and responsive/short-window settings, unobstructed close buttons and full-width drag regions, isolated official login window, local service, sandbox, SSE, audio, persistence. Test fixtures use local encryption without accessing system keychain.");
} finally {
  if (application) await application.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
