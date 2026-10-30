import { Fault, type State } from "./store.js";
import type { ServiceIssue } from "../src/protocol.js";

const modelIssues: Record<string, string> = {
  MODEL_BALANCE: "AI 供应商账户余额不足，Claudio 暂时无法回复、选歌或主动串场。请到模型供应商控制台充值，确认后再发送消息；已在播放的音乐不会因此被主动停止。",
  MODEL_AUTH_FAILED: "AI 服务认证失败，Claudio 暂时无法回应。请在设置 → 模型与语音服务中更新 API Key 并验证；不要将 Key 填入聊天。",
  MODEL_PERMISSION_DENIED: "AI 服务拒绝访问。请在供应商控制台检查账户状态、模型权限和访问限制，处理后再发送消息；这不一定是 Key 错误。",
  MODEL_NOT_FOUND: "找不到配置的 AI 模型或接口。请在设置 → 模型与语音服务中检查模型名称；自定义接口地址仍由本地服务配置管理。",
  MODEL_CONFIGURATION: "AI 服务配置不可用。请检查后端 API Key、模型名称和接口地址，处理后再发送消息。",
  MODEL_PROTOCOL_ERROR: "AI 供应商拒绝了请求参数。请检查模型兼容性及后端请求配置；重复发送同一请求通常无法解决。",
  MODEL_TLS_FAILED: "无法安全连接 AI 服务。请检查系统时间、代理或证书配置，不要关闭证书校验。",
};
const speechIssues: Record<string, string> = {
  TTS_BALANCE: "MiMo 语音账户余额不足，暂时无法播报。请到 MiMo 控制台充值，下一条回复会再次尝试；文字聊天和音乐仍可使用。",
  TTS_AUTH_FAILED: "MiMo 语音认证失败，暂时无法播报。请在设置 → 模型与语音服务 → 语音播报中更新 API Key 并验证；文字聊天和音乐仍可使用。",
  TTS_PERMISSION_DENIED: "MiMo 拒绝语音服务访问。请检查账户状态和语音模型权限；文字聊天和音乐仍可使用。",
  TTS_CONFIGURATION: "MiMo 语音模型或接口配置不可用。请检查后端语音模型名称和接口配置；文字聊天和音乐仍可使用。",
};
export function serviceIssue(service: ServiceIssue["service"], code: string): ServiceIssue | null {
  const message = (service === "model" ? modelIssues : speechIssues)[code];
  return message ? { service, code, message, at: new Date().toISOString() } : null;
}

export type Incident = {
  level: "recovered" | "degraded" | "action_required" | "protected";
  visibility: "silent" | "inline" | "banner" | "blocking";
  recovery: "none" | "reconnect" | "play" | "retry" | "configure" | "verify";
  message: string;
};

export function classifyFailure(error: unknown) {
  // SDK middleware wraps errors. Only read structured fields, never publish raw messages.
  let cause = error;
  const chain: Error[] = [];
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    chain.push(cause);
    cause = cause.cause;
  }
  const fault = chain.find((item): item is Fault => item instanceof Fault);
  if (fault) return fault.code;
  const status = chain.map((item) => (item as Error & { status?: number }).status)
    .find((value) => typeof value === "number");
  if (status === 401) return "MODEL_AUTH_FAILED";
  if (status === 403) return "MODEL_PERMISSION_DENIED";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 402) return "MODEL_BALANCE";
  if (status === 429) return "MODEL_RATE_LIMITED";
  if (status === 400 || status === 422) return "MODEL_PROTOCOL_ERROR";
  if (status && status >= 500) return "MODEL_UNAVAILABLE";
  if (chain.some((item) => item.name === "ModelCallLimitMiddlewareError")) return "MODEL_CALL_LIMIT";
  if (chain.some((item) => ["TimeoutError", "AbortError", "APIConnectionTimeoutError"].includes(item.name))) {
    return "RUN_TIMEOUT";
  }
  return "MODEL_CALL_FAILED";
}

