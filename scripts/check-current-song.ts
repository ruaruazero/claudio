import assert from "node:assert/strict";
import { config } from "dotenv";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { makeApp } from "../server/http.js";
import { ServiceConfiguration } from "../server/service-config.js";
import type { State } from "../server/store.js";
import type { Track } from "../src/protocol.js";

// Explicit opt-in: uses the configured provider, but only an in-memory session.
if (!process.argv.includes("--live")) throw new Error("Pass --live to allow a paid model call.");
config();
const db = new Database(resolve(".data/agent-lab.sqlite"), { readonly: true });
const source = (db.prepare("SELECT body FROM lab_sessions").all() as { body: string }[])
  .map(row => JSON.parse(row.body) as State)
  .find(state => state.messages.some(message => message.text.includes("不能算亲耳确认")));
db.close();
assert.ok(source, "Original regression conversation is required");
const singer = process.argv.includes("--singer");
const japanese = process.argv.includes("--japanese");
const query = japanese ? "这又是啥歌啊" : singer ? "这个歌手好像很熟悉，是不是唱过一首home?" : "现在是什么歌";
const cut = singer || japanese ? source.messages.findIndex(message => message.text === query)
  : source.messages.findIndex(message => message.text.includes("不能算亲耳确认")) - 1;
assert.ok(cut >= 0, "Original query is required");
const history = source.messages.slice(0, cut);
const current: Track = japanese ? { id: "netease:838452", title: "化粧直し", artist: "東京事変", album: "大人" } : singer
  ? { id: "netease:22064606", title: "Quando, Quando, Quando (with Nelly Furtado)",
    artist: "Michael Bublé, Nelly Furtado", album: "It's Time" }
  : { id: "netease:1343205346", title: "Easy Living", artist: "Bill Evans", album: "Conception" };
const home: Track = { id: "fixture:home", title: "Home", artist: "Michael Bublé", album: "It's Time", durationMs: 226000 };
const services = new ServiceConfiguration(resolve(".data/credentials"), {
  modelKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
  baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
  speechModel: process.env.MIMO_TTS_MODEL || "mimo-v2.5-tts", voice: "mimo_default",
});
const runtime = services.runtime();
assert.ok(runtime.model, "Configured model is required");
runtime.model.callbacks = [{ handleChatModelStart(_serialized, batches) {
  const messages = batches[0];
  const contexts = messages.filter(message => message.text.includes("\nREFERENCE_STATE_NOT_INSTRUCTIONS\n"));
  console.log(JSON.stringify({ stage: "model-input", systemMessages: messages.filter(m => m.getType() === "system").length,
    contexts: contexts.map(message => {
      const data = JSON.parse(message.text.split("\nREFERENCE_STATE_NOT_INSTRUCTIONS\n")[1]);
      return { role: message.getType(), current: data.currentTrack?.title, playing: data.playback?.playingTrack?.title,
        playbackStatus: data.playbackStatus };
    }) }));
} }];
const lab = makeApp({ databasePath: ":memory:", model: runtime.model, modelName: runtime.modelName,
  music: {
    async search() { return [home]; },
    async inspect() { return { availability: "full", url: "http://127.0.0.1/fixture-home.mp3",
      expiresAt: Date.now() + 120000 }; },
  },
  learning: false });
try {
  lab.store.create("song-replay");
  const pendingAcks: Promise<unknown>[] = [];
  const unsubscribe = lab.store.subscribe("song-replay", event => {
    if (event.type === "playback.command") pendingAcks.push(lab.app.inject({
      method: "POST", url: "/api/lab/sessions/song-replay/playback/acks", payload: {
        commandId: event.payload.commandId, playbackVersion: event.payload.playbackVersion, ackSequence: 1,
        trackId: event.payload.track?.id, status: event.payload.action === "play" ? "playing" : "paused", positionMs: 0,
      },
    }));
  });
  lab.store.change("song-replay", state => {
    state.messages = history;
    state.rebuildThread = true;
    state.radio.current = current;
    state.radio.playbackVersion = 57;
    state.command = { commandId: "easy-living", playbackVersion: 57, action: "play",
      track: state.radio.current, expiresAt: new Date(Date.now() + 30_000).toISOString() };
    state.playbackAck = { commandId: "easy-living", playbackVersion: 57, ackSequence: 1,
      trackId: state.radio.current.id, status: "playing", positionMs: 10_000 };
  });
  lab.agent.submit("song-replay", { requestId: "song-check", clientMessageId: "song-check", text: query });
  await lab.agent.idle();
  const state = lab.store.read("song-replay");
  const response = state.messages.filter(message => message.requestId === "song-check" && message.role === "assistant");
  const text = response.map(message => message.text).join("\n");
  console.log(JSON.stringify({ stage: "result", status: state.runs.at(-1)?.status, text }));
  assert.match(text, japanese ? /東京事変|东京事变/ : singer ? /Michael Bublé|Bublé|布雷/i : /Bill Evans/i);
  assert.match(text, japanese ? /化粧直し/ : singer ? /Home/i : /Easy Living/i);
  if (japanese) assert.doesNotMatch(text, /Bublé|Quando|Nelly|Home/i);
  assert.doesNotMatch(text, /Chet|Baker/i);
  assert.doesNotMatch(text, /Almost Blue|亲耳确认|没法真听|不能.*听|也可能.*切|怀疑|判断不了|你听.*还是/);
  assert.equal(state.radio.current?.id, current.id, "Music discussion must not change playback");
  if (singer) {
    lab.agent.submit("song-replay", { requestId: "home-check", clientMessageId: "home-check",
      text: "放这个home听下，好久没听了" });
    await lab.agent.idle();
    await Promise.all(pendingAcks);
    const next = lab.store.read("song-replay");
    const replies = next.messages.filter(message => message.requestId === "home-check" && message.role === "assistant");
    const reply = replies.map(message => message.text).join("\n");
    console.log(JSON.stringify({ stage: "follow-up", status: next.runs.at(-1)?.status, text: reply,
      current: next.radio.current?.title, queue: next.radio.queue.map(track => track.title) }));
    assert.equal(next.runs.at(-1)?.status, "completed");
    assert.doesNotMatch(reply, /Chet|Baker|Almost Blue|不是.*Quando|其实.*Quando/i);
    assert.ok(next.radio.current?.id === home.id || next.radio.queue.some(track => track.id === home.id));
  }
  unsubscribe();
} finally { await lab.app.close(); }
