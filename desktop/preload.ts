import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("claudioDesktop", {
  platform: process.platform,
  loginMusic: () => ipcRenderer.invoke("claudio:music-login"),
});
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.desktop = process.platform === "darwin" ? "mac" : "other";
});