function operationOutcome(state: State, requestId: string, code: string): {
  committed: boolean; text: string; incident: Incident;
} {
  const actions = state.runs.find((run) => run.requestId === requestId)?.actions ?? [];
  const last = actions.at(-1);
  if (!last && state.messages.some((m) => m.role === "assistant" && m.source === "model" && m.requestId === requestId)) {
    const text = "已发出的回复已保留，后续内容暂时未能生成。";
    return { committed: true, text,
      incident: { level: "degraded", visibility: "inline", recovery: "retry", message: text } };
  }
  const configuration = ["MODEL_CONFIGURATION", "MODEL_BALANCE", "MODEL_PROTOCOL_ERROR"].includes(code);
  const generic = configuration ? "当前 AI 服务配置需要处理，暂时无法完成这次请求。" :
    code === "MODEL_OUTPUT_PROTOCOL_ERROR" ? "这次 AI 回复格式异常，未能正常显示。" :
    ["CONTEXT_SUMMARY_INVALID", "CONTEXT_SUMMARY_UNAVAILABLE"].includes(code)
      ? "对话整理暂时失败，这次请求未完成，请重试；历史对话已保留，音乐可继续播放。" :
    code === "CONTEXT_INPUT_TOO_LARGE" ? "这次输入超过可处理范围，请缩短本次内容；历史对话仍已保存。" :
    code === "CONTEXT_CHANGED" ? "记忆刚刚发生变化，这次处理已停止，请重新发送。" :
    code === "MODEL_RATE_LIMITED" ? "AI 服务暂时繁忙，这次请求没有处理完。" :
    code === "RUN_TIMEOUT" ? "这次处理超时了。" :
      ["MODEL_CONNECT_TIMEOUT", "MODEL_REQUEST_TIMEOUT", "MODEL_RESPONSE_TIMEOUT",
        "MODEL_RESPONSE_INTERRUPTED", "MODEL_CONNECTION_RESET", "MODEL_CONNECTION_REFUSED",
        "MODEL_NETWORK_UNAVAILABLE", "MODEL_DNS_FAILED"]
        .includes(code) ? "这次没能收到 AI 服务的完整回复，请稍后再试。" :
      code === "MODEL_TLS_FAILED" ? "暂时无法安全连接 AI 服务，请检查服务连接配置。" :
      code === "MODEL_UNAVAILABLE" ? "AI 服务暂时不可用，请稍后再试。" : "这次请求没有处理完。";
  if (!last) return {
    committed: false, text: `${generic}没有提交新的队列或播放操作。`,
    incident: { level: "action_required", visibility: "inline",
      recovery: configuration ? "configure" : "retry", message: generic },
  };
  const base: Incident = { level: "degraded", visibility: "inline", recovery: "none",
    message: "操作结果已保留，使用系统说明代替 AI 回复。" };
  // A previous successful observation is not proof that the same audio is still current.
  if (state.radio.playbackVersion !== last.playbackVersion ||
    state.radio.queueVersion !== last.queueVersion ||
    (last.commandId && state.command?.commandId !== last.commandId)) {
    return { committed: true, text: "此前的操作已提交，之后播放状态有了新变化。请以当前播放器为准。",
      incident: { ...base, recovery: "verify" } };
  }
  if (!last.commandId) return { committed: true,
    text: "队列已更新；这次没有立即切换播放。", incident: base };
  const ack = state.playbackAck?.commandId === last.commandId ? state.playbackAck : null;
  if (ack?.status === "playing") return { committed: true,
    text: `播放器已确认开始播放${last.trackTitle ? `《${last.trackTitle}》` : ""}。`, incident: base };
  if (ack?.status === "paused") return { committed: true,
    text: last.action === "stop" ? "播放器已确认停止播放。" : "播放器已确认暂停。", incident: base };
  if (ack?.status === "ended") return { committed: true,
    text: "播放器已确认这首歌播放结束。", incident: base };
  if (ack?.status === "blocked") return { committed: true,
    text: "歌曲已经准备好，浏览器需要你点击播放。",
    incident: { level: "action_required", visibility: "banner", recovery: "play",
      message: "浏览器需要一次点击才能开始播放。" } };
  if (ack?.status === "failed") return { committed: true,
    text: "队列或播放操作已提交，但音频没有成功播放。请查看播放器状态。",
    incident: { level: "action_required", visibility: "inline", recovery: "verify",
      message: "音频没有成功播放，请先核对当前状态。" } };
  return { committed: true, text: ack?.status === "loading" ? "歌曲正在加载。" : "播放操作已提交。",
    incident: base };
}

export function failureOutcome(state: State, requestId: string, code: string) {
  const result = operationOutcome(state, requestId, code);
  const issue = serviceIssue("model", code);
  if (!issue) return result;
  return {
    committed: result.committed,
    text: result.committed ? `${result.text}\n\n${issue.message}` : `${issue.message}\n这次没有提交新的队列或播放操作。`,
    incident: { level: "action_required" as const, visibility: "banner" as const,
      recovery: "configure" as const, message: issue.message },
  };
}
