import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE_PATH });
try {
  for (const viewport of [{ width: 390, height: 560 }, { width: 500, height: 900 }, { width: 1180, height: 560 }]) {
    const page = await browser.newPage({ viewport });
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.desktop = "mac"; });
    });
    await page.goto("http://127.0.0.1:5180/?preview=design");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    for (const subpage of [null, "我的偏好与记忆", "模型与语音服务"]) {
      if (subpage) await page.getByRole("button", { name: new RegExp(`^${subpage}`) }).click();
      const close = page.getByRole("button", { name: "关闭设置", exact: true });
      await expect(close).toBeVisible();
      const geometry = await close.evaluate(button => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const heading = button.closest("header").getBoundingClientRect();
        const content = document.querySelector(".settings-content");
        return {
          top: heading.top, bottom: rect.bottom, clickable: button === hit || button.contains(hit),
          region: getComputedStyle(button).getPropertyValue("-webkit-app-region"),
          headingTop: heading.top, scrollHeight: content.scrollHeight, height: content.clientHeight,
        };
      });
      assert.equal(geometry.top >= 44, true);
      assert.equal(geometry.bottom <= viewport.height, true);
      assert.equal(geometry.clickable, true);
      assert.equal(geometry.region, "no-drag");
      await page.locator(".settings-content").evaluate(content => { content.scrollTop = content.scrollHeight; });
      assert.equal(await close.evaluate(button => button.closest("header").getBoundingClientRect().top), geometry.headingTop);
      await page.screenshot({ path: `/tmp/claudio-settings-${viewport.width}-${viewport.height}-${subpage ? "detail" : "home"}.png` });
      if (subpage) await page.getByRole("button", { name: "返回设置", exact: true }).click();
    }
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).not.toBeVisible();
    const drag = await page.locator(".window-drag-region").evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, region: getComputedStyle(element).getPropertyValue("-webkit-app-region") };
    });
    assert.deepEqual(drag, { width: viewport.width, height: 40, region: "drag" });
    await page.close();
  }
  console.log("PASS: short/narrow desktop settings, fixed headers, unobstructed close buttons, content scrolling and full-width drag regions.");
} finally { await browser.close(); }
