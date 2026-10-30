import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, LoaderCircle, Monitor, Moon, Sun, Upload, X } from "lucide-react";
import type { Settings } from "../protocol";
import { IconButton, Switch } from "./primitives";
import { PersonalizationPanel } from "../PersonalizationPanel";
import { ServiceSettings } from "./ServiceSettings";

export type Theme = "day" | "night" | "system";
type Page = "home" | "profile" | "services" | "local" | "memory" | "weather" | "music" | "import" | "trace";
export type SettingsPanelProps = {
  online: boolean; connecting: boolean; connectionLabel: string; backend: string;
  onBackend: (value: string) => void; onConnect: () => void; onDisconnect: () => void;
  model: string | null; modelReady: boolean; capabilities: { autoSpeech: boolean; proactive: boolean };
  settings: Settings; settingsBusy: boolean; onSetting: (key: keyof Settings) => void;
  trace?: ReactNode; preview?: boolean; onNewSession?: () => void;
  onServicesChanged?: () => void;
};
type Profile = { name: string; avatar: string };
export function loadProfile(): Profile {
  try {
    const saved = JSON.parse(localStorage.getItem("claudio-profile") || "{}");
    return { name: typeof saved.name === "string" ? saved.name.slice(0, 30) : "你",
      avatar: typeof saved.avatar === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(saved.avatar) ? saved.avatar : "" };
  } catch { return { name: "你", avatar: "" }; }
}
const pageNames: Record<Page, string> = {
  home: "设置", profile: "头像与称呼", services: "模型与语音服务", local: "本地服务",
  memory: "我的偏好与记忆", weather: "天气城市", music: "网易云音乐", import: "导入歌单与听歌记录", trace: "运行记录",
};
function Row({ label, value, children, onClick }: {
  label: string; value?: string; children?: ReactNode; onClick: () => void;
}) {
  return <button type="button" className="settings-row" onClick={onClick}>
    {children}<span>{label}</span><small>{value}</small><ChevronRight size={16} />
  </button>;
}
export function SettingsPanel(props: SettingsPanelProps & {
  open: boolean; onClose: () => void; theme: Theme; onTheme: (value: Theme) => void;
  profile: Profile; onProfile: (value: Profile) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<Page>("home");
  const [profile, setProfile] = useState(props.profile);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (props.open && !dialog.current?.open) { setPage("home"); setError(""); dialog.current?.showModal(); }
    if (!props.open && dialog.current?.open) dialog.current.close();
  }, [props.open]);
  useEffect(() => { setProfile(props.profile); }, [props.profile]);
  const navigate = (value: Page) => { setPage(value); setError(""); setSaved(false); };
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("请选择 JPG、PNG 或 WebP 图片。"); return; }
    if (file.size > 8 * 1024 * 1024) { setError("图片不能超过 8 MB。"); return; }
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const size = Math.min(bitmap.width, bitmap.height);
      canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2,
        size, size, 0, 0, 256, 256);
      bitmap.close();
      setProfile(previous => ({ ...previous, avatar: canvas.toDataURL("image/webp", .85) }));
      setSaved(false);
    } catch { setError("图片无法读取，请换一张。"); }
  }
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-heading"
    onClose={props.onClose} onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div className="settings-window-drag-region" aria-hidden="true" />
    <div className="settings-sheet">
      <header className="dialog-heading">
        {page !== "home" && <IconButton label="返回设置" onClick={() => navigate("home")}><ArrowLeft size={18} /></IconButton>}
        <h2 id="settings-heading">{pageNames[page]}</h2>
        <IconButton label="关闭设置" onClick={props.onClose}><X size={20} /></IconButton>
      </header>
      <div className="settings-content">
        {page === "home" && <>
          <Row label="头像与称呼" onClick={() => navigate("profile")}>
            <span className="profile-avatar">{props.profile.avatar ? <img src={props.profile.avatar} alt="" /> : props.profile.name.slice(0, 1)}</span>
          </Row>
          <section className="settings-group appearance"><h3>外观</h3><div className="segmented-control" role="group" aria-label="外观">
            {([["day", "日间", Sun], ["night", "夜间", Moon], ["system", "跟随系统", Monitor]] as const).map(([value, label, Icon]) =>
              <button type="button" key={value} aria-pressed={props.theme === value} onClick={() => props.onTheme(value)}>
                <Icon size={13} />{label}
              </button>)}
          </div></section>
          <section className="settings-group"><h3>声音与陪伴</h3>
            <Switch label="自动播报回复" checked={props.settings.autoSpeech} onChange={() => props.onSetting("autoSpeech")}
              disabled={props.settingsBusy || !props.capabilities.autoSpeech} />
            <Switch label="主动串场" checked={props.settings.proactive} onChange={() => props.onSetting("proactive")}
              disabled={props.settingsBusy || !props.capabilities.proactive} />
            <Switch label="允许播放试听片段" checked={props.settings.allowPreview} onChange={() => props.onSetting("allowPreview")}
              disabled={props.settingsBusy} />
          </section>
          <section className="settings-group"><h3>服务与音乐</h3>
            <Row label="模型与语音服务" value="API Key" onClick={() => navigate("services")} />
            <Row label="网易云音乐" onClick={() => navigate("music")} />
            <Row label="导入歌单与听歌记录" onClick={() => navigate("import")} />
          </section>
          <section className="settings-group"><h3>记忆与环境</h3>
            <Row label="我的偏好与记忆" value="查看" onClick={() => navigate("memory")} />
            <Row label="天气城市" onClick={() => navigate("weather")} />
            <Row label="本地服务" value={props.connectionLabel} onClick={() => navigate("local")} />
          </section>
          <button className="diagnostics-link" type="button" onClick={() => navigate("trace")}>运行记录</button>
        </>}
        {page === "profile" && <form className="profile-form" onSubmit={event => {
          event.preventDefault();
          const next = { ...profile, name: profile.name.trim() || "你" };
          try {
            localStorage.setItem("claudio-profile", JSON.stringify(next));
            props.onProfile(next); setSaved(true); setError("");
          } catch { setError("本机存储未能保存，请检查浏览器存储空间。"); }
        }}>
          <span className="profile-avatar profile-preview">{profile.avatar ? <img src={profile.avatar} alt="头像预览" /> : profile.name.slice(0, 1)}</span>
          <div className="profile-actions"><button type="button" className="button button-primary" onClick={() => fileRef.current?.click()}>
            <Upload size={14} />上传头像</button>
            <button type="button" className="button" onClick={() => { setProfile({ ...profile, avatar: "" }); setSaved(false); }}>移除</button>
          </div>
          <input ref={fileRef} type="file" className="sr-only" accept="image/png,image/jpeg,image/webp"
            aria-label="选择头像图片" onChange={event => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
          <small className="field-help">JPG、PNG 或 WebP</small>
          <label className="field-label" htmlFor="profile-name">称呼</label>
          <input id="profile-name" value={profile.name} maxLength={30} onChange={event => { setProfile({ ...profile, name: event.target.value }); setSaved(false); }} />
          <div className="dialog-actions"><span role="status">{saved ? "已保存" : ""}</span><button className="button button-primary" type="submit">保存</button></div>
        </form>}
        {page === "services" && props.open && <ServiceSettings backend={props.backend} online={props.online}
          preview={props.preview} onRefresh={props.onServicesChanged ?? props.onConnect} />}
        {page === "local" && <form className="local-form" onSubmit={event => { event.preventDefault(); props.onConnect(); }}>
          <label className="field-label" htmlFor="backend">Agent API</label>
          <input id="backend" value={props.backend} required spellCheck={false} autoComplete="off"
            onChange={event => props.onBackend(event.target.value)} />
          <p className="connection-detail" role="status"><i className={props.online ? "online" : ""} />{props.connectionLabel}</p>
          <div className="dialog-actions">
            {props.online && <button type="button" className="button" onClick={props.onDisconnect}>断开连接</button>}
            <button className="button button-primary" disabled={props.connecting}>
              {props.connecting && <LoaderCircle size={14} className="spin" />}连接
            </button>
          </div>
        </form>}
        {(["memory", "weather", "music", "import"] as Page[]).includes(page) && (
          props.preview ? <div className="settings-placeholder">此处将在连接本地服务后显示你的数据。</div> :
            <PersonalizationPanel backend={props.backend} active={props.open} online={props.online}
              section={page === "memory" ? "memory" : page === "weather" ? "weather" : page === "import" ? "import" : "music"} />)}
        {page === "trace" && (props.trace || <p className="settings-placeholder">暂无运行记录</p>)}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
    </div>
  </dialog>;
}
