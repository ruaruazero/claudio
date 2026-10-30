import { PlaybackAckSchema, PlaybackReceiptSchema, type PlaybackReceipt, type Message, type Settings, type TraceEntry, type PlaybackAck } from "./protocol";
import { z } from "zod";
import { LocalPlaybackSchema } from "./protocol";
const localPlaybackRecord = z.object({ backend: z.string(), sessionId: z.string(), operation: LocalPlaybackSchema });
export type SavedLocalPlayback = z.infer<typeof localPlaybackRecord>;
export function localPlaybackOperations(): SavedLocalPlayback[] {
  return z.array(localPlaybackRecord).parse(JSON.parse(localStorage.getItem("claudio-local-playback") || "[]"));
}
export function saveLocalPlayback(item: SavedLocalPlayback) {
  const items = localPlaybackOperations();
  if (items.some((entry) => entry.operation.commandId === item.operation.commandId)) return;
  if (items.length >= 64) throw new Error("播放操作尚未同步，请先重新连接。");
  localStorage.setItem("claudio-local-playback", JSON.stringify([...items, item]));
}
export function removeLocalPlayback(item: SavedLocalPlayback) {
  localStorage.setItem("claudio-local-playback", JSON.stringify(localPlaybackOperations()
    .filter((entry) => entry.operation.commandId !== item.operation.commandId)));
}

const observationSchema = z.object({ backend: z.string(), sessionId: z.string(), ack: PlaybackAckSchema });
export type SavedObservation = z.infer<typeof observationSchema>;
const observationKey = "claudio-playback-observations";

export function playbackObservations(): SavedObservation[] {
  const raw = localStorage.getItem(observationKey);
  return raw ? z.array(observationSchema).parse(JSON.parse(raw)) : [];
}

export function savePlaybackObservation(backend: string, sessionId: string, ack: PlaybackAck) {
  const items = playbackObservations().filter((item) => !(item.backend === backend &&
    item.sessionId === sessionId && item.ack.commandId === ack.commandId &&
    item.ack.ackSequence <= ack.ackSequence));
  items.push({ backend, sessionId, ack });
  localStorage.setItem(observationKey, JSON.stringify(items.slice(-64)));
}

export function removePlaybackObservation(item: SavedObservation) {
  const remaining = playbackObservations().filter((entry) => !(entry.backend === item.backend &&
    entry.sessionId === item.sessionId && entry.ack.commandId === item.ack.commandId &&
    entry.ack.ackSequence === item.ack.ackSequence));
  localStorage.setItem(observationKey, JSON.stringify(remaining));
}

const receiptRecord = z.object({ backend: z.string(), sessionId: z.string(), receipt: PlaybackReceiptSchema });
type SavedReceipt = z.infer<typeof receiptRecord>;
const receiptKey = "claudio-playback-receipts";
export function playbackReceipts(): SavedReceipt[] {
  return z.array(receiptRecord).parse(JSON.parse(localStorage.getItem(receiptKey) || "[]"));
}
export function savePlaybackReceipt(backend: string, sessionId: string, receipt: PlaybackReceipt) {
  const items = playbackReceipts().filter(item => !(item.backend === backend && item.sessionId === sessionId &&
    item.receipt.commandId === receipt.commandId));
  localStorage.setItem(receiptKey, JSON.stringify([...items, { backend, sessionId, receipt }].slice(-64)));
}
export function removePlaybackReceipt(item: SavedReceipt) {
  localStorage.setItem(receiptKey, JSON.stringify(playbackReceipts().filter(entry => !(entry.backend === item.backend &&
    entry.sessionId === item.sessionId && entry.receipt.commandId === item.receipt.commandId &&
    entry.receipt.phase === item.receipt.phase))));
}

export type LocalSession = {
  id: string;
  serverSessionId?: string;
  backend?: string;
  draft: string;
  messages: Message[];
  events: TraceEntry[];
  lastSequence: number;
  createdAt: string;
  pauseRequested?: boolean;
};

let dbPromise: Promise<IDBDatabase> | undefined;

function openDatabase() {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("claudio-agent-lab", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("sessions", { keyPath: "id" });
      request.result.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本地存储。"));
  });
  return dbPromise;
}

async function read<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法读取本地记录。"));
  });
}

export async function saveSession(session: LocalSession) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["sessions", "meta"], "readwrite");
    tx.objectStore("sessions").put(session);
    tx.objectStore("meta").put(session.id, "currentSession");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error("本地保存失败，请勿关闭页面。"));
    tx.onabort = () => reject(new Error("本地保存中断，请重试。"));
  });
}

export async function loadSession(): Promise<LocalSession> {
  const id = await read<string>("meta", "currentSession");
  const session = id ? await read<LocalSession>("sessions", id) : undefined;
  return session ?? newSession();
}

export function newSession(): LocalSession {
  return {
    id: crypto.randomUUID(),
    draft: "",
    messages: [],
    events: [],
    lastSequence: 0,
    createdAt: new Date().toISOString(),
  };
}

export function loadPreferences(): { backend: string; settings: Settings; volume: number } {
  try {
    const saved = JSON.parse(localStorage.getItem("claudio-lab-preferences") || "{}");
    return {
      backend: typeof saved.backend === "string" ? saved.backend : "/agent-api",
      settings: {
        autoSpeech: saved.settings?.autoSpeech === true,
        proactive: saved.settings?.proactive !== false,
        allowPreview: saved.settings?.allowPreview !== false,
      },
      volume: typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : 0.65,
    };
  } catch {
    return { backend: "/agent-api", settings: { autoSpeech: false, proactive: true, allowPreview: true }, volume: 0.65 };
  }
}

export function savePreferences(value: ReturnType<typeof loadPreferences>) {
  localStorage.setItem("claudio-lab-preferences", JSON.stringify(value));
}
