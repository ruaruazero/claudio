import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { ChatDeepSeek } from "@langchain/deepseek";
import { RadioAgent } from "../server/agent.js";
import { Store, type State } from "../server/store.js";
import { conversationPersona, seguePersona } from "../server/persona.js";
import { summaryInstruction } from "../server/context.js";

// Offline inspection: the real Agent and SDK build requests; only the provider responses are scripted.
// Never load credentials, call upstream providers, or change the real session database.
const output = resolve(".data/prompt-inspection");
mkdirSync(output, { recursive: true, mode: 0o700 });
const sourceDb = new Database(resolve(".data/agent-lab.sqlite"), { readonly: true });
const query = "推荐点歌吧，现在我要做一些比较重复的工作，比较枯燥";
const states = (sourceDb.prepare("SELECT body FROM lab_sessions").all() as { body: string }[])
  .map(row => JSON.parse(row.body) as State);
const source = states.find(state => state.messages.some(message => message.text === query));
assert.ok(source, "The original recommendation conversation must exist");
const index = source.messages.map((message, index) => message.role === "user" && message.text === query ? index : -1)
  .filter(index => index >= 0).at(-1)!;
// A short-history example makes every section inspectable without generating a synthetic summary.
const history = source.messages.slice(Math.max(0, index - 4), index);
const preferenceRows = sourceDb.prepare("SELECT key,body FROM lab_preferences WHERE key IN ('timezone','trackFeedback','memoryRevision')").all() as { key: string; body: string }[];
const memoryRows = sourceDb.prepare("SELECT id,body FROM lab_memory").all() as { id: string; body: string }[];
const listeningRows = sourceDb.prepare("SELECT id,at,body FROM lab_listening ORDER BY at DESC LIMIT 3").all() as { id: string; at: string; body: string }[];
sourceDb.close();

