import assert from "node:assert/strict";
import { makeApp } from "../server/http.js";
import { MockMusic } from "../server/mock-music.js";

// All profile data and provider endpoints are isolated from the user's real radio.
const base = "http://127.0.0.1:18084";
const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null, learning: false,
  musicProvider: "mock", music: new MockMusic(base) });
const sessionId = "profile-browser-fixture";
lab.store.create(sessionId);
const knowledge = lab.agent.knowledge;
function seed(id: string, value: string, polarity: "like" | "dislike", dimension: "artist" | "genre", scope = "general") {
  knowledge.archive(sessionId, { id, role: "user", text: `preference ${value}`, status: "saved", createdAt: new Date().toISOString() });
  knowledge.save({ text: value, kind: "preference", scope, certainty: "explicit",
    preference: { dimension, value, polarity }, sourceIds: [id] });
}
await lab.app.listen({ host: "127.0.0.1", port: 18084 });
const { chromium } = await import("@playwright/test");
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH,
  headless: true, args: ["--mute-audio"] });
const errors: string[] = [];
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript(({ base, sessionId }: { base: string; sessionId: string }) => {
      localStorage.setItem("claudio-lab-preferences", JSON.stringify({ backend: `${base}/api/lab`, volume: 0 }));
      const db = indexedDB.open("claudio-agent-lab", 1);
      db.onupgradeneeded = () => {
        db.result.createObjectStore("sessions", { keyPath: "id" });
        db.result.createObjectStore("meta");
      };
      db.onsuccess = () => {
        const tx = db.result.transaction(["sessions", "meta"], "readwrite");
        tx.objectStore("sessions").put({ id: sessionId, serverSessionId: sessionId, backend: `${base}/api/lab`,
          draft: "", messages: [], events: [], lastSequence: 0, createdAt: new Date().toISOString() });
        tx.objectStore("meta").put(sessionId, "currentSession");
        tx.oncomplete = () => db.result.close();
      };
    }, { base, sessionId });
    await page.goto("http://127.0.0.1:5180/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "我的偏好与记忆" }).click();
    await page.getByRole("button", { name: "刷新记忆" }).waitFor({ state: "visible" });
    if (viewport.width === 1440) {
      await page.getByText("还在慢慢认识你的音乐喜好").waitFor();
      seed("artist", "Norah Jones", "like", "artist");
      seed("negative", "Heavy Metal", "dislike", "genre");
      seed("work", "器乐爵士", "like", "genre", "work");
      knowledge.archive(sessionId, { id: "episode", role: "user", text: "听Home时想起出差", status: "saved", createdAt: new Date().toISOString() });
      knowledge.save({ text: "听Home时会想起上次出差", kind: "episode", scope: "general",
        certainty: "explicit", sourceIds: ["episode"], entities: ["Home", "出差"] });
      await page.getByText("Norah Jones", { exact: true }).waitFor({ timeout: 9000 });
    } else {
      await page.getByText("Norah Jones", { exact: true }).waitFor();
    }
    assert.equal(await page.getByText("Heavy Metal").count(), 0, "Negative preferences stay out of the profile UI");
    assert.equal(await page.locator(".personalization-panel").getByRole("textbox").count(), 0, "The memory page is read-only");
    await page.getByText("听Home时会想起上次出差").waitFor();
    assert.equal(await page.locator(".profile-tag").count(), 2);
    const overflow = await page.locator(".settings-dialog").evaluate((element: HTMLElement) => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false, "No horizontal dialog overflow");
    await page.screenshot({ path: `/tmp/claudio-profile-${viewport.width}-day.png` });
    await page.getByRole("button", { name: "返回设置" }).click();
    await page.getByRole("button", { name: "夜间", exact: true }).click();
    await page.getByRole("button", { name: "我的偏好与记忆" }).click();
    await page.getByText("Norah Jones", { exact: true }).waitFor();
    await page.screenshot({ path: `/tmp/claudio-profile-${viewport.width}-night.png` });
    if (viewport.width === 390) {
      await page.getByRole("button", { name: "忘记Norah Jones", exact: true }).click();
      await page.getByText("已忘记这条偏好。").waitFor();
      assert.equal(await page.getByText("Norah Jones", { exact: true }).count(), 0);
      assert.equal(knowledge.profile().some(tag => tag.value === "Norah Jones"), false);
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Profile UI: desktop/mobile, day/night, empty/populated, live refresh, positive-only/read-only and forgetting passed.");
} finally { await browser.close(); await lab.app.close(); }
