import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { z } from "zod";
import { request } from "../api";
import { IconButton } from "./primitives";

const item = z.object({ provider: z.string(), model: z.string(), configured: z.boolean() });
const schema = z.object({ model: item, speech: item });
const errors: Record<string, string> = {
  CONFIG_BUSY: "正在处理请求或验证，请稍后重试。",
  MODEL_AUTH_FAILED: "API Key 无效或已失效，请检查后重试。",
  MODEL_BALANCE: "DeepSeek 账户余额不足，请充值后重新验证。",
  MODEL_PERMISSION_DENIED: "账户没有访问权限，请检查供应商控制台。",
  MODEL_NOT_FOUND: "模型名称不可用，请检查模型名称。",
  MODEL_CONFIGURATION: "请先填写并保存 API Key。",
  MODEL_RATE_LIMITED: "供应商请求过于频繁，请稍后验证。",
  TTS_AUTH_FAILED: "MiMo API Key 无效或已失效。",
  TTS_BALANCE: "MiMo 账户余额不足，请充值后重新验证。",
  TTS_NOT_CONFIGURED: "请先填写并保存 MiMo API Key。",
  TTS_CONFIGURATION: "语音模型名称或接口不可用，请检查配置。",
  SERVICE_CONFIG_UNAVAILABLE: "本地服务尚未启用页面配置，请更新并重启服务。",
  INVALID_INPUT: "请检查模型名称和 API Key 格式。",
};
export function ServiceSettings({ backend, online, preview, onRefresh }: {
  backend: string; online: boolean; preview?: boolean; onRefresh: () => void;
}) {
  const [service, setService] = useState<"model" | "speech">("model");
  const [data, setData] = useState<z.infer<typeof schema> | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (online && !preview) void request(backend, "/services", schema, { signal: controller.signal }).then(value => {
      setData(value); setModel(value.model.model);
    }).catch(error => { if (!controller.signal.aborted) setError(errors[error.message] || "配置读取失败，请检查本地服务。"); });
    else if (preview) {
      setData({ model: { provider: "DeepSeek", model: "deepseek-flash", configured: false },
        speech: { provider: "小米 MiMo", model: "mimo-v2.5-tts", configured: false } });
      setModel("deepseek-flash");
    }
    return () => { mounted.current = false; controller.abort(); };
  }, [backend, online, preview]);
  async function action(kind: "save" | "verify" | "clear") {
    if (busy || !data) return;
    if (preview) { setNotice("设计预览不保存密钥，请在实际使用页面配置。"); return; }
    if (kind === "clear" && !window.confirm("移除此服务的 API Key？其他服务和音乐播放不受影响。")) return;
    setBusy(kind); setError(""); setNotice("");
    try {
      if (kind === "verify") {
        await request(backend, "/services/verify", z.object({ verified: z.literal(true) }), {
          method: "POST", body: { service }, timeoutMs: 35000,
        });
        if (mounted.current) setNotice("验证通过，供应商已成功响应。" );
      } else {
        const result = await request(backend, "/services", schema, { method: "PATCH",
          body: { service, model: model.trim(), ...(kind === "clear" ? { clearKey: true } : key.trim() ? { apiKey: key.trim() } : {}) }, timeoutMs: 35000 });
        if (mounted.current) {
          setData(result); setKey(""); setVisible(false);
          setNotice(kind === "clear" ? "已移除密钥。" : "已保存并生效。可点击验证确认供应商是否可用。");
          onRefresh();
        }
      }
    } catch (error) {
      if (mounted.current) setError(errors[error instanceof Error ? error.message : ""] || "请求未完成，可能是网络或供应商超时。配置状态请重新打开确认，不要连续重试。");
    } finally { if (mounted.current) setBusy(""); }
  }
  const current = data?.[service];
  const dirty = Boolean(key.trim()) || model.trim() !== current?.model;
  return <form className="services-form" onSubmit={event => { event.preventDefault(); void action("save"); }}>
    <div className="segmented-control service-tabs" role="tablist" aria-label="服务类型">
      {([ ["model", "对话模型"], ["speech", "语音播报"] ] as const).map(([value, label]) =>
        <button key={value} type="button" role="tab" disabled={Boolean(busy)} aria-selected={service === value} onClick={() => {
          setService(value); setKey(""); setModel(data?.[value].model || ""); setVisible(false); setNotice(""); setError("");
        }}>{label}</button>)}
    </div>
    <label className="field-label" htmlFor="service-provider">服务商</label>
    <input id="service-provider" value={service === "model" ? "DeepSeek" : "小米 MiMo"} readOnly />
    <label className="field-label" htmlFor="service-model">模型</label>
    <input id="service-model" value={model} maxLength={100} required spellCheck={false} disabled={!data || Boolean(busy)}
      onChange={event => setModel(event.target.value)} />
    <label className="field-label" htmlFor="service-key">API Key</label>
    <div className="secret-input">
      <input id="service-key" type={visible ? "text" : "password"} value={key} maxLength={512}
        autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={!data || Boolean(busy)}
        placeholder={current?.configured ? "已配置，留空保留原密钥" : "粘贴 API Key"} onChange={event => setKey(event.target.value)} />
      <IconButton label={visible ? "隐藏密钥" : "显示密钥"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</IconButton>
    </div>
    <p className="field-help">密钥仅提交到本机服务并加密存储，不写入浏览器存储或聊天记录。验证会发起一次简短模型调用或语音合成，可能产生少量费用。</p>
    <p className="connection-detail" role="status">{current?.configured ? "已配置" : "尚未配置"}{preview ? " · 设计预览" : ""}</p>
    <div className="service-actions">
      <button type="submit" className="button button-primary" disabled={!online || !data || Boolean(busy) || !model.trim() || !dirty || (!current?.configured && !key.trim())}>
        {busy === "save" && <LoaderCircle size={14} className="spin" />}保存并生效</button>
      <button type="button" className="button" disabled={!online || !current?.configured || Boolean(busy) || dirty} onClick={() => void action("verify")}>
        {busy === "verify" && <LoaderCircle size={14} className="spin" />}验证服务</button>
      {current?.configured && <button type="button" className="text-button" disabled={Boolean(busy) || !online} onClick={() => void action("clear")}>移除密钥</button>}
    </div>
    {notice && <p className="field-help" role="status">{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}
