import { test } from "node:test";
import assert from "node:assert/strict";
import { NeteaseMusic } from "./music.js";
import { makeApp } from "./http.js";

test("artwork lookup matches song ID, coalesces requests, caches and upgrades CDN HTTPS", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(String(options?.body)).ids, "123");
    await new Promise(resolve => setImmediate(resolve));
    return new Response(JSON.stringify({ code: 200, songs: [
      { id: 456, name: "Other", al: { picUrl: "https://example.com/other.jpg" } },
      { id: 123, name: "Song", al: { picUrl: "http://p4.music.126.net/album.jpg" } },
    ] }));
  };
  try {
    const music = new NeteaseMusic("http://127.0.0.1:3000");
    assert.deepEqual(await Promise.all([music.artwork("netease:123"), music.artwork("netease:123")]),
      ["https://p4.music.126.net/album.jpg", "https://p4.music.126.net/album.jpg"]);
    assert.equal(await music.artwork("netease:123"), "https://p4.music.126.net/album.jpg");
    assert.equal(await music.artwork("https://example.com"), null);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("artwork HTTP endpoint validates IDs and does not resolve arbitrary URLs", async () => {
  const music = new NeteaseMusic("http://127.0.0.1:3000");
  music.artwork = async id => {
    assert.equal(id, "netease:123");
    return "https://p4.music.126.net/album.jpg";
  };
  const lab = makeApp({ databasePath: ":memory:", music, model: null, modelName: null });
  try {
    const response = await lab.app.inject({ url: "/api/lab/music/artwork?trackId=netease%3A123" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().artworkUrl, "https://p4.music.126.net/album.jpg");
    assert.equal((await lab.app.inject({ url: "/api/lab/music/artwork?trackId=https://example.com" })).statusCode, 400);
  } finally { await lab.app.close(); }
});
