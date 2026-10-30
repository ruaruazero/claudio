import { useEffect, useRef } from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { request } from "./api";
import { QUEUE_POLICY } from "./queue-policy";
import { eventLabels, labels, timeLabel, toolLabels, useRadioController } from "./useRadioController";
import { RadioExperience } from "./ui/RadioExperience";

export function App() {
  const radio = useRadioController();
  const connectedOnce = useRef(false);
  const startedOnce = useRef(false);
  useEffect(() => {
    if (radio.storageReady && !connectedOnce.current) {
      connectedOnce.current = true;
      void radio.connect();
    }
  }, [radio.storageReady]);
  useEffect(() => {
    if (startedOnce.current || !radio.online || radio.busy) return;
    if (!radio.radio.current && !radio.radio.queue.length && !radio.modelReady) return;
    startedOnce.current = true;
    if (radio.radio.current) {
      if (radio.audioStatus !== "playing") void radio.playbackControl("play");
    } else if (radio.radio.queue.length) {
      void radio.playbackControl("next");
    } else {
      void radio.startRadio(true);
    }
  }, [radio.online, radio.busy, radio.modelReady, radio.radio.current, radio.radio.queue.length]);
  const queue = radio.radio.queue.slice(0, QUEUE_POLICY.visibleCount);
  const trace = <div className="trace-panel">
    <div className="trace-meta"><span>{radio.events.length} 条事件</span>
      <button type="button" className="text-button" disabled={!radio.messages.length && !radio.events.length}
        onClick={radio.exportTrace}><Download size={13} />导出</button>
      <button type="button" className="text-button" disabled={!radio.events.length} onClick={() => {
        if (radio.sessionRef.current) void radio.persist({ ...radio.sessionRef.current, events: [] }).catch(() => {});
      }}><Trash2 size={13} />清空本地记录</button>
    </div>
    <div className="trace-meta"><span>{radio.model || "模型未连接"}</span>
      <span>{radio.lastRun.durationMs !== undefined ? `${(radio.lastRun.durationMs / 1000).toFixed(1)} s` : ""}</span>
    </div>
    {!radio.events.length && <p className="settings-placeholder">暂无运行事件</p>}
    {radio.events.map(event => <details key={event.id} className={`trace-event ${event.type.includes("failed") ? "trace-error" : ""}`}>
      <summary>{timeLabel(event.at)} · {event.type === "agent.activity"
        ? toolLabels[(event.payload as { tool: string }).tool] || (event.payload as { tool: string }).tool
        : eventLabels[event.type] || event.type}</summary>
      <pre>{JSON.stringify(event, null, 2)}</pre>
    </details>)}
    <button type="button" className="text-button" disabled={!radio.storageReady || radio.busy}
      onClick={() => void radio.createSession().then(() => radio.connect()).catch(error => radio.setNotice(String(error)))}>
      <Plus size={14} />开始新场次
    </button>
  </div>;
  return <RadioExperience
    player={{
      current: radio.radio.current, playing: radio.playbackIntended, loading: radio.audioStatus === "loading",
      nextPending: radio.nextPending,
      nextDisabled: !radio.radio.queue.length || radio.controlBusy || radio.nextPending || radio.nextCooldown,
      liked: Boolean(radio.radio.current && radio.feedback[radio.radio.current.id] === "like"),
      canLike: radio.online && Boolean(radio.radio.current), position: radio.position, duration: radio.duration,
      volume: radio.volume, canSeek: Boolean(radio.duration && radio.audioRef.current?.getAttribute("src")),
      notice: radio.playbackNotice,
      onPlayPause: () => void radio.playbackControl(radio.playbackIntended ? "pause" : "play"),
      onNext: radio.requestNext, onLike: () => void radio.trackFeedback("like"), onVolume: radio.setVolume,
      onSeek: position => {
        if (radio.audioRef.current) radio.audioRef.current.currentTime = position;
        radio.setPosition(position);
      },
    }}
    tracks={queue}
    conversation={{
      messages: radio.messages, draft: radio.session?.draft || "", ready: radio.storageReady,
      canSend: radio.online && radio.modelReady, busy: radio.busy, cancelling: radio.cancelling, activity: radio.activity,
      online: radio.online, canSpeak: radio.capabilities.autoSpeech, readingId: radio.readingMessageId,
      cardPending: radio.cardPending, composerRef: radio.composerRef,
      onDraft: draft => {
        const current = radio.sessionRef.current;
        if (current?.serverSessionId && radio.online && Date.now() - radio.lastActivityAt.current > 2000) {
          radio.lastActivityAt.current = Date.now();
          void request(radio.backendRef.current, `/sessions/${encodeURIComponent(current.serverSessionId)}/activity`,
            z.object({ accepted: z.literal(true) }), { method: "POST", body: {}, signal: radio.controllerRef.current?.signal }).catch(() => {});
        }
        if (current) void radio.persist({ ...current, draft }).catch(() => {});
      },
      onSend: () => void radio.sendMessage(), onCancel: () => void radio.cancelRun(),
      onRetry: message => void radio.sendMessage(message), onTrack: (id, track) => void radio.playRecommendation(id, track),
      onRead: message => void radio.readMessage(message),
    }}
    speaking={radio.speechStatus === "playing"}
    settings={{
      online: radio.online, connecting: radio.connection === "connecting",
      connectionLabel: labels[radio.connection], backend: radio.backend, onBackend: radio.setBackend,
      onConnect: () => void radio.connect(), onDisconnect: radio.disconnect, model: radio.model, modelReady: radio.modelReady,
      capabilities: radio.capabilities, settings: radio.settings, settingsBusy: radio.settingsBusy,
      onSetting: key => void radio.changeSettings(key), onServicesChanged: () => void radio.refreshServices(), trace,
    }}
    notices={[...radio.serviceIssues.map(issue => issue.message), ...(radio.notice ? [radio.notice] : [])]}
    onDismiss={notice => { if (notice === radio.notice) radio.setNotice(""); }}
  >
    <audio ref={radio.registerMusicA} {...radio.musicHandlers} />
    <audio ref={radio.registerMusicB} {...radio.musicHandlers} />
    <audio ref={radio.speechRef} onPlaying={() => {
      radio.speechActiveRef.current = true;
      radio.setSpeechStatus("playing");
      if (radio.speechIdRef.current) radio.reportSpeech(radio.speechIdRef.current, "playing");
      if (radio.audioRef.current) radio.audioRef.current.volume = radio.volumeRef.current * .22;
    }} onEnded={() => radio.stopSpeech("ended")} onError={() => radio.stopSpeech("failed")} />
  </RadioExperience>;
}
