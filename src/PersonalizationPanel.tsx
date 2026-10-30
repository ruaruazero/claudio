import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, LogOut, QrCode, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { z } from "zod";
import { request } from "./api";

const memorySchema = z.object({
  id: z.string(), text: z.string(), kind: z.string(), scope: z.string(),
  certainty: z.string(), source: z.string(), expiresAt: z.string().nullable(),
});
const locationSchema = z.object({ name: z.string(), latitude: z.number(), longitude: z.number(), timezone: z.string() });
const profileSchema = z.object({ connected: z.boolean(), profile: z.object({ userId: z.number(), nickname: z.string() }).nullable() });
const personalSchema = z.object({
  memories: z.array(memorySchema), location: locationSchema.nullable(), timezone: z.string(), accountAvailable: z.boolean(),
  profile: z.array(z.object({ id: z.string(), dimension: z.string(), value: z.string(), scope: z.string(),
    confidence: z.number(), evidenceCount: z.number(), source: z.string(), certainty: z.string(), text: z.string(),
    entities: z.array(z.string()) })).default([]),
});
type Memory = z.infer<typeof memorySchema>;
type Location = z.infer<typeof locationSchema>;
const scopeLabels: Record<string, string> = {
  general: "日常", work: "工作", "imported playlist": "导入歌单", "imported history": "导入记录",
  rest: "休息", sleep: "睡前", exercise: "运动",
};
const dimensionLabels: Record<string, string> = { artist: "常听的艺人", track: "喜欢的歌曲", genre: "音乐风格",
  language: "语言", instrument: "乐器", vocal: "人声", energy: "听感偏好" };

