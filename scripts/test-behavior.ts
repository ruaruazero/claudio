import { config } from "dotenv";
import { ChatDeepSeek } from "@langchain/deepseek";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeApp } from "../server/http.js";
import { MockMusic } from "../server/mock-music.js";
import { createModelFetch } from "../server/model-network.js";

config();
if (!process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_MODEL) {
  throw new Error("Configure DEEPSEEK_API_KEY and DEEPSEEK_MODEL in the local .env first.");
}
const model = new ChatDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL,
  configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com", fetch: createModelFetch() },
  maxRetries: 0, timeout: 25_000, maxTokens: 600, modelKwargs: { thinking: { type: "disabled" } },
});
type Expectation = "chat" | "cards" | "play" | "pause" | "next" | "replace" | "remember";
const cases: { name: string; text: string; expect: Expectation }[] = [
  { name: "随口喜欢不是播放命令", text: "这首我挺喜欢的。", expect: "chat" },
  { name: "情绪分享不是切歌命令", text: "今天写代码写得有点累啊。", expect: "chat" },
  { name: "讨论音乐不改播放", text: "你觉得爵士和蓝调有什么区别？简单聊聊。", expect: "chat" },
  { name: "推荐展示卡片", text: "给我推荐几首晚上干活的歌。", expect: "cards" },
  { name: "明确只推荐不播放", text: "推荐几首动感的测试音乐给我看看，先别播放，也别改队列。", expect: "cards" },
  { name: "只聊天且不返回推荐", text: "不要推荐歌，也不要操作播放。我们聊聊你为什么叫Claudio吧。", expect: "chat" },
  { name: "明确暂停", text: "暂停音乐。", expect: "pause" },
  { name: "明确播放", text: "播放现在这首。", expect: "play" },
  { name: "明确下一首", text: "切到下一首。", expect: "next" },
  { name: "明确换一批", text: "听腻了，换一批动感的测试音乐，立即播放。", expect: "replace" },
  { name: "偏好记忆不影响播放", text: "帮我记住，我工作时喜欢没有人声的钢琴音乐。现在不用换歌。", expect: "remember" },
  { name: "不可用歌曲不擅自替代", text: "放周杰伦的晴天。如果测试曲库里没有就告诉我，不要用其他歌替代。", expect: "chat" },
];
const repeats = Math.min(5, Math.max(1, Number(process.env.CLAUDIO_EVAL_REPEATS) || 2));
const results: Record<string, unknown>[] = [];
async function evaluate(item: typeof cases[number], repeat: number) {
  const music = new MockMusic("http://127.0.0.1:9876");
  const lab = makeApp({ databasePath: ":memory:", music, musicProvider: "mock", model,
    modelName: process.env.DEEPSEEK_MODEL!, ackTimeoutMs: 1000 });
  const pending: Promise<unknown>[] = [];
  const started = Date.now();
  try {
    const tracks = await music.search("安静 high", 6, new AbortController().signal);
    lab.store.create("evaluation");
    lab.store.change("evaluation", (state) => {
      state.settings.proactive = false;
      state.radio.current = tracks[0]; state.radio.queue = tracks.slice(1, 3);
      state.desiredPlayback = item.expect === "play" ? "pause" : "play";
    });
    lab.store.subscribe("evaluation", (event) => {
      if (event.type !== "playback.command") return;
      pending.push(new Promise<void>((resolveAck) => setImmediate(() => {
        void lab.app.inject({ method: "POST", url: "/api/lab/sessions/evaluation/playback/acks", payload: {
          commandId: event.payload.commandId, playbackVersion: event.payload.playbackVersion, ackSequence: 1,
          status: event.payload.action === "play" ? "playing" : "paused",
          trackId: event.payload.track?.id, positionMs: 0,
        } }).then(() => resolveAck());
      })));
    });
    const before = lab.store.read("evaluation");
    lab.agent.submit("evaluation", { requestId: "turn", clientMessageId: "turn", text: item.text });
    await lab.agent.idle();
    await Promise.all(pending);
    const after = lab.store.read("evaluation");
    const events = lab.store.replay("evaluation", 0);
    const tools = events.filter((e) => e.type === "agent.activity" && e.payload.phase === "started")
      .map((e) => e.type === "agent.activity" ? e.payload.tool : "");
    const replies = after.messages.filter((m) => m.role === "assistant");
    const errors: string[] = [];
    const check = (condition: unknown, message: string) => { if (!condition) errors.push(message); };
    check(after.runs[0]?.status === "completed", "Agent run did not complete successfully");
    check(replies.some((m) => m.source === "model"), "No model reply");
    const untouched = () => check(JSON.stringify(before.radio) === JSON.stringify(after.radio), "Unexpected playback/queue mutation");
    switch (item.expect) {
      case "chat": untouched(); check(!replies.some((m) => m.tracks?.length), "Unexpected recommendation cards"); break;
      case "cards":
        untouched();
        check(replies.some((m) => m.tracks?.length), "No recommendation cards");
        check(!tools.some((t) => ["update_music_queue", "control_playback"].includes(t)), "Recommendation invoked a playback write");
        break;
      case "pause": check(after.command?.action === "pause", "Pause not performed"); break;
      case "play": check(after.command?.action === "play", "Play not performed"); break;
      case "next": check(after.radio.current?.id === before.radio.queue[0].id, "Wrong next track"); break;
      case "replace":
        check(after.radio.current?.id !== before.radio.current?.id && after.command?.action === "play", "Replacement did not start");
        check(after.radio.current?.id.startsWith("mock:energy"), "Replacement ignores requested energy");
        break;
      case "remember":
        untouched();
        check(lab.agent.knowledge.list().some((m) => /钢琴/.test(m.text)), "Explicit preference not saved");
        break;
    }
    if (["chat", "remember"].includes(item.expect)) {
      check(!tools.some((t) => ["update_music_queue", "control_playback"].includes(t)), "Discussion invoked playback tools");
    }
    const last = events.findLast((e) => e.type === "run.completed" || e.type === "run.failed" || e.type === "run.partial");
    const payload = last?.payload as { inputTokens?: number; outputTokens?: number } | undefined;
    return { name: item.name, repeat, input: item.text, expected: item.expect, passed: errors.length === 0,
      errors, tools, replies: replies.map((m) => ({ source: m.source, text: m.text, tracks: m.tracks })),
      durationMs: Date.now() - started, inputTokens: payload?.inputTokens, outputTokens: payload?.outputTokens,
      finalRadio: after.radio, runStatus: after.runs[0]?.status };
  } finally { await lab.app.close(); }
}
// Bound concurrency and isolate each case's database, checkpoints, memory and simulated player.
const queue = Array.from({ length: repeats }, (_, repeat) => cases.map((item) => ({ item, repeat: repeat + 1 }))).flat();
await Promise.all(Array.from({ length: 2 }, async () => {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    let result: Record<string, unknown>;
    try { result = await evaluate(next.item, next.repeat); }
    catch { result = { name: next.item.name, repeat: next.repeat, passed: false, errors: ["Test infrastructure failure"] }; }
    results.push(result);
    console.log(JSON.stringify({ name: result.name, repeat: result.repeat, passed: result.passed, errors: result.errors }));
  }
}));
const report = { at: new Date().toISOString(), model: process.env.DEEPSEEK_MODEL,
  boundaries: "Real model; controlled synthetic music and simulated browser ACK; no production user data.",
  total: results.length, passed: results.filter((r) => r.passed).length,
  inputTokens: results.reduce((sum, r) => sum + Number(r.inputTokens || 0), 0),
  outputTokens: results.reduce((sum, r) => sum + Number(r.outputTokens || 0), 0),
  results };
mkdirSync(resolve(".data/test-reports"), { recursive: true });
const file = resolve(".data/test-reports", `behavior-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, total: report.total, report: file,
  inputTokens: report.inputTokens, outputTokens: report.outputTokens }));
if (report.passed !== report.total) process.exitCode = 1;
