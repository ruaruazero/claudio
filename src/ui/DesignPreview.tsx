import { useEffect, useRef, useState } from "react";
import { RadioExperience } from "./RadioExperience";
import type { Message, Radio, Settings, Track } from "../protocol";

const songs: Track[] = [
  { id: "always", title: "Always", artist: "Daniel Caesar", album: "NEVER ENOUGH", durationMs: 205000,
    artworkUrl: "https://p4.music.126.net/u_x0J_eDNnStgCfYb6O5gQ==/109951168528499207.jpg" },
  { id: "japanese-denim", title: "Japanese Denim", artist: "Daniel Caesar", durationMs: 270000,
    artworkUrl: "https://p3.music.126.net/GDYaTd5dE4EUmTA8kFAwSQ==/109951170525261562.jpg" },
  { id: "best-part", title: "Best Part", artist: "Daniel Caesar · H.E.R.", durationMs: 209000,
    artworkUrl: "https://p4.music.126.net/miyRHpMgSFmbMYW6Q4oogw==/109951165983559757.jpg" },
  { id: "get-you", title: "Get You", artist: "Daniel Caesar · Kali Uchis", durationMs: 278000,
    artworkUrl: "https://p4.music.126.net/AZ4FGdwkt2NeEqIYkNOd4A==/109951168655346288.jpg" },
  { id: "let-me-cry", title: "Let Me Cry", artist: "Cleo Sol", durationMs: 210000,
    artworkUrl: "https://p4.music.126.net/hDltxE0P5sPPX766AR4ztA==/109951173727599094.jpg" },
  { id: "come-away", title: "Come Away With Me", artist: "Norah Jones", durationMs: 198000,
    artworkUrl: "https://p3.music.126.net/iCwG98ej2o_ByiVqoayCvA==/109951174032836153.jpg" },
];
const initialMessages: Message[] = [
  { id: "preview-1", role: "user", text: "今晚还有一点工作，想听点舒服的。", status: "saved", createdAt: "2026-10-28T15:41:00Z" },
  { id: "preview-2", role: "assistant", text: "还在忙啊。我陪你待一会儿。", status: "complete", source: "model", createdAt: "2026-10-28T15:41:01Z" },
  { id: "preview-3", role: "user", text: "Daniel Caesar 的歌我很喜欢。", status: "saved", createdAt: "2026-10-28T15:42:00Z" },
  { id: "preview-4", role: "assistant", text: "我也喜欢他唱到一半，像突然有点不好意思的感觉。", tracks: [songs[2]], status: "complete", source: "model", createdAt: "2026-10-28T15:42:01Z" },
];
export function DesignPreview() {
  const [radio, setRadio] = useState<Radio>({ current: songs[0], queue: songs.slice(1), queueVersion: 0, playbackVersion: 0 });
  const [playing, setPlaying] = useState(true);
  const [liked, setLiked] = useState(false);
  const [volume, setVolume] = useState(.65);
  const [position, setPosition] = useState(102);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(initialMessages);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>({ autoSpeech: true, proactive: true, allowPreview: false });
  const [notice, setNotice] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <RadioExperience preview speaking={Boolean(readingId)} tracks={radio.queue}
    player={{
      current: radio.current, playing, loading: false, nextPending: false, nextDisabled: !radio.queue.length,
      liked, canLike: true, position, duration: (radio.current?.durationMs || 0) / 1000,
      volume, canSeek: true, notice: "", onLike: () => setLiked(!liked), onVolume: setVolume,
      onSeek: setPosition, onPlayPause: () => setPlaying(!playing),
      onNext: () => {
        setRadio({ ...radio, current: radio.queue[0], queue: radio.queue.slice(1) });
        setPosition(0); setPlaying(true); setLiked(false);
      },
    }}
    conversation={{
      messages, draft, ready: true, canSend: true, busy: false, cancelling: false, online: true,
      canSpeak: true, readingId, cardPending: null, onDraft: setDraft, onCancel: () => {}, onRetry: () => {},
      onSend: () => {
        if (!draft.trim()) return;
        setMessages([...messages, { id: crypto.randomUUID(), role: "user", text: draft.trim(), status: "saved", createdAt: new Date().toISOString() }]);
        setDraft(""); setNotice("这是设计预览。实际聊天和音乐播放请在主页面体验。");
      },
      onTrack: (_, track) => { setRadio({ ...radio, current: track }); setPosition(0); setPlaying(true); },
      onRead: message => {
        clearTimeout(timer.current);
        setReadingId(readingId === message.id ? null : message.id);
        timer.current = setTimeout(() => setReadingId(null), 5000);
      },
    }}
    settings={{
      online: true, connecting: false, connectionLabel: "设计预览", backend: "/agent-api",
      onBackend: () => {}, onConnect: () => setNotice("当前是设计预览，没有连接真实服务。"), onDisconnect: () => {},
      model: "deepseek-flash", modelReady: true, capabilities: { autoSpeech: true, proactive: true },
      settings, settingsBusy: false, onSetting: key => setSettings({ ...settings, [key]: !settings[key] }),
    }}
    notices={notice ? [notice] : []} onDismiss={() => setNotice("")}
  />;
}
