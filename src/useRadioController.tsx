import {
  useCallback, useEffect, useRef, useState,
  type FormEvent, type ReactNode, type AudioHTMLAttributes,
} from "react";
import { z } from "zod";
import { eventUrl, request } from "./api";
import { MediaPauseGuard, waitForPlaybackBuffer, playWithConfirmation } from "./playback";
import { SpeechStreamPlayer } from "./speech-player";
import { usePlaybackSync } from "./usePlaybackSync";
import { QUEUE_POLICY } from "./queue-policy";
import { audioEngine, musicAudioUrl } from "./audio-engine";
import {
  emptyRadio, EventSchema, HealthSchema, MessageSchema, normalizeBase,
  SessionSchema, SettingsSchema,
  PlayerAttachmentSchema,
  PreparedTrackSchema, type PreparedTrack,
  type SpeechAck, type PlaybackAck,
  type AgentEvent, type Message, type Radio, type Settings, type Snapshot, type TraceEntry, type Track,
} from "./protocol";
import {
  loadPreferences, loadSession, newSession, savePreferences, saveSession,
  savePlaybackObservation,
  savePlaybackReceipt,
  localPlaybackOperations, saveLocalPlayback, removeLocalPlayback,
  type LocalSession,
} from "./storage";

type Connection = "offline" | "connecting" | "online" | "reconnecting" | "error";
const acceptedSchema = z.object({ accepted: z.literal(true) });
const messageAckSchema = z.object({
  message: MessageSchema.refine((m) => m.role === "user" && m.status === "saved"),
});
export const labels: Record<Connection, string> = {
  offline: "未连接", connecting: "连接中", online: "已连接",
  reconnecting: "重新连接中", error: "连接失败",
};
const reconnectNotice = "与电台服务的连接已中断，正在自动重连；已有音乐可继续播放，AI 暂时无法回应。";
export const toolLabels: Record<string, string> = {
  get_radio_state: "读取播放状态", search_music: "搜索音乐",
  inspect_music: "检查音乐资源", update_music_queue: "更新队列",
  control_playback: "控制播放", recall_memory: "召回记忆",
  read_conversation: "读取对话原文", request_memory_change: "处理记忆请求",
  send_message: "发送回复与歌曲推荐",
};
export const eventLabels: Partial<Record<AgentEvent["type"], string>> = {
  "message.saved": "用户消息已保存", "reply.final": "收到完整回复",
  "queue.updated": "队列已更新", "playback.command": "收到播放命令",
  "playback.observed": "播放器实际回执",
  "playback.received": "播放命令执行进度",
  "speech.ready": "语音资源就绪", "speech.cancelled": "播报已取消",
  "speech.synthesizing": "正在合成语音", "speech.completed": "语音合成完成",
  "speech.observed": "语音播放回执",
  "speech.failed": "语音生成失败", "resources.ready": "播放资源已准备",
  "maintenance.updated": "后台补歌状态",
  "model.attempt": "模型请求与网络恢复",
  "context.updated": "对话上下文整理",
  "model.context": "模型本轮收到的播放状态与时间",
  "service.updated": "外部服务状态",
  "settings.updated": "设置已同步", "run.completed": "本次运行完成",
  "run.cancelled": "本次运行已取消", "run.failed": "本次运行失败",
  "run.partial": "操作结果已保留，已使用系统回复",
};

function mergeMessage(messages: Message[], message: Message) {
  const index = messages.findIndex((m) =>
    m.id === message.id ||
    Boolean(message.clientMessageId && m.clientMessageId === message.clientMessageId),
  );
  if (index < 0) return [...messages, message];
  return messages.map((m, i) => i === index ? message : m);
}

function errorText(error: unknown) {
  if (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)) {
    return "请求未完成，请重新连接确认保存状态。";
  }
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
export function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--" :
    date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}
function durationLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function toTrace(event: AgentEvent): TraceEntry {
  return JSON.parse(JSON.stringify(event, (key, value) =>
    ["url", "artworkUrl"].includes(key) ? "[资源地址已省略]" : value,
  ));
}
export function useRadioController() {
  const initial = useRef(loadPreferences()).current;
  const [backend, setBackend] = useState(initial.backend);
  const backendRef = useRef(initial.backend);
  const [settings, setSettings] = useState<Settings>(initial.settings);
  const settingsRef = useRef(initial.settings);
  const settingsDirty = useRef(false);
  const [volume, setVolume] = useState(initial.volume);
  const volumeRef = useRef(initial.volume);
  const [session, setSession] = useState<LocalSession | null>(null);
  const sessionRef = useRef<LocalSession | null>(null);
  const flushingLocalPlayback = useRef(false);
  const preparedRef = useRef<PreparedTrack[]>([]);
  const pendingLocalAction = useRef<"play" | "next" | null>(null);
  const pendingAutomatic = useRef(false);
  const saveChain = useRef(Promise.resolve());
  const [storageReady, setStorageReady] = useState(false);
  const [connection, setConnection] = useState<Connection>("offline");
  const connectionRef = useRef<Connection>("offline");
  const [model, setModel] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [musicProvider, setMusicProvider] = useState<"mock" | "netease" | null>(null);
  const [notice, setNotice] = useState("");
  const [serviceIssues, setServiceIssues] = useState<Snapshot["serviceIssues"]>([]);
  const [playbackNotice, setPlaybackNotice] = useState("");
  const [view, setView] = useState<"chat" | "trace">("chat");
  const [radio, setRadio] = useState<Radio>(emptyRadio);
  const radioRef = useRef<Radio>(emptyRadio);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const [activity, setActivity] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, "like" | "dislike" | "clear">>({});
  const [settingsSynced, setSettingsSynced] = useState(false);
  const [capabilities, setCapabilities] = useState({ autoSpeech: false, proactive: false });
  const [audioStatus, setAudioStatus] = useState<"idle" | "loading" | "playing" | "paused" | "blocked" | "failed">("idle");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  const [nextPending, setNextPending] = useState(false);
  const [cardPending, setCardPending] = useState<string | null>(null);
  const nextPendingRef = useRef(false);
  const [nextCooldown, setNextCooldown] = useState(false);
  const nextGuardUntil = useRef(0);
  const nextGuardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nextPreparation = useRef<AbortController | null>(null);
  const controlRequest = useRef<AbortController | null>(null);
  const controlRevision = useRef(0);
  const pendingResourceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bufferRequest = useRef<AbortController | null>(null);
  const mediaPauseGuard = useRef(new MediaPauseGuard());
  const [lastRun, setLastRun] = useState<{ durationMs?: number; inputTokens?: number; outputTokens?: number }>({});
  const streamRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectAttempts = useRef(0);
  const epochRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const reconciliationNeeded = useRef(false);
  const reconcilingPlayer = useRef(false);
  const eventChain = useRef(Promise.resolve());
  const eventHandlerRef = useRef<(event: AgentEvent) => Promise<void>>(async () => {});
  const audioRef = useRef<HTMLAudioElement>(null);
  const speechRef = useRef<HTMLAudioElement>(null);
  const standbyRef = useRef<HTMLAudioElement | null>(null);
  const standbyTrack = useRef<string | null>(null);
  const speechIdRef = useRef<string | null>(null);
  const speechProactiveRef = useRef(false);
  const speechStreamRef = useRef<SpeechStreamPlayer | null>(null);
  const speechActiveRef = useRef(false);
  const speechAckSequence = useRef(0);
  const [speechStatus, setSpeechStatus] = useState<"idle" | "preparing" | "playing" | "failed">("idle");
  const [readingMessageId, setReadingMessageId] = useState<string | null>(null);
  const manualMessageRef = useRef<string | null>(null);
  const registerMusicA = useCallback((node: HTMLAudioElement | null) => {
    if (node) { node.crossOrigin = "anonymous"; audioEngine.attach(node, "music"); audioRef.current = node; }
  }, []);
  const registerMusicB = useCallback((node: HTMLAudioElement | null) => {
    if (node) { node.crossOrigin = "anonymous"; audioEngine.attach(node, "music"); standbyRef.current = node; }
  }, []);
  useEffect(() => {
    const unlock = () => { void audioEngine.unlock().catch(() => {}); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, []);
  const commandRef = useRef<{ commandId: string; playbackVersion: number; trackId?: string } | null>(null);
  const playbackAction = useRef<"play" | "pause" | "stop">("stop");
  const resumePoint = useRef<{ trackId: string; seconds: number } | null>(null);
  const pendingSeek = useRef<{ commandId: string; seconds: number } | null>(null);
  const ackSequenceRef = useRef(0);
  const seenCommands = useRef(new Set<string>());
  const pauseBarrier = useRef(0);
  const playbackTerminal = useRef(false);
  const lastActivityAt = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const changeConnection = useCallback((value: Connection) => {
    connectionRef.current = value;
    setConnection(value);
  }, []);
  const changeActive = useCallback((value: string | null) => {
    activeRef.current = value;
    setActiveRequest(value);
  }, []);
  const changeRadio = useCallback((value: Radio) => {
    radioRef.current = value;
    setRadio(value);
  }, []);
  const changeNextPending = useCallback((value: boolean) => {
    nextPendingRef.current = value;
    setNextPending(value);
  }, []);
  const persist = useCallback((next: LocalSession) => {
    sessionRef.current = next;
    setSession(next);
    const operation = saveChain.current.catch(() => {}).then(() => saveSession(next));
    saveChain.current = operation;
    void operation.catch((error) => setNotice(errorText(error)));
    return operation;
  }, []);
  const reportSpeech = useCallback((speechId: string, status: SpeechAck["status"]) => {
    const sessionId = sessionRef.current?.serverSessionId;
    if (!sessionId || connectionRef.current !== "online") return;
    void request(backendRef.current, `/sessions/${encodeURIComponent(sessionId)}/speech/acks`,
      acceptedSchema, { method: "POST", body: { speechId, status, sequence: ++speechAckSequence.current } }).catch(() => {});
  }, []);
  const unlockSpeech = () => {
    try {
      speechStreamRef.current ??= new SpeechStreamPlayer();
      void speechStreamRef.current.unlock().catch(() => {});
    } catch { /* A text response remains available when audio is unsupported. */ }
  };
  const stopSpeech = useCallback((status: SpeechAck["status"] = "stopped") => {
    const id = speechIdRef.current;
    speechIdRef.current = null;
    speechProactiveRef.current = false;
    speechActiveRef.current = false;
    speechStreamRef.current?.stop();
    if (id) reportSpeech(id, status);
    setSpeechStatus("idle");
    setReadingMessageId(null);
    const audio = speechRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (audioRef.current) audioRef.current.volume = volumeRef.current;
  }, [reportSpeech]);
  async function stopReadAloud() {
    manualMessageRef.current = null;
    stopSpeech();
    const current = sessionRef.current;
    if (current?.serverSessionId && connectionRef.current === "online") {
      await request(backendRef.current, `/sessions/${encodeURIComponent(current.serverSessionId)}/speech/stop`,
        acceptedSchema, { method: "POST", body: {}, signal: controllerRef.current?.signal }).catch(() => {});
    }
  }
  async function readMessage(message: Message) {
    if (readingMessageId === message.id) { await stopReadAloud(); return; }
    const current = sessionRef.current;
    if (!current?.serverSessionId || connectionRef.current !== "online") return;
    unlockSpeech();
    stopSpeech();
    manualMessageRef.current = message.id;
    setReadingMessageId(message.id);
    setSpeechStatus("preparing");
    try {
      await request(backendRef.current, `/sessions/${encodeURIComponent(current.serverSessionId)}/speech/replay`,
        acceptedSchema, { method: "POST", body: { messageId: message.id }, signal: controllerRef.current?.signal });
    } catch (error) {
      if (manualMessageRef.current !== message.id) return;
      manualMessageRef.current = null;
      stopSpeech();
      setNotice(errorText(error));
    }
  }
  const disconnect = useCallback(() => {
    manualMessageRef.current = null;
    reconciliationNeeded.current = false;
    epochRef.current++;
    clearTimeout(reconnectTimer.current);
    reconnectAttempts.current = 0;
    controllerRef.current?.abort();
    controlRequest.current?.abort();
    bufferRequest.current?.abort();
    nextPreparation.current?.abort();
    changeNextPending(false);
    clearTimeout(pendingResourceTimer.current);
    clearTimeout(nextGuardTimer.current);
    nextGuardUntil.current = 0;
    setNextCooldown(false);
    setControlBusy(false);
    pendingLocalAction.current = null;
    streamRef.current?.close();
    streamRef.current = null;
    playbackAction.current = "pause";
    audioRef.current?.pause();
    standbyRef.current?.pause();
    stopSpeech();
    changeConnection("offline");
    setSettingsSynced(false);
    changeActive(null);
    setActivity("");
    setCancelling(false);
  }, [changeActive, changeConnection, stopSpeech, changeNextPending]);

  useEffect(() => {
    let mounted = true;
    loadSession().then((value) => {
      if (!mounted) return;
      sessionRef.current = value;
      if (value.pauseRequested) pauseBarrier.current = Infinity;
      setSession(value);
      setStorageReady(true);
    }).catch((error) => {
      if (mounted) setNotice(errorText(error));
    });
    return () => {
      mounted = false;
      epochRef.current++;
      clearTimeout(reconnectTimer.current);
      streamRef.current?.close();
      controllerRef.current?.abort();
      nextPreparation.current?.abort();
      bufferRequest.current?.abort();
      clearTimeout(nextGuardTimer.current);
      clearTimeout(pendingResourceTimer.current);
      void speechStreamRef.current?.close();
    };
  }, []);
  useEffect(() => {
    try { savePreferences({ backend, settings, volume }); }
    catch { setNotice("浏览器未能保存本地设置。"); }
  }, [backend, settings, volume]);
  useEffect(() => {
    volumeRef.current = volume;
    if (audioRef.current) {
      audioRef.current.volume = speechActiveRef.current ? volume * 0.22 : volume;
    }
  }, [volume]);

  const playbackSync = usePlaybackSync(() => {
    const sessionId = sessionRef.current?.serverSessionId;
    return connectionRef.current === "online" && sessionId
      ? { backend: backendRef.current, sessionId, signal: controllerRef.current?.signal } : null;
  }, () => setNotice("播放器回执未能保存在本地，请保持页面打开。"));
  const flushPlaybackReceipts = () => playbackSync.flushReceipts();
  const flushPlaybackObservations = () => playbackSync.flushObservations();

  function playerObservation(): PlaybackAck | undefined {
    const audio = audioRef.current;
    const command = commandRef.current;
    if (!command || !audio?.getAttribute("src")) return;
    return { ...command, ackSequence: ackSequenceRef.current,
      status: audio.error ? "failed" : audio.ended ? "ended" : audio.paused ? "paused"
        : audio.readyState < 3 ? "loading" : "playing",
      positionMs: Math.round(audio.currentTime * 1000) };
  }

  async function reconcilePlayer() {
    if (!reconciliationNeeded.current || reconcilingPlayer.current || connectionRef.current !== "online" ||
      bufferRequest.current || nextPreparation.current || pendingLocalAction.current) return;
    const sessionId = sessionRef.current?.serverSessionId;
    if (!sessionId) return;
    const base = backendRef.current;
    if (localPlaybackOperations().some(item => item.backend === base && item.sessionId === sessionId)) return;
    const epoch = epochRef.current;
    const observation = playerObservation();
    if (observation?.status === "loading") return;
    reconcilingPlayer.current = true;
    try {
      const attached = await request(base, `/sessions/${encodeURIComponent(sessionId)}/player/attach`,
        PlayerAttachmentSchema, { method: "POST", body: { observation }, signal: controllerRef.current?.signal });
      if (epoch !== epochRef.current || commandRef.current?.commandId !== observation?.commandId) return;
      if (attached.reconciled) {
        const { ackSequence, ...command } = attached.reconciled;
        if (command.playbackVersion < radioRef.current.playbackVersion) return;
        commandRef.current = command;
        ackSequenceRef.current = ackSequence;
      }
      const snapshot = await request(base, `/sessions/${encodeURIComponent(sessionId)}`, SessionSchema,
        { signal: controllerRef.current?.signal });
      if (epoch !== epochRef.current) return;
      if (snapshot.radio.playbackVersion >= radioRef.current.playbackVersion &&
        snapshot.radio.queueVersion >= radioRef.current.queueVersion) {
        changeRadio(snapshot.radio);
        preparedRef.current = snapshot.prepared;
        prepareNextAudio();
      }
      reconciliationNeeded.current = false;
      void flushPlaybackObservations();
    } catch { /* Keep local audio running; retry reconciliation with the next sync tick. */ }
    finally { reconcilingPlayer.current = false; }
  }

  useEffect(() => {
    const timer = setInterval(() => {
      void flushLocalPlayback(); void flushPlaybackObservations(); void flushPlaybackReceipts();
      void reconcilePlayer();
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  async function flushLocalPlayback() {
    if (flushingLocalPlayback.current || connectionRef.current !== "online") return;
    flushingLocalPlayback.current = true;
    const epoch = epochRef.current;
    try {
      for (;;) {
        const item = localPlaybackOperations().find((entry) => entry.backend === backendRef.current &&
          entry.sessionId === sessionRef.current?.serverSessionId);
        if (!item || epoch !== epochRef.current) break;
        try {
          await request(item.backend, `/sessions/${encodeURIComponent(item.sessionId)}/playback/local`,
            acceptedSchema, { method: "POST", body: item.operation, signal: controllerRef.current?.signal });
          removeLocalPlayback(item);
        } catch (error) {
          if (error instanceof Error && ["PLAYBACK_VERSION_CONFLICT", "LOCAL_TRACK_CONFLICT",
            "RESOURCE_NOT_PREPARED", "IDEMPOTENCY_CONFLICT"].includes(error.message)) {
            const pending = localPlaybackOperations().filter((entry) => entry.backend === item.backend &&
              entry.sessionId === item.sessionId);
            const intent = pending.at(-1)?.operation ?? item.operation;
            for (const entry of pending) removeLocalPlayback(entry);
            bufferRequest.current?.abort();
            nextPreparation.current?.abort();
            changeNextPending(false);
            pendingLocalAction.current = null;
            clearTimeout(pendingResourceTimer.current);
            setControlBusy(false);
            const snapshot = await request(item.backend, `/sessions/${encodeURIComponent(item.sessionId)}`, SessionSchema);
            changeRadio(snapshot.radio);
            preparedRef.current = snapshot.prepared;
            // Recover the latest intent, without turning a synchronization error into a pause.
            if (intent.action === "pause" || intent.action === "stop") {
              void playbackControl(intent.action);
            } else if (intent.action === "select") {
              const message = sessionRef.current?.messages.find((m) => m.id === intent.messageId);
              const track = message?.tracks?.find((t) => t.id === intent.trackId);
              if (message && track) void playRecommendation(message.id, track);
            } else if (intent.action === "next" && snapshot.radio.queue[0]?.id === intent.trackId &&
              (intent.reason !== "ended" || snapshot.desiredPlayback === "play")) {
              void playbackControl("next", intent.reason === "ended");
            } else if (intent.action === "play" || snapshot.desiredPlayback === "play") {
              void playbackControl("play");
            } else {
              setPlaybackNotice("播放状态已同步，音乐会继续；下一次操作将使用最新队列。");
            }
          }
          break;
        }
      }
    } catch {
      setPlaybackNotice("播放状态等待同步；本地暂停仍然可用。");
    } finally {
      flushingLocalPlayback.current = false;
      void flushPlaybackObservations();
    }
  }

  function prepareNextAudio() {
    const track = radioRef.current.queue[0];
    const resource = preparedRef.current.find((item) => item.trackId === track?.id && item.expiresAt > Date.now() + 5000);
    const audio = standbyRef.current;
    if (!audio) return;
    if (!resource) {
      if (standbyTrack.current) { audio.removeAttribute("src"); audio.load(); standbyTrack.current = null; }
      return;
    }
    const url = musicAudioUrl(resource.url, backendRef.current);
    if (standbyTrack.current === track.id && audio.getAttribute("src") === url && !audio.error) return;
    standbyTrack.current = track.id;
    audio.preload = "auto";
    audio.src = url;
    audio.load();
  }

  async function reportPlayback(status: "loading" | "playing" | "paused" | "ended" | "failed" | "blocked", message?: string,
    observedCommand = commandRef.current) {
    const current = sessionRef.current;
    const command = observedCommand;
    if (!current?.serverSessionId || !command) return;
    try {
      savePlaybackObservation(backendRef.current, current.serverSessionId, {
        ...command, ackSequence: ++ackSequenceRef.current, status, message,
        positionMs: Math.round((audioRef.current?.currentTime ?? 0) * 1000),
      });
      await flushPlaybackObservations();
    } catch {
      setNotice("播放器回执未能保存在本地，请保持页面打开。");
    }
  }

  async function applyPlayback(event: Extract<AgentEvent, { type: "playback.command" }>) {
    const { payload } = event;
    const mediaUrl = payload.url ? musicAudioUrl(payload.url, backendRef.current) : undefined;
    if (payload.action === "play" && payload.playbackVersion <= pauseBarrier.current) return;
    if (seenCommands.current.has(payload.commandId) || Date.parse(payload.expiresAt) <= Date.now() ||
      payload.playbackVersion < radioRef.current.playbackVersion) return;
    nextPreparation.current?.abort();
    clearTimeout(pendingResourceTimer.current);
    controlRevision.current++;
    setControlBusy(false);
    pendingLocalAction.current = null;
    if (payload.action === "play") {
      pauseBarrier.current = 0;
      if (sessionRef.current?.pauseRequested) {
        void persist({ ...sessionRef.current, pauseRequested: false }).catch(() => {});
      }
    }
    seenCommands.current.add(payload.commandId);
    if (seenCommands.current.size > 200) seenCommands.current.delete(seenCommands.current.values().next().value!);
    const command = { commandId: payload.commandId, playbackVersion: payload.playbackVersion,
      trackId: payload.track?.id };
    const reportProgress = (phase: "received" | "executing") => {
      try {
        savePlaybackReceipt(backendRef.current, event.sessionId, {
          commandId: payload.commandId, playbackVersion: payload.playbackVersion, phase });
        void flushPlaybackReceipts();
      } catch { setPlaybackNotice("播放命令进度等待同步；本地播放不受影响。"); }
    };
    reportProgress("received");
    const previousAudio = audioRef.current;
    const sameTrack = payload.track?.id && payload.track.id === commandRef.current?.trackId;
    const resume = Boolean(payload.resume && sameTrack && !previousAudio?.ended && !playbackTerminal.current);
    const resumeSeconds = resume ? previousAudio?.currentTime ||
      (resumePoint.current?.trackId === payload.track?.id ? resumePoint.current?.seconds ?? 0 : 0) : 0;
    const keepSource = resume && previousAudio?.getAttribute("src") && !previousAudio.error;
    bufferRequest.current?.abort();
    commandRef.current = command;
    playbackAction.current = payload.action;
    pendingSeek.current = null;
    playbackTerminal.current = false;
    setPlaybackNotice("");
    ackSequenceRef.current = 0;
    if (payload.action === "play" && !resume && standbyRef.current && standbyTrack.current === payload.track?.id &&
      standbyRef.current.getAttribute("src") === mediaUrl) {
      const previous = audioRef.current;
      if (previous) mediaPauseGuard.current.mutate(previous, () => previous.pause());
      audioRef.current = standbyRef.current;
      standbyRef.current = previous;
      standbyTrack.current = null;
      if (previous) { previous.removeAttribute("src"); previous.load(); }
    }
    const audio = audioRef.current;
    if (!audio) {
      await reportPlayback("failed", "音频播放器尚未就绪。", command);
      return;
    }
    reportProgress("executing");
    if (payload.action !== "play") {
      changeNextPending(false);
      audio.pause();
      if (payload.action === "stop") { audio.currentTime = 0; resumePoint.current = null; }
      setAudioStatus("paused");
      await reportPlayback("paused");
      return;
    }
    if (!resume) resumePoint.current = null;
    if (mediaUrl && !keepSource && audio.getAttribute("src") !== mediaUrl) {
      audio.preload = "auto";
      mediaPauseGuard.current.mutate(audio, () => { audio.src = mediaUrl; });
      setPosition(0);
      setDuration(0);
    }
    if (resumeSeconds > 0) {
      pendingSeek.current = { commandId: command.commandId, seconds: resumeSeconds };
      if (audio.readyState >= 1) {
        audio.currentTime = Number.isFinite(audio.duration)
          ? Math.min(resumeSeconds, Math.max(0, audio.duration - 0.1)) : resumeSeconds;
        pendingSeek.current = null;
      }
    } else if (!resume && audio.currentTime > 0) audio.currentTime = 0;
    audio.volume = speechActiveRef.current ? volumeRef.current * 0.22 : volumeRef.current;
    if (payload.track) changeRadio({ ...radioRef.current, current: payload.track, playbackVersion: payload.playbackVersion });
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    setPosition(audio.currentTime);
    prepareNextAudio();
    if (!audio.getAttribute("src")) {
      setAudioStatus("failed");
      changeNextPending(false);
      await reportPlayback("failed", "播放命令没有有效资源。");
      return;
    }
    const alreadyPlaying = resume && keepSource && !audio.paused && !audio.ended;
    if (!alreadyPlaying) {
      setAudioStatus("loading");
      void reportPlayback("loading", undefined, command);
    }
    // Do not block the SSE event queue on play(): a stalled resource must not
    // prevent a newer pause/replace command from being processed.
    const buffering = new AbortController();
    bufferRequest.current = buffering;
    void waitForPlaybackBuffer(audio, buffering.signal).then(async () => {
      buffering.signal.throwIfAborted();
      if (commandRef.current?.commandId !== command.commandId || pauseBarrier.current) return;
      await audioEngine.unlock();
      if (buffering.signal.aborted || commandRef.current?.commandId !== command.commandId || pauseBarrier.current) return;
      return playWithConfirmation(audio,
        () => commandRef.current?.commandId === command.commandId && !pauseBarrier.current &&
          audioRef.current === audio && !buffering.signal.aborted,
        () => {
          setAudioStatus("playing");
          void reportPlayback("playing", undefined, command);
        }).then(() => {
        if (bufferRequest.current === buffering) bufferRequest.current = null;
      });
    }).catch(async (error) => {
      if (buffering.signal.aborted) return;
      if (commandRef.current?.commandId !== command.commandId) return;
      const blocked = error instanceof DOMException && error.name === "NotAllowedError";
      changeNextPending(false);
      setAudioStatus(blocked ? "blocked" : "failed");
      setPlaybackNotice(blocked ? "浏览器需要一次点击才能开始播放。" :
        error instanceof Error && error.message === "MEDIA_BUFFER_TIMEOUT"
          ? "音频加载较慢，尚未开始播放，可以重试或切换下一首。" : "音频未能开始播放。");
      await reportPlayback(blocked ? "blocked" : "failed", errorText(error), command);
    });
  }

  eventHandlerRef.current = async (event) => {
    const epoch = epochRef.current;
    const current = sessionRef.current;
    if (!current || event.sessionId !== current.serverSessionId || event.sequence <= current.lastSequence) return;
    if (event.sequence !== current.lastSequence + 1) {
      streamRef.current?.close();
      changeConnection("error");
      setNotice("事件序号不连续，请重新连接以同步状态。");
      return;
    }
    let messages = current.messages;
    if (event.type === "message.saved" || event.type === "reply.final") {
      messages = mergeMessage(messages, event.payload);
    }
    await persist({
      ...current,
      messages,
      lastSequence: event.sequence,
      events: [...current.events, toTrace(event)].slice(-200),
    });
    if (epoch !== epochRef.current) return;
    switch (event.type) {
      case "agent.activity":
        setActivity(event.payload.phase === "started"
          ? toolLabels[event.payload.tool] ?? event.payload.tool : "正在整理回应");
        break;
      case "queue.updated":
        if (event.payload.playbackVersion < radioRef.current.playbackVersion) break;
        changeRadio(event.payload);
        prepareNextAudio();
        if (pendingLocalAction.current && event.payload.queue.length) void playbackControl(pendingLocalAction.current, pendingAutomatic.current);
        break;
      case "resources.ready":
        preparedRef.current = event.payload;
        prepareNextAudio();
        if (pendingLocalAction.current) {
          const target = pendingLocalAction.current === "next" ? radioRef.current.queue[0] : radioRef.current.current;
          if (event.payload.some((item) => item.trackId === target?.id && item.expiresAt > Date.now() + 5000)) {
            void playbackControl(pendingLocalAction.current, pendingAutomatic.current);
          }
        }
        break;
      case "maintenance.updated": break;
      case "playback.command": await applyPlayback(event); break;
      case "playback.received": break;
      case "speech.synthesizing":
        if (event.payload.manual ? manualMessageRef.current === event.payload.messageId : settingsRef.current.autoSpeech) {
          setSpeechStatus("preparing");
          setReadingMessageId(event.payload.messageId);
        }
        break;
      case "service.updated":
        setServiceIssues((previous) => [
          ...previous.filter((item) => item.service !== event.payload.service),
          ...(event.payload.issue ? [event.payload.issue] : []),
        ]);
        break;
      case "settings.updated":
        if (!settingsDirty.current) {
          settingsRef.current = event.payload;
          setSettings(event.payload);
          setSettingsSynced(true);
          if (!event.payload.autoSpeech) stopSpeech();
        }
        break;
      case "model.attempt": break;
      case "context.updated":
        if (event.payload.mode === "foreground" && event.requestId === activeRef.current) {
          setActivity(event.payload.phase === "waiting" ? "正在整理前面的对话…" :
            event.payload.phase === "failed" ? "对话整理暂时失败" : "正在整理回应");
        }
        break;
      case "speech.completed":
      case "speech.observed": break;
      case "speech.ready": {
        const manual = event.payload.manual && manualMessageRef.current === event.payload.messageId;
        if ((event.payload.manual ? !manual : !settingsRef.current.autoSpeech) || Date.parse(event.payload.expiresAt) <= Date.now()) break;
        const proactive = !manual && sessionRef.current?.messages.find((message) => message.id === event.payload.messageId)?.proactive;
        if (proactive && (pauseBarrier.current || !audioRef.current || audioRef.current.paused)) break;
        stopSpeech();
        setReadingMessageId(event.payload.messageId ?? null);
        speechProactiveRef.current = Boolean(proactive);
        const id = event.payload.speechId;
        speechIdRef.current = id;
        speechAckSequence.current = 0;
        setSpeechStatus("preparing");
        const url = event.payload.url.startsWith("/api/lab/")
          ? `${backendRef.current}${event.payload.url.slice("/api/lab".length)}` : event.payload.url;
        if (event.payload.format === "pcm16") {
          speechStreamRef.current ??= new SpeechStreamPlayer();
          void speechStreamRef.current.play(url, event.payload.sampleRate ?? 24000, {
            playing: () => {
              if (speechIdRef.current !== id) return;
              speechActiveRef.current = true;
              setSpeechStatus("playing");
              if (audioRef.current) audioRef.current.volume = volumeRef.current * 0.22;
              reportSpeech(id, "playing");
              window.dispatchEvent(new CustomEvent("claudio:speech-playing", { detail: { speechId: id } }));
            },
            ended: () => { if (speechIdRef.current === id) stopSpeech("ended"); },
            failed: (blocked) => {
              if (speechIdRef.current !== id) return;
              stopSpeech(blocked ? "blocked" : "failed");
              setSpeechStatus("failed");
              setNotice(blocked ? "浏览器需要一次点击才能播报，请重新打开语音播报。" :
                "这次语音播放中断，文字回复已保留。");
            },
          });
          break;
        }
        const speech = speechRef.current;
        if (speech) {
          speech.crossOrigin = "anonymous";
          audioEngine.attach(speech, "speech");
          speech.src = url;
          void speech.play().catch(() => {
            if (speechIdRef.current !== id) return;
            stopSpeech("blocked");
            setSpeechStatus("failed");
            setNotice("语音未能播放；文字回复已保留。");
          });
        }
        break;
      }
      case "speech.cancelled": stopSpeech(); break;
      case "speech.failed":
        if (event.payload.speechId && speechIdRef.current && event.payload.speechId !== speechIdRef.current) break;
        stopSpeech("failed");
        setSpeechStatus("failed");
        if (!["TTS_AUTH_FAILED", "TTS_BALANCE", "TTS_PERMISSION_DENIED", "TTS_CONFIGURATION"].includes(event.payload.code)) {
          setNotice(event.payload.code === "TTS_RATE_LIMITED" ? "MiMo 语音服务暂时限流，这次不播报；文字回复已保留。" :
            "这次语音未能生成，文字回复已保留。");
        }
        break;
      case "run.completed":
      case "run.partial":
      case "run.cancelled":
      case "run.failed":
        if (event.requestId === activeRef.current) {
          changeActive(null);
          setActivity("");
          setCancelling(false);
        }
        setLastRun(event.payload);
        if (event.payload.incident) {
          if (["banner", "blocking"].includes(event.payload.incident.visibility)) {
            if (event.payload.incident.recovery === "play") setPlaybackNotice(event.payload.incident.message);
            else if (event.payload.incident.recovery !== "configure") setNotice(event.payload.incident.message);
          }
        } else if (event.type === "run.failed") setNotice(event.payload.message ?? "本次运行失败。");
        break;
    }
  };

  function openEvents(base: string, snapshot: Snapshot, epoch: number) {
    clearTimeout(reconnectTimer.current);
    streamRef.current?.close();
    const stream = new EventSource(eventUrl(base, snapshot.sessionId, snapshot.lastSequence));
    streamRef.current = stream;
    stream.onopen = () => {
      if (epoch === epochRef.current && streamRef.current === stream) {
        if (connectionRef.current === "reconnecting") reconciliationNeeded.current = true;
        reconnectAttempts.current = 0;
        changeConnection("online");
        setNotice((value) => value === reconnectNotice ? "" : value);
        void flushPlaybackObservations();
        void flushLocalPlayback();
        void reconcilePlayer();
      }
    };
    stream.onerror = () => {
      if (epoch !== epochRef.current || streamRef.current !== stream) return;
      stream.close();
      changeConnection("reconnecting");
      setNotice(reconnectNotice);
      stopSpeech();
      const delay = Math.min(10_000, 1000 * 2 ** Math.min(reconnectAttempts.current++, 4));
      reconnectTimer.current = setTimeout(() => {
        const current = sessionRef.current;
        if (epoch !== epochRef.current || streamRef.current !== stream ||
          current?.serverSessionId !== snapshot.sessionId) return;
        openEvents(base, { ...snapshot, lastSequence: current.lastSequence }, epoch);
      }, delay);
    };
    stream.onmessage = (message) => {
      if (epoch !== epochRef.current || streamRef.current !== stream) return;
      let decoded: unknown;
      try { decoded = JSON.parse(message.data); }
      catch { setNotice("收到无法解析的事件。"); return; }
      const parsed = EventSchema.safeParse(decoded);
      if (!parsed.success) { setNotice("收到不符合验证协议的事件。"); return; }
      eventChain.current = eventChain.current.catch(() => {}).then(async () => {
        if (epoch === epochRef.current) await eventHandlerRef.current(parsed.data);
      }).catch((error) => {
        stream.close();
        changeConnection("error");
        setNotice(errorText(error));
      });
    };
  }

  async function connect(event?: FormEvent) {
    event?.preventDefault();
    unlockSpeech();
    if (!storageReady || !sessionRef.current) return;
    disconnect();
    const epoch = epochRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    changeConnection("connecting");
    setNotice("");
    try {
      const base = normalizeBase(backend);
      backendRef.current = base;
      setBackend(base);
      const health = await request(base, "/health", HealthSchema, { signal: controller.signal });
      if (epoch !== epochRef.current) return;
      const local = sessionRef.current;
      if (!local) return;
      const existing = local.backend === base ? local.serverSessionId : undefined;
      if (local.backend && local.backend !== base && local.messages.length) {
        throw new Error("切换后端前请新建会话，避免混入其他后端的记录。");
      }
      let snapshot = await request(base,
        existing ? `/sessions/${encodeURIComponent(existing)}` : "/sessions",
        SessionSchema, {
          ...(existing ? {} : { method: "POST", body: { clientSessionId: local.id } }),
          signal: controller.signal,
        });
      for (const item of localPlaybackOperations().filter((entry) => entry.backend === base &&
        entry.sessionId === snapshot.sessionId)) {
        try {
          await request(base, `/sessions/${encodeURIComponent(snapshot.sessionId)}/playback/local`,
            acceptedSchema, { method: "POST", body: item.operation, signal: controller.signal });
        } catch (error) {
          if (!(error instanceof Error) || !["PLAYBACK_VERSION_CONFLICT", "LOCAL_TRACK_CONFLICT",
            "RESOURCE_NOT_PREPARED", "IDEMPOTENCY_CONFLICT"].includes(error.message)) throw error;
          // A rejected replay is not a user pause. Preserve the local playback intent.
          if (item.operation.action === "pause" || item.operation.action === "stop") pauseBarrier.current = Infinity;
        }
        removeLocalPlayback(item);
      }
      snapshot = await request(base, `/sessions/${encodeURIComponent(snapshot.sessionId)}`, SessionSchema,
        { signal: controller.signal });
      if (pauseBarrier.current) {
        await request(base, `/sessions/${encodeURIComponent(snapshot.sessionId)}/playback/commands`,
          acceptedSchema, { method: "POST", body: { action: "pause", requestId: crypto.randomUUID(),
            expectedPlaybackVersion: snapshot.radio.playbackVersion }, signal: controller.signal });
        pauseBarrier.current = snapshot.radio.playbackVersion + 1;
        snapshot = await request(base, `/sessions/${encodeURIComponent(snapshot.sessionId)}`,
          SessionSchema, { signal: controller.signal });
      }
      // Capabilities may be temporarily unavailable; they must not erase a
      // persisted choice. Existing sessions own their confirmed settings.
      const supported = health.capabilities ?? { autoSpeech: false, proactive: false };
      const desiredSettings = existing && !settingsDirty.current ? snapshot.settings : settingsRef.current;
      const confirmedSettings = existing && !settingsDirty.current ? snapshot.settings :
        await request(base, `/sessions/${encodeURIComponent(snapshot.sessionId)}/settings`,
          SettingsSchema, { method: "PATCH", body: desiredSettings, signal: controller.signal });
      const observation = existing ? playerObservation() : undefined;
      const attached = await request(base, `/sessions/${encodeURIComponent(snapshot.sessionId)}/player/attach`,
        PlayerAttachmentSchema, { method: "POST", body: { observation }, signal: controller.signal });
      if (epoch !== epochRef.current) return;
      if (attached.reconciled) {
        const { ackSequence, ...command } = attached.reconciled;
        commandRef.current = command;
        ackSequenceRef.current = ackSequence;
        snapshot = await request(base, `/sessions/${encodeURIComponent(snapshot.sessionId)}`, SessionSchema,
          { signal: controller.signal });
        if (epoch !== epochRef.current) return;
      }
      const pending = sessionRef.current?.messages.filter((m) =>
        m.role === "user" && ["pending", "failed"].includes(m.status) &&
        !snapshot.messages.some((saved) => saved.clientMessageId === m.clientMessageId),
      ) ?? [];
      await persist({
        ...sessionRef.current!,
        backend: base,
        serverSessionId: snapshot.sessionId,
        messages: [...snapshot.messages, ...pending],
        lastSequence: snapshot.lastSequence,
      });
      if (epoch !== epochRef.current) return;
      settingsRef.current = confirmedSettings;
      settingsDirty.current = false;
      setSettings(confirmedSettings);
      setSettingsSynced(true);
      setModel(health.model);
      setModelReady(health.modelConfigured ?? Boolean(health.model));
      setMusicProvider(health.musicProvider ?? null);
      setCapabilities(supported);
      setServiceIssues(snapshot.serviceIssues);
      if (health.modelConfigured === false) setNotice("后端已连接，模型尚未配置，暂时不能运行 Agent。");
      changeRadio(snapshot.radio);
      preparedRef.current = snapshot.prepared;
      prepareNextAudio();
      changeActive(snapshot.activeRequestId);
      setActivity(snapshot.activeRequestId ? "等待运行结果" : "");
      openEvents(base, snapshot, epoch);
    } catch (error) {
      if (epoch !== epochRef.current) return;
      streamRef.current?.close();
      changeConnection("error");
      setNotice(errorText(error));
    }
  }

  async function createSession() {
    if (activeRef.current || connectionRef.current === "connecting") return;
    const fresh = newSession();
    disconnect();
    await persist(fresh);
    pauseBarrier.current = 0;
    changeRadio(emptyRadio);
    setModel(null);
    setLastRun({});
    setView("chat");
    setNotice("");
    setPosition(0);
    setDuration(0);
    setAudioStatus("idle");
    setPlaybackNotice("");
    commandRef.current = null;
    seenCommands.current.clear();
    if (audioRef.current) {
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    composerRef.current?.focus();
  }

  async function sendMessage(existing?: Message) {
    manualMessageRef.current = null;
    unlockSpeech();
    const current = sessionRef.current;
    const text = existing?.text ?? current?.draft.trim();
    if (!current?.serverSessionId || connectionRef.current !== "online" || !text || !modelReady) return;
    if (activeRef.current && existing?.requestId !== activeRef.current) return;
    const epoch = epochRef.current;
    const requestId = existing?.requestId ?? crypto.randomUUID();
    const clientMessageId = existing?.clientMessageId ?? crypto.randomUUID();
    const message: Message = {
      id: existing?.id ?? clientMessageId, requestId, clientMessageId,
      role: "user", text, createdAt: existing?.createdAt ?? new Date().toISOString(), status: "pending",
    };
    setNotice("");
    stopSpeech();
    try {
      await persist({
        ...current,
        draft: existing ? current.draft : "",
        messages: mergeMessage(current.messages, message),
      });
      if (epoch !== epochRef.current) return;
      changeActive(requestId);
      setActivity("等待保存确认");
      const result = await request(backendRef.current,
        `/sessions/${encodeURIComponent(current.serverSessionId)}/messages`,
        messageAckSchema, {
          method: "POST", body: { clientMessageId, requestId, text },
          signal: controllerRef.current?.signal,
        });
      if (epoch !== epochRef.current) return;
      if (result.message.clientMessageId !== clientMessageId) throw new Error("保存确认的消息 ID 不一致。");
      const latest = sessionRef.current!;
      await persist({ ...latest, messages: mergeMessage(latest.messages, result.message) });
      if (activeRef.current === requestId) setActivity("等待 Agent 回应");
    } catch (error) {
      if (epoch !== epochRef.current) return;
      const latest = sessionRef.current!;
      const found = latest.messages.find((m) => m.clientMessageId === clientMessageId);
      if (found?.status === "pending") {
        await persist({
          ...latest,
          messages: mergeMessage(latest.messages, { ...found, status: "failed" }),
        }).catch(() => {});
      }
      setNotice(errorText(error));
      setActivity("请求状态待确认");
    }
  }

  async function cancelRun() {
    const current = sessionRef.current;
    if (!activeRef.current || !current?.serverSessionId || cancelling) return;
    const requestId = activeRef.current;
    const epoch = epochRef.current;
    setCancelling(true);
    try {
      await request(backendRef.current,
        `/sessions/${encodeURIComponent(current.serverSessionId)}/runs/${encodeURIComponent(requestId)}/cancel`,
        acceptedSchema, { method: "POST", body: {}, signal: controllerRef.current?.signal });
      if (epoch === epochRef.current && activeRef.current === requestId) setActivity("等待取消确认");
    } catch (error) { if (epoch === epochRef.current) setNotice(errorText(error)); }
    finally { if (epoch === epochRef.current) setCancelling(false); }
  }

  async function startRadio(startup = false) {
    const current = sessionRef.current;
    if (!current?.serverSessionId || activeRef.current || connectionRef.current !== "online") return;
    const requestId = crypto.randomUUID();
    changeActive(requestId); setActivity("正在准备电台");
    try {
      const result = await request(backendRef.current, `/sessions/${encodeURIComponent(current.serverSessionId)}/opening`,
        z.object({ accepted: z.boolean(), duplicate: z.boolean() }), { method: "POST", body: { requestId, startup } });
      if (result.duplicate && activeRef.current === requestId) {
        changeActive(null); setActivity(""); setNotice("今天已经打过招呼了，直接告诉 Claudio 你想听什么就好。");
      }
    } catch (error) {
      if (activeRef.current === requestId) { changeActive(null); setActivity(""); }
      setNotice(errorText(error));
    }
  }
  async function trackFeedback(choice: "like" | "dislike") {
    const current = sessionRef.current;
    const track = radioRef.current.current;
    if (!current?.serverSessionId || !track || connectionRef.current !== "online") return;
    const next = feedback[track.id] === choice ? "clear" : choice;
    try {
      await request(backendRef.current, `/sessions/${encodeURIComponent(current.serverSessionId)}/feedback`,
        acceptedSchema, { method: "POST", body: { trackId: track.id, choice: next } });
      setFeedback((previous) => ({ ...previous, [track.id]: next }));
    } catch (error) { setNotice(errorText(error)); }
  }

  async function changeSettings(key: keyof Settings) {
    if (key === "autoSpeech") unlockSpeech();
    if (settingsBusy) return;
    const next = { ...settingsRef.current, [key]: !settingsRef.current[key] };
    settingsDirty.current = true;
    settingsRef.current = next;
    setSettings(next);
    setSettingsSynced(false);
    if (key === "autoSpeech" && !next.autoSpeech) stopSpeech();
    const current = sessionRef.current;
    if (!current?.serverSessionId || connectionRef.current !== "online") return;
    const epoch = epochRef.current;
    setSettingsBusy(true);
    try {
      const saved = await request(backendRef.current,
        `/sessions/${encodeURIComponent(current.serverSessionId)}/settings`,
        SettingsSchema, { method: "PATCH", body: next, signal: controllerRef.current?.signal });
      if (epoch !== epochRef.current) return;
      setSettingsSynced(saved.autoSpeech === next.autoSpeech && saved.proactive === next.proactive &&
        saved.allowPreview === next.allowPreview);
      settingsDirty.current = false;
    } catch (error) {
      if (epoch === epochRef.current) setNotice(`本地设置已改变，后端同步未确认：${errorText(error)}`);
    } finally { setSettingsBusy(false); }
  }

  function requestNext() {
    if (performance.now() < nextGuardUntil.current || nextPendingRef.current) return;
    nextGuardUntil.current = performance.now() + 400;
    setNextCooldown(true);
    clearTimeout(nextGuardTimer.current);
    nextGuardTimer.current = setTimeout(() => setNextCooldown(false), 400);
    changeNextPending(true);
    void playbackControl("next");
  }

  async function playRecommendation(messageId: string, track: Track) {
    const current = sessionRef.current;
    if (!current?.serverSessionId || connectionRef.current !== "online") {
      setPlaybackNotice("连接恢复后可播放推荐歌曲。");
      return;
    }
    nextPreparation.current?.abort();
    changeNextPending(false);
    const controller = new AbortController();
    nextPreparation.current = controller;
    const epoch = epochRef.current;
    const version = radioRef.current.playbackVersion;
    setCardPending(track.id);
    try {
      const resource = await request(backendRef.current,
        `/sessions/${encodeURIComponent(current.serverSessionId)}/recommendations/prepare`, PreparedTrackSchema,
        { method: "POST", body: { messageId, trackId: track.id }, signal: controller.signal });
      if (epoch !== epochRef.current || controller.signal.aborted || version !== radioRef.current.playbackVersion) return;
      preparedRef.current = [...preparedRef.current.filter((r) => r.trackId !== track.id), resource];
      await playbackControl("select", false, track, messageId);
    } catch (error) {
      if (!controller.signal.aborted) setPlaybackNotice(error instanceof Error && error.message === "RESOURCE_UNAVAILABLE"
        ? "这首目前没有可用音频，当前播放和待播列表保持原样。" : "这首暂时未能加载，请重试。");
    } finally {
      if (nextPreparation.current === controller) {
        nextPreparation.current = null;
        setCardPending(null);
      }
    }
  }

  async function playbackControl(action: "play" | "pause" | "next" | "stop" | "select", automatic = false,
    selectedTrack?: Track, messageId?: string) {
    const current = sessionRef.current;
    if (!current?.serverSessionId) { changeNextPending(false); return; }
    clearTimeout(pendingResourceTimer.current);
    pendingAutomatic.current = automatic;
    if (action === "pause" || action === "stop") {
      if (speechProactiveRef.current) stopSpeech();
      controlRequest.current?.abort();
      bufferRequest.current?.abort();
      nextPreparation.current?.abort();
      changeNextPending(false);
      pauseBarrier.current = Infinity;
      audioRef.current?.pause();
      setAudioStatus("paused");
      pendingLocalAction.current = null;
      setControlBusy(false);
      if (sessionRef.current) void persist({ ...sessionRef.current, pauseRequested: true }).catch(() => {});
    }
    const starts = action === "play" || action === "next" || action === "select";
    const track = action === "select" ? selectedTrack : action === "next" ? radioRef.current.queue[0] : radioRef.current.current;
    if (starts && !track) {
      if (action === "next") pendingLocalAction.current = "next";
      setPlaybackNotice("正在等待后续歌曲。");
      changeNextPending(false);
      return;
    }
    const loaded = audioRef.current;
    const resource = preparedRef.current.find((item) => item.trackId === track?.id &&
      item.expiresAt > Date.now() + 5000 && (settingsRef.current.allowPreview || item.availability !== "preview_only")) ??
      (action === "play" && track && commandRef.current?.trackId === track.id && loaded?.getAttribute("src") &&
        !loaded.error && (settingsRef.current.allowPreview || track.availability !== "preview_only")
        ? { trackId: track.id, url: loaded.src, expiresAt: Date.now() + 30_000,
          availability: track.availability, playableDurationMs: track.playableDurationMs } : undefined);
    if (starts && !resource) {
      if (action === "select") { setPlaybackNotice("这首音频已过期，请再次点击歌曲卡片。"); return; }
      pendingLocalAction.current = action;
      setControlBusy(true);
      setPlaybackNotice("正在准备音频，暂停仍然可用。");
      const revision = ++controlRevision.current;
      pendingResourceTimer.current = setTimeout(() => {
        if (revision !== controlRevision.current) return;
        pendingLocalAction.current = null;
        setControlBusy(false);
        changeNextPending(false);
        setPlaybackNotice("音频暂时未准备好，请重试或换一首。");
      }, 10_000);
      if (connectionRef.current === "online") {
        void request(backendRef.current, `/sessions/${encodeURIComponent(current.serverSessionId)}/resources`,
          z.array(PreparedTrackSchema), { signal: controllerRef.current?.signal }).then((prepared) => {
            if (revision !== controlRevision.current) return;
            preparedRef.current = prepared;
            prepareNextAudio();
            if (prepared.some((item) => item.trackId === track!.id) && pendingLocalAction.current === action) {
              void playbackControl(action, automatic);
            }
          }).catch(() => {});
      }
      return;
    }
    if (action === "next") {
      if (nextPreparation.current && !nextPreparation.current.signal.aborted) return;
      const controller = new AbortController();
      nextPreparation.current = controller;
      const epoch = epochRef.current;
      const version = radioRef.current.playbackVersion;
      changeNextPending(true);
      setPlaybackNotice("正在准备下一首…");
      prepareNextAudio();
      try {
        const standby = standbyRef.current;
        if (!standby || standbyTrack.current !== track!.id) throw new Error("MEDIA_RESOURCE_FAILED");
        await waitForPlaybackBuffer(standby, controller.signal);
        controller.signal.throwIfAborted();
        if (epoch !== epochRef.current || version !== radioRef.current.playbackVersion ||
          radioRef.current.queue[0]?.id !== track!.id) {
          changeNextPending(false);
          setPlaybackNotice("待播歌曲已更新，请重新切歌。");
          return;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          changeNextPending(false);
          setPlaybackNotice("下一首暂时未能加载，可重试切歌。");
        }
        return;
      } finally {
        if (nextPreparation.current === controller) nextPreparation.current = null;
      }
    }
    controlRevision.current++;
    pendingLocalAction.current = null;
    setControlBusy(false);
    try {
      const commandId = crypto.randomUUID();
      const previous = radioRef.current;
      saveLocalPlayback({ backend: backendRef.current, sessionId: current.serverSessionId,
        operation: { commandId, action, expectedPlaybackVersion: previous.playbackVersion,
          reason: automatic ? "ended" : "user",
          ...(messageId ? { messageId } : {}),
          ...(starts && track ? { trackId: track.id } : {}) } });
      const playbackVersion = previous.playbackVersion + 1;
      pauseBarrier.current = starts ? 0 : playbackVersion;
      if (starts && sessionRef.current) void persist({ ...sessionRef.current, pauseRequested: false }).catch(() => {});
      const selected = resource && track ? { ...track, availability: resource.availability,
        playableDurationMs: resource.playableDurationMs } : track;
      changeRadio({ ...previous, playbackVersion,
        ...(action === "select" ? { current: selected! } : {}),
        ...(action === "next" ? { current: selected!, queue: previous.queue.slice(1), queueVersion: previous.queueVersion + 1 } : {}) });
      await applyPlayback({ id: commandId, sessionId: current.serverSessionId, sequence: 1,
        at: new Date().toISOString(), type: "playback.command", payload: {
          commandId, action: starts ? "play" : action as "pause" | "stop", playbackVersion,
          resume: action === "play",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          ...(resource ? { url: resource.url } : {}), ...(selected ? { track: selected } : {}),
        } });
      setPlaybackNotice("");
      void flushLocalPlayback();
    } catch (error) { changeNextPending(false); setPlaybackNotice(errorText(error)); }
  }

  function exportTrace() {
    const current = sessionRef.current;
    if (!current) return;
    const blob = new Blob([JSON.stringify({
      sessionId: current.serverSessionId ?? current.id,
      exportedAt: new Date().toISOString(), messages: current.messages, events: current.events,
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `claudio-session-${current.id.slice(0, 8)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const online = connection === "online";
  const busy = Boolean(activeRequest);
  const messages = session?.messages ?? [];
  const events = session?.events ?? [];
  const audioLabels = {
    idle: "尚未播放", loading: "正在加载", playing: "正在播放",
    paused: "已暂停", blocked: "等待点击播放", failed: "播放失败",
  };
  const failedMessages = messages.filter((m) => m.role === "user" && ["pending", "failed"].includes(m.status));
  const playbackIntended = audioStatus === "playing" ||
    nextPending || controlBusy || (audioStatus === "loading" && !pauseBarrier.current);
  const musicHandlers: AudioHTMLAttributes<HTMLAudioElement> = {
    preload: "auto",
    onTimeUpdate: (event) => {
      if (event.currentTarget !== audioRef.current) return;
      setPosition(event.currentTarget.currentTime);
      const trackId = commandRef.current?.trackId;
      if (trackId && event.currentTarget.currentTime > 0) resumePoint.current = { trackId, seconds: event.currentTarget.currentTime };
    },
    onLoadedMetadata: (event) => {
      if (event.currentTarget !== audioRef.current) return;
      const seek = pendingSeek.current;
      if (seek && seek.commandId === commandRef.current?.commandId) {
        event.currentTarget.currentTime = Number.isFinite(event.currentTarget.duration)
          ? Math.min(seek.seconds, Math.max(0, event.currentTarget.duration - 0.1)) : seek.seconds;
        pendingSeek.current = null;
      }
      setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
    },
    onPlaying: (event) => {
      mediaPauseGuard.current.playing(event.currentTarget);
      if (event.currentTarget !== audioRef.current) return;
      if (pauseBarrier.current) { event.currentTarget.pause(); return; }
      if (playbackTerminal.current || event.currentTarget.paused || event.currentTarget.currentSrc !== event.currentTarget.src) return;
      setPlaybackNotice("");
      setAudioStatus("playing");
      if (!nextPreparation.current && !pendingLocalAction.current) changeNextPending(false);
      void reportPlayback("playing");
    },
    onPause: (event) => {
      if (mediaPauseGuard.current.consume(event.currentTarget)) return;
      if (!event.currentTarget.paused) return;
      if (event.currentTarget === audioRef.current && (pauseBarrier.current || !bufferRequest.current ||
        bufferRequest.current.signal.aborted)) setAudioStatus((status) => status === "blocked" ? status : "paused");
      if (event.currentTarget === audioRef.current && event.currentTarget.currentTime > 0 &&
        !event.currentTarget.ended && !playbackTerminal.current && playbackAction.current === "play" &&
        !pauseBarrier.current && !bufferRequest.current && !nextPreparation.current) {
        // Headset/OS pauses are real user interruptions, not a request to restart the track.
        if (commandRef.current?.trackId) resumePoint.current = {
          trackId: commandRef.current.trackId, seconds: event.currentTarget.currentTime };
        void playbackControl("pause");
      }
    },
    onWaiting: (event) => {
      if (event.currentTarget === audioRef.current && !event.currentTarget.paused && !playbackTerminal.current) {
        setAudioStatus("loading");
        void reportPlayback("loading");
      }
    },
    onEnded: (event) => {
      if (event.currentTarget !== audioRef.current || playbackTerminal.current) return;
      playbackTerminal.current = true;
      resumePoint.current = null;
      setAudioStatus("idle");
      void reportPlayback("ended");
      if (!pauseBarrier.current && !nextPendingRef.current) void playbackControl("next", true);
    },
    onError: (event) => {
      if (event.currentTarget !== audioRef.current) return;
      if (event.currentTarget.getAttribute("src") && event.currentTarget.error &&
        event.currentTarget.currentSrc === event.currentTarget.src) {
        setAudioStatus("failed");
        if (!nextPreparation.current && !pendingLocalAction.current) changeNextPending(false);
        setPlaybackNotice("播放器报告资源不可用，可以重试或切换下一首。");
        void reportPlayback("failed", "浏览器媒体资源错误；原因未确认。");
      }
    },
  };

  return {
    backend, setBackend, connection, online, model, modelReady, musicProvider,
    settings, settingsBusy, settingsSynced, capabilities, changeSettings,
    radio, audioStatus, playbackIntended, nextPending, nextCooldown, controlBusy,
    position, setPosition, duration, volume, setVolume, audioRef,
    playbackNotice, requestNext, playbackControl, trackFeedback, feedback,
    busy, cancelling, session, sessionRef, storageReady, messages, events, persist,
    activeRequest, activity, lastRun, composerRef, controllerRef, lastActivityAt, backendRef,
    notice, setNotice, serviceIssues, connect, disconnect, startRadio, createSession,
    sendMessage, cancelRun, playRecommendation, cardPending, exportTrace,
    speechStatus, stopReadAloud, registerMusicA, registerMusicB, musicHandlers,
    speechRef, speechActiveRef, speechIdRef, reportSpeech, stopSpeech, volumeRef,
    readingMessageId, readMessage, setSpeechStatus,
    refreshServices: async () => {
      try {
        const health = await request(backendRef.current, "/health", HealthSchema);
        setModel(health.model);
        setModelReady(health.modelConfigured ?? Boolean(health.model));
        setCapabilities(health.capabilities ?? { autoSpeech: false, proactive: false });
      } catch { setNotice("配置已保存，但服务状态暂未刷新，请稍后重新连接。"); }
    },
  };
}
