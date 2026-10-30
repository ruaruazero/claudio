import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicAccount, MusicCredentials } from "./music-account.js";
import { NeteaseMusic } from "./music.js";
import { Knowledge } from "./knowledge.js";
import { Store } from "./store.js";

function fixture(status: (query: Record<string, unknown>) => Promise<{ body: unknown }>) {
  const directory = mkdtempSync(join(tmpdir(), "claudio-official-login-"));
  const store = new Store(":memory:");
  const credentials = new MusicCredentials(directory);
  const knowledge = new Knowledge(store, null);
  const api = { login_status: status };
  const create = () => new MusicAccount(knowledge, new NeteaseMusic("http://127.0.0.1:3000"), credentials, api);
  return { directory, credentials, create,
    close: () => { store.db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const profile = { userId: 123, nickname: "Official login" };

test("official session is verified with the new credentials, encrypted and restored without exposing cookies", async () => {
  const lab = fixture(async query => {
    assert.equal(query.cookie, "MUSIC_U=official-session");
    return { body: { data: { profile } } };
  });
  try {
    lab.credentials.save("MUSIC_U=previous-session");
    const result = await lab.create().acceptSession("MUSIC_U=official-session");
    assert.deepEqual(result, { connected: true, profile });
    assert.equal(JSON.stringify(result).includes("official-session"), false);
    assert.equal(readFileSync(join(lab.directory, "netease-credential.enc")).includes("official-session"), false);
    assert.deepEqual(await lab.create().status(), { connected: true, profile });
  } finally { lab.close(); }
});

for (const outcome of ["no-profile", "rejected", "network"] as const) {
  test(`unverified official session preserves the existing login: ${outcome}`, async () => {
    const lab = fixture(async () => {
      if (outcome === "network") throw new Error("private upstream failure");
      return { body: outcome === "rejected" ? { code: 403 } : { data: { profile: null } } };
    });
    try {
      lab.credentials.save("MUSIC_U=previous-session");
      await assert.rejects(lab.create().acceptSession("MUSIC_U=new-session"), /MUSIC_/);
      assert.equal(lab.credentials.read(), "MUSIC_U=previous-session");
    } finally { lab.close(); }
  });
}

for (const action of ["cancel", "logout"] as const) {
  test(`late official verification cannot restore a login after ${action}`, async () => {
    let complete!: (value: { body: unknown }) => void;
    const lab = fixture(() => new Promise(resolve => { complete = resolve; }));
    try {
      lab.credentials.save("MUSIC_U=previous-session");
      const account = lab.create();
      const controller = new AbortController();
      const pending = account.acceptSession("MUSIC_U=new-session", controller.signal);
      const rejected = assert.rejects(pending);
      if (action === "cancel") controller.abort();
      else account.logout();
      complete({ body: { data: { profile } } });
      await rejected;
      assert.equal(lab.credentials.read(), action === "cancel" ? "MUSIC_U=previous-session" : undefined);
    } finally { lab.close(); }
  });
}

test("official session refuses missing authentication and header injection before contacting upstream", async () => {
  let requests = 0;
  const lab = fixture(async () => { requests++; return { body: { data: { profile } } }; });
  try {
    const account = lab.create();
    await assert.rejects(account.acceptSession("other=value"), /MUSIC_LOGIN_INVALID_SESSION/);
    await assert.rejects(account.acceptSession("MUSIC_U=value\r\nOther: value"), /MUSIC_LOGIN_INVALID_SESSION/);
    assert.equal(requests, 0);
    assert.equal(lab.credentials.read(), undefined);
  } finally { lab.close(); }
});
