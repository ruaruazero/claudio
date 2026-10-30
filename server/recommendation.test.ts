import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Store } from "./store.js";
import { Knowledge } from "./knowledge.js";
import { MusicDiscovery } from "./music-discovery.js";
import { RecommendationService } from "./recommendation.js";
import type { Music } from "./music.js";
import type { Track } from "../src/protocol.js";
import { makeApp } from "./http.js";

const track = (id: string, artist = id): Track => ({ id, title: `Song ${id}`, artist });
const catalog = [track("a1", "Alpha"), track("a2", "Alpha"), track("a3", "Alpha"),
  track("b", "Beta"), track("c", "Gamma"), track("d", "Delta"), track("e", "Epsilon")];
function fixture(search?: Music["search"]) {
  const store = new Store(":memory:");
  store.create("s1");
  const knowledge = new Knowledge(store, null);
  const music: Music = {
    search: search ?? (async () => catalog),
    async inspect() { return { availability: "full", reason: "fixture", expiresAt: Date.now() + 60000 }; },
  };
  const discovery = new MusicDiscovery(store, music, knowledge, () => {});
  const recommendation = new RecommendationService(store, music, knowledge, discovery, () => {});
  return { store, knowledge, recommendation };
}
function evidence(knowledge: Knowledge, id: string, text: string, at = new Date().toISOString()) {
  knowledge.archive("s1", { id, role: "user", text, status: "saved", requestId: id, createdAt: at });
}
function preference(knowledge: Knowledge, id: string, value: string, polarity: "like" | "dislike" = "like",
  scope = "general", dimension: "artist" | "track" | "genre" = "artist") {
  evidence(knowledge, id, `${polarity} ${value}`);
  return knowledge.save({ text: `${polarity} ${value}`, kind: "preference", scope, certainty: "explicit",
    sourceIds: [id], preference: { dimension, value, polarity } });
}
const context = { sessionId: "s1", requestId: "r1" };
const signal = () => new AbortController().signal;

test("cold start is bounded, diverse and never claims a personal preference or changes playback", async () => {
  const { store, knowledge, recommendation } = fixture();
  try {
    const before = store.read("s1").radio;
    const result = await recommendation.recommend(context, { queries: ["quiet"], limit: 6 }, signal());
    assert.equal(result.coldStart, true);
    assert.equal(knowledge.profile().length, 0);
    assert.equal(result.candidates.length, 6);
    assert.ok(result.candidates.filter(candidate => candidate.artist === "Alpha").length <= 2);
    assert.deepEqual(store.read("s1").radio, before);
    assert.equal(store.read("s1").command, null);
    const trace = recommendation.traces("s1")[0];
    assert.equal(trace.purpose, "cards");
    assert.equal(trace.selected.length, 6);
    assert.ok(!JSON.stringify(trace).includes("http"));
  } finally { store.db.close(); }
});

test("chat recommendation and background refill apply the same dislikes, profile and duplicate filters", async () => {
  const { store, knowledge, recommendation } = fixture();
  try {
    const liked = preference(knowledge, "u1", "Beta");
    preference(knowledge, "u2", "Gamma", "dislike");
    knowledge.feedback(catalog[0], "dislike");
    store.change("s1", state => { state.radio.current = catalog[3]; state.radio.queue = [catalog[5]]; });
    const cards = await recommendation.recommend(context, { queries: ["quiet"], limit: 6 }, signal());
    const refill = await recommendation.recommend({ ...context, background: true }, { queries: ["quiet"], purpose: "queue", limit: 6 }, signal());
    assert.deepEqual(cards.candidates.map(item => item.id), refill.candidates.map(item => item.id));
    assert.ok(cards.candidates.every(item => !["a1", "b", "c", "d"].includes(item.id)),
      JSON.stringify({ candidates: cards.candidates, profile: knowledge.profile() }));
    assert.ok(recommendation.traces("s1").every(trace => trace.profileIds.includes(liked.id)));
    assert.equal(recommendation.traces("s1")[0].background, true);
  } finally { store.db.close(); }
});

test("current situation wins over a broad old preference and scoped corrections stay local", async () => {
  const { store, knowledge, recommendation } = fixture(async query => query === "energetic" ? [catalog[5]] : [catalog[3]]);
  try {
    preference(knowledge, "u1", "Beta");
    const result = await recommendation.recommend(context, { queries: ["energetic"], scope: "exercise", limit: 1 }, signal());
    assert.equal(result.candidates[0].id, "d", "Current scene search outranks a generic artist seed");
    preference(knowledge, "u2", "Beta", "dislike", "work");
    assert.equal(knowledge.profile("work").find(tag => tag.value === "Beta")?.polarity, "dislike");
    assert.equal(knowledge.profile("rest").find(tag => tag.value === "Beta")?.polarity, "like");
  } finally { store.db.close(); }
});

