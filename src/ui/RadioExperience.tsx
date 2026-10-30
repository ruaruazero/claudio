import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, Settings as SettingsIcon, X } from "lucide-react";
import { Player, type PlayerProps } from "./Player";
import { Signal } from "./Signal";
import { AmbientSound } from "./AmbientSound";
import { Conversation, type ConversationProps } from "./Conversation";
import { InlineQueue, QueueDrawer } from "./Queue";
import { loadProfile, SettingsPanel, type SettingsPanelProps, type Theme } from "./SettingsPanel";
import { ArtworkBackend, IconButton } from "./primitives";
import type { Track } from "../protocol";

function loadTheme(): Theme {
  try {
    const value = localStorage.getItem("claudio-theme");
    return value === "night" || value === "system" ? value : "day";
  } catch { return "day"; }
}
export function RadioExperience(props: {
  player: Omit<PlayerProps, "onQueue" | "queueCount">; tracks: Track[];
  conversation: Omit<ConversationProps, "userName" | "avatar">; settings: SettingsPanelProps;
  notices: string[]; onDismiss: (notice: string) => void; children?: ReactNode; speaking: boolean; preview?: boolean;
}) {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [profile, setProfile] = useState(loadProfile);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [ambientActive, setAmbientActive] = useState(false);
  const dark = theme === "night" || (theme === "system" && systemDark);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "night" : "day";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#191b1f" : "#fafafa");
    try { localStorage.setItem("claudio-theme", theme); } catch { /* Theme remains usable without storage. */ }
  }, [theme, dark]);
  const status = props.speaking ? "SPEAKING" : !props.settings.online ? props.settings.connecting ? "CONNECTING" : "OFFLINE"
    : props.conversation.busy ? "TUNING IN" : props.player.playing ? "ON AIR" : "STANDBY";
  return <ArtworkBackend.Provider value={props.preview ? null : props.settings.backend}>
    <div className="window-drag-region" aria-hidden="true" />
    <div className={`app-shell ${props.preview ? "design-preview" : ""}`}>
    <header className="topbar"><h1>Claudio</h1>
      <IconButton label="设置" onClick={() => setSettingsOpen(true)}><SettingsIcon size={21} strokeWidth={2.4} /></IconButton>
    </header>
    {props.notices.length > 0 && <div className="notices">{props.notices.map(notice => <div className="notice" role="alert" key={notice}>
      <CircleAlert size={15} /><span>{notice}</span>
      <IconButton label="关闭提示" onClick={() => props.onDismiss(notice)}><X size={14} /></IconButton>
    </div>)}</div>}
    <main className="workspace">
      <aside className="radio-column">
        <Signal playing={props.player.playing} speaking={props.speaking} ambient={ambientActive} preview={props.preview} />
        <Player {...props.player} queueCount={props.tracks.length} onQueue={() => setQueueOpen(true)}
          ambient={<AmbientSound speaking={props.speaking} onActive={setAmbientActive} />} />
        <InlineQueue tracks={props.tracks} />
      </aside>
      <section className="conversation" aria-label="和 Claudio 聊聊">
        <header className="chat-heading"><h2><span className="chat-title-wide">和 Claudio 聊聊</span><span className="chat-title-small">Claudio</span></h2>
          <span className={`on-air ${props.speaking ? "is-speaking" : ""} ${!props.settings.online ? "is-offline" : ""}`} role="status">{status}</span>
        </header>
        <Conversation {...props.conversation} userName={profile.name} avatar={profile.avatar} />
      </section>
    </main>
    <QueueDrawer tracks={props.tracks} open={queueOpen} onClose={() => setQueueOpen(false)} />
    <SettingsPanel {...props.settings} open={settingsOpen} onClose={() => setSettingsOpen(false)}
      theme={theme} onTheme={setTheme} profile={profile} onProfile={setProfile} preview={props.preview} />
    {props.children}
  </div></ArtworkBackend.Provider>;
}