export function PersonalizationPanel({ backend, active, online, section = "all" }: {
  backend: string; active: boolean; online: boolean; section?: "all" | "memory" | "weather" | "music" | "import";
}) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [tags, setTags] = useState<z.infer<typeof personalSchema>["profile"]>([]);
  const [location, setLocation] = useState<Location | null>(null);
  const [city, setCity] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [accountAvailable, setAccountAvailable] = useState(false);
  const [account, setAccount] = useState<z.infer<typeof profileSchema> | null>(null);
  const [qr, setQr] = useState<{ key: string; image: string; expiresAt: string } | null>(null);
  const [qrStatus, setQrStatus] = useState("");
  const [playlist, setPlaylist] = useState("");
  const [playlists, setPlaylists] = useState<{ id: number; name: string }[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const desktopLogin = typeof window !== "undefined" && window.claudioDesktop && backend === "/agent-api"
    ? window.claudioDesktop.loginMusic : undefined;
  async function refresh() {
    const data = await request(backend, "/personalization", personalSchema);
    setMemories(data.memories); setTags(data.profile); setLocation(data.location); setAccountAvailable(data.accountAvailable);
  }
  async function run(name: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setError(""); setNotice("");
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : "操作未完成，请重试。"); }
    finally { setBusy(""); }
  }
  useEffect(() => {
    if (!active || !online) return;
    let live = true;
    void request(backend, "/personalization", personalSchema).then((data) => {
      if (!live) return;
      setMemories(data.memories); setTags(data.profile); setLocation(data.location); setAccountAvailable(data.accountAvailable);
      if (data.accountAvailable) void request(backend, "/music/account", profileSchema)
        .then((account) => { if (live) setAccount(account); })
        .catch(() => { if (live) setError("网易登录状态暂时无法确认，可以重试。"); });
    }).catch(() => { if (live) setError("设置暂时无法读取，请检查本地服务。"); });
    return () => { live = false; };
  }, [active, online, backend]);
  useEffect(() => {
    if (!active || !online || (section !== "all" && section !== "memory")) return;
    let live = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void request(backend, "/personalization", personalSchema).then(data => {
        if (live) { setMemories(data.memories); setTags(data.profile); }
      }).catch(() => {}).finally(() => { pending = false; });
    }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [active, online, backend, section]);
  useEffect(() => {
    if (!active || !online || !qr) return;
    let live = true;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      if (Date.parse(qr.expiresAt) <= Date.now()) { setQr(null); setQrStatus("二维码已过期，请重新生成。"); return; }
      checking = true;
      void request(backend, "/music/login/check", z.object({ status: z.string(),
        connected: z.boolean().optional(), profile: profileSchema.shape.profile.optional() }),
      { method: "POST", body: { key: qr.key } }).then((result) => {
        if (!live) return;
        if (result.status === "connected" && result.connected) {
          setAccount({ connected: true, profile: result.profile ?? null }); setQr(null); setQrStatus("已登录");
        } else if (result.status === "expired") { setQr(null); setQrStatus("二维码已过期，请重新生成。"); }
        else setQrStatus(result.status === "scanned" ? "已扫码，请在网易云音乐确认登录。" : "等待扫码");
      }).catch(() => {
        if (live) { setQr(null); setQrStatus("登录请求中断，请重新生成二维码。"); }
      }).finally(() => { checking = false; });
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [qr, active, online, backend]);
  if (!active) return null;
  return <div className="personalization-panel">
    {error && <p role="alert" className="personal-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!online && <p role="status">连接本地服务后可编辑。</p>}
    {(section === "all" || section === "memory") && <fieldset disabled={!online || Boolean(busy)}>
      <legend>Claudio 对你的认识</legend>
      <button type="button" className="icon-button" title="刷新记忆" aria-label="刷新记忆"
        onClick={() => void run("memory", refresh)}><RefreshCw size={15} /></button>
      {!tags.length && <p className="muted">还在慢慢认识你的音乐喜好</p>}
      {Object.entries(dimensionLabels).map(([dimension, label]) => {
        const group = tags.filter(tag => tag.dimension === dimension);
        return group.length ? <div className="profile-group" key={dimension}>
          <h4>{label}</h4>
          <ul className="profile-tags">{group.map(tag => <li key={tag.id}>
            <span className="profile-tag" title={`${tag.source === "playlist" ? "来自导入记录" : tag.certainty === "explicit" ? "来自你的明确表达" : "根据交流推测"} · ${tag.evidenceCount} 条依据`}>
              <span>{tag.dimension === "track" ? tag.text.replace(/^喜欢/, "") : tag.value}
                {tag.scope !== "general" && <small> · {scopeLabels[tag.scope] ?? tag.scope}</small>}
                {tag.certainty !== "explicit" && <small> · {tag.source === "playlist" ? "初始线索" : "逐步了解中"}</small>}</span>
              <button type="button" className="icon-button" title={`忘记${tag.value}`} aria-label={`忘记${tag.value}`}
                onClick={() => void run("forget", async () => {
                  await request(backend, `/memories/${tag.id}/forget`, z.object({ accepted: z.boolean() }), { method: "POST", body: {} });
                  await refresh(); setNotice("已忘记这条偏好。");
                })}><Trash2 size={12} /></button>
            </span>
          </li>)}</ul>
        </div> : null;
      })}
      {memories.some(memory => memory.kind !== "preference") && <div className="profile-group">
        <h4>记得的事</h4>
        <ul className="memory-list">{memories.filter(memory => memory.kind !== "preference").map(memory => <li key={memory.id}>
          <p>{memory.text}</p>
          <small>{memory.kind === "context" ? "当下情境" : memory.kind === "rhythm" ? "近期节奏 · 推测" : "长期记忆"}</small>
          <button type="button" className="icon-button" title="忘记这件事" aria-label="忘记这件事"
            onClick={() => void run("forget", async () => {
              await request(backend, `/memories/${memory.id}/forget`, z.object({ accepted: z.boolean() }), { method: "POST", body: {} });
              await refresh(); setNotice("已忘记这件事。");
            })}><Trash2 size={13} /></button>
        </li>)}</ul>
      </div>}
    </fieldset>}
    {(section === "all" || section === "weather") && <fieldset disabled={!online || Boolean(busy)}>
      <legend>天气位置</legend>
      <p>{location?.name ?? "尚未设置城市"}</p>
      <div className="personal-row">
        <input aria-label="天气城市" placeholder="城市名称" value={city} maxLength={80} onChange={(event) => setCity(event.target.value)} />
        <button type="button" className="icon-button" aria-label="搜索城市" title="搜索城市" disabled={city.trim().length < 2}
          onClick={() => void run("city", async () => {
            const results = await request(backend, `/locations?city=${encodeURIComponent(city.trim())}`, z.array(locationSchema));
            setLocations(results); if (!results.length) setNotice("未找到城市，请换一个名称。");
          })}><Search size={16} /></button>
        {location && <button type="button" className="icon-button" title="清除天气位置" aria-label="清除天气位置"
          onClick={() => void run("location", async () => {
            await request(backend, "/location", z.object({ accepted: z.boolean() }), { method: "PATCH", body: null });
            setLocation(null); setLocations([]);
          })}><Trash2 size={15} /></button>}
      </div>
      {locations.length > 0 && <select aria-label="选择天气城市" value="" onChange={(event) => {
        const selected = locations[Number(event.target.value)];
        if (selected) void run("location", async () => {
          await request(backend, "/location", z.object({ accepted: z.boolean() }), { method: "PATCH", body: selected });
          setLocation(selected); setLocations([]); setNotice("天气城市已保存。");
        });
      }}><option value="" disabled>选择城市</option>{locations.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select>}
    </fieldset>}
    {(section === "all" || section === "music" || section === "import") && !accountAvailable && online && <p className="muted">当前音乐源不支持网易登录或导入，请确认本地服务已启用网易音乐源。</p>}
    {(section === "all" || section === "music" || section === "import") && accountAvailable && <fieldset disabled={!online || Boolean(busy)}>
      <legend>网易云音乐</legend>
      <div className="personal-row"><span>{account?.connected ? `已登录 · ${account.profile?.nickname ?? ""}` : "未登录"}</span>
        <button type="button" className="icon-button" aria-label="检查网易登录状态" title="检查网易登录状态"
          onClick={() => void run("account", async () => setAccount(await request(backend, "/music/account", profileSchema)))}>
          <RefreshCw size={15} /></button>
        {account?.connected ? <button type="button" className="icon-button" aria-label="退出网易登录" title="退出网易登录"
          onClick={() => void run("logout", async () => {
            setAccount(await request(backend, "/music/logout", profileSchema, { method: "POST", body: {} }));
            setQr(null); setPlaylists([]);
          })}><LogOut size={15} /></button> :
          <>{desktopLogin && <button type="button" className="button button-primary" onClick={() => void run("official-login", async () => {
            setQr(null); setQrStatus("");
            const result = await desktopLogin();
            if (result.status === "connected") {
              setAccount({ connected: true, profile: result.profile }); setNotice("网易云音乐已登录。");
            } else if (result.status === "error") setError(result.message);
            else setNotice("已取消登录。");
          })}><ExternalLink size={16} />在网易官方页面登录</button>}
          <button type="button" className="button" onClick={() => void run("qr", async () => {
            setQr(await request(backend, "/music/login/qr", z.object({ key: z.string(), image: z.string(), expiresAt: z.string() }),
              { method: "POST", body: {} })); setQrStatus("等待扫码");
          })}><QrCode size={16} />扫码登录</button></>}
      </div>
      {desktopLogin && !account?.connected && <p className="muted">扫码被拦截时，可在网易官方页面完成登录；登录成功后此处会自动更新。</p>}
      {qr && <img className="login-qr" src={qr.image} alt="网易云音乐登录二维码" />}
      {qrStatus && <p role="status">{qrStatus}</p>}
      {section !== "music" && <><div className="personal-row">
        <input aria-label="网易歌单链接或 ID" placeholder="歌单链接或 ID" value={playlist} maxLength={500}
          onChange={(event) => setPlaylist(event.target.value)} />
        <button type="button" className="icon-button" title="导入歌单" aria-label="导入歌单" disabled={!playlist.trim()}
          onClick={() => void run("import", async () => {
            const result = await request(backend, "/music/import/playlist", z.object({ name: z.string(), imported: z.number(), partial: z.boolean() }),
              { method: "POST", body: { value: playlist.trim() }, timeoutMs: 15000 });
            await refresh(); setNotice(`已导入《${result.name}》${result.imported} 首${result.partial ? "（部分曲目）" : ""}。`);
          })}><Upload size={16} /></button>
      </div>
      {account?.connected && <>
        <div className="personal-row">
          <button type="button" className="button" onClick={() => void run("playlists", async () =>
            setPlaylists(await request(backend, "/music/playlists", z.array(z.object({ id: z.number(), name: z.string() })))))}>我的歌单</button>
          <button type="button" className="button" onClick={() => void run("history", async () => {
            const result = await request(backend, "/music/import/history", z.object({ imported: z.number() }),
              { method: "POST", body: {}, timeoutMs: 15000 });
            await refresh(); setNotice(`已导入近一周听歌记录 ${result.imported} 首。`);
          })}><Upload size={14} />导入听歌记录</button>
        </div>
        {playlists.length > 0 && <select aria-label="我的网易歌单" value="" onChange={(event) => setPlaylist(event.target.value)}>
          <option value="" disabled>选择歌单</option>{playlists.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>}
      </>}</>}
    </fieldset>}
    {busy && <p role="status"><LoaderCircle size={14} className="spin" /> 正在处理</p>}
  </div>;
}