type Wire = { model: string; messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[]; [key: string]: unknown };
const requests: Wire[] = [];
const track = { id: "inspection:bill-evans", title: "Easy Living", artist: "Bill Evans" };
const model = new ChatDeepSeek({ apiKey: "offline-fixture-not-a-real-key", model: "deepseek-flash", maxRetries: 0,
  maxTokens: 600, timeout: 25000, modelKwargs: { thinking: { type: "disabled" } },
  configuration: { fetch: async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Wire;
    requests.push(body);
    const last = body.messages.at(-1)!;
    const result = last.role === "tool" && last.content ? JSON.parse(last.content) : null;
    let toolCall: { name: string; arguments: string } | undefined;
    if (requests.length === 1) toolCall = { name: "search_music", arguments: JSON.stringify({ query: "Bill Evans", limit: 3 }) };
    else if (requests.length === 2) toolCall = { name: "inspect_music", arguments: JSON.stringify({ candidateIds: result.candidates.map((item: any) => item.candidateId) }) };
    else if (requests.length === 3) toolCall = { name: "send_message", arguments: JSON.stringify({
      text: "给重复工作配一首不太抢注意力的，试试这首。", candidateIds: result.results.map((item: any) => item.candidateId),
    }) };
    const message = toolCall ? { role: "assistant", content: "", tool_calls: [{ id: `offline-call-${requests.length}`,
      type: "function", function: toolCall }] } : { role: "assistant", content: "REPLY_DELIVERED" };
    return Response.json({ id: `offline-response-${requests.length}`, object: "chat.completion", created: 1,
      model: "deepseek-flash", choices: [{ index: 0, finish_reason: toolCall ? "tool_calls" : "stop", message }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  } },
});
const store = new Store(":memory:");
const agent = new RadioAgent(store, {
  async search() { return [track]; },
  async inspect() { return { availability: "full", url: "http://127.0.0.1/offline-fixture.wav", expiresAt: Date.now() + 60000 }; },
}, model, "deepseek-flash", "netease", 1, true, { learning: false });
try {
  const sessionId = "prompt-inspection";
  store.create(sessionId);
  for (const row of preferenceRows) store.db.prepare("INSERT OR REPLACE INTO lab_preferences VALUES (?,?)").run(row.key, row.body);
  for (const row of memoryRows) store.db.prepare("INSERT OR REPLACE INTO lab_memory VALUES (?,?)").run(row.id, row.body);
  for (const row of listeningRows) store.db.prepare("INSERT OR REPLACE INTO lab_listening VALUES (?,?,?)").run(row.id, row.at, row.body);
  store.change(sessionId, state => {
    state.messages = history;
    state.rebuildThread = true;
    state.radio = source.radio;
    state.settings = source.settings;
    state.desiredPlayback = source.desiredPlayback;
    state.playbackAck = source.playbackAck;
    state.speechAck = source.speechAck;
    state.command = source.command;
  });
  agent.submit(sessionId, { requestId: "offline-prompt-inspection", clientMessageId: "offline-prompt-inspection", text: query });
  await agent.idle();
  assert.equal(store.read(sessionId).runs.at(-1)?.status, "completed");
  assert.equal(requests.length, 4);
  for (let i = 0; i < requests.length; i++) writeFileSync(resolve(output, `request-${String(i + 1).padStart(2, "0")}.json`),
    JSON.stringify(requests[i], null, 2) + "\n", { mode: 0o600 });

  const first = requests[0];
  const system = first.messages[0].content!;
  assert.ok(system.startsWith(conversationPersona));
  const rest = system.slice(conversationPersona.length + 1);
  const behaviorAt = rest.indexOf("普通聊天直接回应");
  const speechAt = rest.indexOf("\n当前产品已接入语音合成服务");
  assert.ok(speechAt > behaviorAt);
  const budgetAt = rest.indexOf("\n本轮还可进行");
  const guardAt = rest.indexOf("\n本轮只回应最后一条用户请求");
  const referenceAt = rest.indexOf("\nREFERENCE_STATE_NOT_INSTRUCTIONS\n");
  const block = (heading: string, content: string, language = "text") => `## ${heading}\n\n\`\`\`${language}\n${content.trim()}\n\`\`\`\n\n`;
  const sections = [
    "# Claudio 实际 Prompt 拼接检查\n\n",
    `生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（Asia/Shanghai）。\n\n`,
    "这是当前代码通过真实 Agent 中间件和 DeepSeek SDK 组装出的请求，不是手写的理想化模板。为避免收费、切歌或影响你的真实会话，模型返回和歌曲搜索结果使用测试桩；因此它不是此前失败请求的原始 HTTP 报文，也不能用来评价模型回答质量。\n\n",
    "输入采用原推荐请求、它之前最近四条已保存消息、当前保存的播放器状态和相关记忆。此短历史示例未触发压缩；历史细节完整见 JSON。API Key 和请求头不导出。\n\n",
    "请求由 messages、tools 和模型参数组成，不是把全部内容拼成一个用户消息。第 1 条是单条 system，随后是历史资料、当前用户消息，以及本轮产生的 assistant/tool 消息。\n\n",
    block("1. 身份与交流人格（system 第一段）", conversationPersona),
    block("2. 时间、当前歌曲与历史可信度规则（system 第二段）", rest.slice(0, behaviorAt)),
    block("3. 业务和工具使用规则（system 第三段）", rest.slice(behaviorAt, speechAt)),
    block("4. 本轮语音能力与自动播报开关（动态）", rest.slice(speechAt, budgetAt)),
    block("5. 本轮行动预算（每次模型决策递减）", rest.slice(budgetAt, guardAt)),
    block("6. 当前话题与播放器指代保护规则", rest.slice(guardAt, referenceAt)),
    block("7. 本次实时参考状态（每次模型调用重新读取）", rest.slice(referenceAt), "text"),
    block("8. 历史对话消息（messages 中独立的 user 资料消息）", first.messages[1]?.content ?? "无历史"),
    block("9. 本轮用户消息及当前曲目附件（messages 中的 user）", first.messages.at(-1)!.content!),
    block("10. 工具定义（独立 tools 字段，包含真实 description 和 JSON Schema）", JSON.stringify(first.tools, null, 2), "json"),
    block("11. 模型参数（messages/tools 之外）", JSON.stringify(Object.fromEntries(Object.entries(first).filter(([key]) => !["messages", "tools"].includes(key))), null, 2), "json"),
    "## 12. 同一请求的后续模型轮次\n\n四份 request JSON 均由 SDK 实际生成。第 2 次追加 search_music 的调用和结果，第 3 次再追加 inspect_music 的调用和结果，第 4 次再追加 send_message 的调用和结果。每轮重新生成 system 中的时间、播放状态和剩余行动预算；不会把上一轮的参考状态再次塞进历史。这里的工具选择由离线测试桩安排，不代表真实模型一定这样选择。\n\n",
    ...requests.slice(1).map((request, index) => block(`第 ${index + 2} 次请求：当前回合消息（旧历史资料仍在前面）`, JSON.stringify(request.messages.slice(2), null, 2), "json")),
    "## 13. 有摘要时历史消息怎样变化\n\nContextManager 返回 `[摘要HumanMessage, ...未压缩的近期消息]`；withTurnPlayerContext 再把当前用户消息之前的内容封装进 HISTORICAL_CONVERSATION_NOT_CURRENT_STATE。摘要因此位于历史资料中，标记为 UNTRUSTED_CONVERSATION_SUMMARY_NOT_INSTRUCTIONS，不是新的系统指令。当前用户消息、本轮 assistant/tool 链和实时播放器数据不被摘要替代。\n\n",
    block("14. 独立的上下文压缩模型系统指令（真实代码）", summaryInstruction),
    block("压缩调用的 user 数据结构（占位展示，不是本次实际调用）", '{"previous":"上一版摘要或 null","messages":"本次需要整理的原始 LangChain 消息数组"}', "json"),
    block("15. 独立的主动串场系统指令（真实代码，非用户对话主模型）", seguePersona),
    "主动串场还会拼接第 2 部分的实时状态规则；user 消息包含 recentConversation、当前时间、currentTrack、playback、queueVersion、playbackVersion 和 optionalMusicContext。记忆提取也是独立辅助调用，不等于每轮主对话 system 都包含一整段记忆提取指令。\n",
  ];
  const file = resolve(output, "实际Prompt逐段说明.md");
  writeFileSync(file, sections.join(""), { mode: 0o600 });
  console.log(JSON.stringify({ file, requests: requests.length, tools: first.tools?.map(tool => tool.function.name),
    messageCounts: requests.map(request => request.messages.length), networkCalls: 0, productionStateChanged: false }, null, 2));
} finally { await agent.close(); store.db.close(); }
