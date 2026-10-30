import { useEffect, useRef, useState } from "react";
import { AudioLines, CloudRain, Flame, LoaderCircle, Waves, X } from "lucide-react";
import { audioEngine, type NoiseKind } from "../audio-engine";
import { IconButton, Switch } from "./primitives";

function load() {
  try {
    const value = JSON.parse(localStorage.getItem("claudio-ambient") || "{}");
    return { kind: (["rain", "ocean", "fire"].includes(value.kind) ? value.kind : "rain") as NoiseKind,
      volume: typeof value.volume === "number" && Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : .25 };
  } catch { return { kind: "rain" as const, volume: .25 }; }
}
export function AmbientSound({ speaking, onActive }: { speaking: boolean; onActive: (active: boolean) => void }) {
  const [preferences, setPreferences] = useState(load);
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem("claudio-ambient", JSON.stringify(preferences)); } catch { /* Sound works without storage. */ }
    audioEngine.noiseVolume(preferences.volume, speaking);
  }, [preferences, speaking, busy]);
  useEffect(() => {
    onActive(enabled);
    return () => onActive(false);
  }, [enabled, onActive]);
  useEffect(() => () => { generation.current++; audioEngine.stopNoise(); }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  async function play(kind = preferences.kind) {
    const current = ++generation.current;
    setBusy(true); setEnabled(true); setError("");
    try { await audioEngine.startNoise(kind, preferences.volume, speaking); }
    catch {
      if (current === generation.current) {
        audioEngine.stopNoise(); setEnabled(false); setError("环境声未能加载，请重试。");
      }
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <div className="ambient-control" ref={panel}>
    <button type="button" className={`ambient-trigger ${enabled ? "is-active" : ""}`} aria-expanded={open} aria-controls="ambient-panel"
      title="自然环境声" aria-label="自然环境声" onClick={() => setOpen(!open)}>{busy ? <LoaderCircle size={14} className="spin" /> : <AudioLines size={14} />}
      <span>环境声</span>{enabled && <i />}</button>
    {open && <section id="ambient-panel" className="ambient-panel" aria-label="自然环境声设置">
      <header><span>自然环境声</span><IconButton label="关闭环境声设置" onClick={() => setOpen(false)}><X size={15} /></IconButton></header>
      <Switch label={busy ? "正在加载" : "播放环境声"} checked={enabled} onChange={() => {
        if (enabled) { generation.current++; audioEngine.stopNoise(); setEnabled(false); setBusy(false); } else void play();
      }} />
      <div className="segmented-control" role="group" aria-label="背景声类型">
        {([["rain", "雨声", CloudRain], ["ocean", "海浪", Waves], ["fire", "炉火", Flame]] as const).map(([kind, label, Icon]) =>
          <button key={kind} type="button" aria-pressed={preferences.kind === kind} onClick={() => {
            setPreferences({ ...preferences, kind }); if (enabled) void play(kind);
          }}><Icon size={16} />{label}</button>)}
      </div>
      <label className="ambient-volume"><span>音量</span><input type="range" aria-label="环境声音量" min="0" max="1" step=".01"
        value={preferences.volume} onChange={event => setPreferences({ ...preferences, volume: Number(event.target.value) })} />
        <small>{Math.round(preferences.volume * 100)}%</small></label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <a className="ambient-credit" href="/ambient/CREDITS.txt" target="_blank" rel="noreferrer">声音来源与署名</a>
    </section>}
  </div>;
}