test("explicit artist narrows candidates and can override a general artist dislike without overriding track dislikes", async () => {
  const { store, knowledge, recommendation } = fixture();
  try {
    preference(knowledge, "u1", "Alpha", "dislike");
    knowledge.feedback(catalog[0], "dislike");
    const result = await recommendation.recommend(context, { artist: "Alpha", limit: 6 }, signal());
    assert.deepEqual(result.candidates.map(item => item.id), ["a2", "a3"]);
  } finally { store.db.close(); }
});

test("partial music failure retains useful candidates; total failure is explicit; cancellation commits nothing", async () => {
  const { store, recommendation } = fixture(async (query, _, requestSignal) => {
    requestSignal.throwIfAborted();
    if (query === "bad") throw new Error("network");
    return [catalog[0]];
  });
  try {
    const result = await recommendation.recommend(context, { queries: ["bad", "good"] }, signal());
    assert.equal(result.partialSearchFailure, true);
    assert.equal(result.candidates.length, 1);
    await assert.rejects(recommendation.recommend(context, { queries: ["bad"] }, signal()), /MUSIC_NETWORK_OR_TIMEOUT/);
    const controller = new AbortController(); controller.abort();
    const count = recommendation.traces("s1").length;
    await assert.rejects(recommendation.recommend(context, { queries: ["good"] }, controller.signal));
    assert.equal(recommendation.traces("s1").length, count);
  } finally { store.db.close(); }
});

test("repeated evidence cannot inflate profile confidence; latest explicit corrections beat old/inferred evidence", () => {
  const { store, knowledge } = fixture();
  try {
    const initial = preference(knowledge, "old", "Alpha", "like");
    assert.equal(knowledge.save(initial).id, initial.id);
    const newerAt = new Date(Date.now() + 1000).toISOString();
    evidence(knowledge, "new", "现在不喜欢Alpha", newerAt);
    const correction = knowledge.save({ ...initial, text: "现在不喜欢Alpha", sourceIds: ["new"],
      preference: { dimension: "artist", value: "Alpha", polarity: "dislike" } });
    knowledge.save({ ...initial, certainty: "inferred", text: "推测喜欢Alpha" });
    knowledge.save({ ...initial, text: "旧证据重放喜欢Alpha" });
    assert.equal(knowledge.profile()[0].id, correction.id);
    assert.equal(knowledge.profile()[0].polarity, "dislike");
    assert.equal(knowledge.profile()[0].evidenceCount, 1);
  } finally { store.db.close(); }
});

test("forgetting an aggregated tag removes all its evidence and prevents import resurrection", () => {
  const { store, knowledge } = fixture();
  try {
    knowledge.seedImport([catalog[0]], "playlist:1");
    knowledge.seedImport([catalog[1]], "playlist:2");
    assert.equal(knowledge.profile()[0].evidenceCount, 2);
    knowledge.forget(knowledge.profile()[0].id);
    assert.equal(knowledge.profile().length, 0);
    knowledge.seedImport([catalog[0]], "playlist:1");
    assert.equal(knowledge.profile().length, 0);
    knowledge.feedback(catalog[3], "like");
    knowledge.forget(knowledge.profile()[0].id);
    assert.equal(knowledge.config<Record<string, string>>("trackFeedback", {}).b, undefined);
  } finally { store.db.close(); }
});

test("proposals reject assistant sources, unrelated turn sources, secret fields and incorrect deictic track bindings atomically", () => {
  const { store, knowledge } = fixture();
  try {
    const message = { id: "current", requestId: "r1", role: "user" as const, text: "这首好听", status: "saved" as const, createdAt: new Date().toISOString() };
    store.change("s1", (state, emit) => {
      state.radio.current = catalog[0]; state.messages.push(message);
      emit({ type: "message.saved", payload: message });
    });
    const input = { text: "喜欢这首", kind: "preference" as const, scope: "general", certainty: "explicit" as const,
      sourceIds: [message.id], preference: { dimension: "track" as const, value: "b", polarity: "like" as const } };
    assert.throws(() => knowledge.propose(context, [input]), /MEMORY_TRACK_EVIDENCE_MISMATCH/);
    assert.throws(() => knowledge.propose(context, [{ ...input, sourceIds: ["unknown"] }]), /MEMORY_CURRENT_EVIDENCE_REQUIRED/);
    knowledge.archive("s1", { ...message, id: "assistant", role: "assistant", source: "model", text: "invented" });
    assert.throws(() => knowledge.save({ ...input, sourceIds: ["assistant"] }), /MEMORY_SOURCE_UNAVAILABLE/);
    const good = { ...input, preference: { ...input.preference, value: "a1" } };
    assert.throws(() => knowledge.propose(context, [good, { ...good, text: "password=supersecret" }]), /MEMORY_SENSITIVE_DATA/);
    assert.equal(knowledge.list().length, 0, "Invalid batches roll back valid preceding proposals");
    store.change("s1", state => { state.radio.current = catalog[3]; });
    const result = knowledge.propose(context, [good]);
    assert.equal(result.items[0].preference?.value, "a1", "The original song snapshot survives a later track change");
  } finally { store.db.close(); }
});

