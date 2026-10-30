import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { musicCdnUrl, registerMusicAudio } from "./music-audio.js";
import { Fault } from "./store.js";

test("audio proxy rejects non-music hosts, credentials, ports and non-HTTP schemes", () => {
  for (const url of ["http://127.0.0.1/a", "https://music.126.net.evil.test/a", "file:///etc/passwd",
    "https://user@music.126.net/a", "https://music.126.net:1234/a", "not-a-url"]) {
    assert.throws(() => musicCdnUrl(url));
  }
  assert.equal(musicCdnUrl("https://m801.music.126.net/a.mp3").hostname, "m801.music.126.net");
});

test("audio proxy preserves range bytes and rejects redirects outside the music CDN", async () => {
  const app = Fastify();
  app.setErrorHandler((error, _, reply) => reply.code(error instanceof Fault ? error.status : 500).send({
    error: error instanceof Error ? error.message : "ERROR",
  }));
  let calls = 0;
  registerMusicAudio(app, (async (url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    if (String(url).includes("redirect")) return new Response(null, {
      status: 302, headers: { location: "http://127.0.0.1/private" },
    });
    assert.equal((init?.headers as Record<string, string>).Range, "bytes=2-4");
    return new Response(new Uint8Array([2, 3, 4]), {
      status: 206, headers: { "Content-Range": "bytes 2-4/10", "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes" },
    });
  }) as typeof fetch);
  try {
    const response = await app.inject({ url: "/api/lab/music/audio?url=https://m801.music.126.net/test",
      headers: { range: "bytes=2-4" } });
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers["content-range"], "bytes 2-4/10");
    assert.deepEqual([...response.rawPayload], [2, 3, 4]);
    const redirect = await app.inject("/api/lab/music/audio?url=https://music.126.net/redirect");
    assert.equal(redirect.statusCode, 400);
    assert.equal(calls, 2);
  } finally { await app.close(); }
});