test("episodic memories survive restart, stay separate from tags, and unrelated recall returns no random filler", () => {
  const directory = mkdtempSync(join(tmpdir(), "claudio-memory-roundtrip-"));
  let store = new Store(join(directory, "state.sqlite"));
  try {
    store.create("s1");
    let knowledge = new Knowledge(store, null);
    evidence(knowledge, "u1", "听Home想家，想起上次出差。");
    knowledge.save({ text: "出差时听Home会想家", kind: "episode", scope: "general", certainty: "explicit",
      sourceIds: ["u1"], entities: ["Home", "出差", "想家"] });
    store.db.close();
    store = new Store(join(directory, "state.sqlite"));
    knowledge = new Knowledge(store, null);
    assert.equal(knowledge.personalContext("Home").memories[0].kind, "episode");
    assert.equal(knowledge.profile().length, 0);
    assert.deepEqual(knowledge.recall("unrelatedabcdef"), []);
    assert.deepEqual(knowledge.recall(""), []);
    assert.equal(knowledge.list()[0].expiresAt, null);
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

class Extractor extends BaseChatModel {
  calls: BaseMessage[][] = [];
  _llmType() { return "MEMORY_FIXTURE"; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const data = JSON.parse(messages[1].text);
    const message = new AIMessage(JSON.stringify({ items: [{
      text: "喜欢Alpha这首", kind: "preference", scope: "general", certainty: "explicit",
      sourceIds: data.newSourceIds, preference: { dimension: "track", value: data.evidence[0].playerAtMessage.track.id, polarity: "like" },
    }, {
      text: "听这首想起出差", kind: "episode", scope: "general", certainty: "explicit",
      sourceIds: data.newSourceIds, entities: ["Alpha", "出差"],
    }] }));
    return { generations: [{ message, text: message.text }] };
  }
}
test("background extraction receives the original track and writes structured preference plus independent episode", async () => {
  const store = new Store(":memory:");
  const model = new Extractor({});
  const knowledge = new Knowledge(store, model);
  try {
    store.create("s1");
    const message = { id: "u1", requestId: "r1", role: "user" as const, text: "这首好听，想起出差", status: "saved" as const, createdAt: new Date().toISOString() };
    store.change("s1", (state, emit) => { state.radio.current = catalog[0]; state.messages.push(message); emit({ type: "message.saved", payload: message }); });
    store.change("s1", state => { state.radio.current = catalog[3]; });
    knowledge.extract("s1"); await knowledge.idle();
    assert.equal(knowledge.profile()[0].value, "a1");
    assert.equal(knowledge.list().filter(item => item.kind === "episode").length, 1);
    assert.equal(model.calls.length, 1);
    knowledge.extract("s1"); await knowledge.idle();
    assert.equal(model.calls.length, 1);
  } finally { await knowledge.close(); store.db.close(); }
});

test("personalization API exposes positive tags only, retains negative policy internally and diagnostics are bounded", async () => {
  const music: Music = { async search() { return catalog; },
    async inspect() { return { availability: "full", reason: "test", expiresAt: Date.now() + 60000 }; } };
  const lab = makeApp({ databasePath: ":memory:", model: null, modelName: null, music });
  try {
    lab.store.create("s1");
    preference(lab.agent.knowledge, "u1", "Beta");
    preference(lab.agent.knowledge, "u2", "Gamma", "dislike");
    const response = await lab.app.inject({ method: "GET", url: "/api/lab/personalization" });
    const data = response.json();
    assert.equal(data.profile.length, 1);
    assert.equal(data.profile[0].value, "Beta");
    assert.equal(lab.agent.knowledge.profile().length, 2);
    lab.store.change("s1", state => { state.activeRequestId = context.requestId; });
    const result = await lab.agent.recommendation.recommend(context, { queries: ["quiet"] }, signal());
    const diagnostics = await lab.app.inject({ method: "GET", url: "/api/lab/sessions/s1/recommendations" });
    assert.equal(diagnostics.json().traces[0].id, result.traceId);
  } finally { await lab.app.close(); }
});
