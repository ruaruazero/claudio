import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Fault } from "./store.js";
import { Knowledge } from "./knowledge.js";
import type { NeteaseMusic } from "./music.js";
import type { Track } from "../src/protocol.js";

type Api = Record<string, (query: Record<string, unknown>) => Promise<{ body: any }>>;
const require = createRequire(import.meta.url);
export type CredentialCodec = {
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};
export class MusicCredentials {
  private key!: Buffer;
  private file: string;
  constructor(directory: string, name = "netease-credential", private codec?: CredentialCodec) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, `${name}.enc`);
    if (codec) return;
    const keyFile = join(directory, `${name}.key`);
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    chmodSync(keyFile, 0o600);
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Fault("MUSIC_CREDENTIAL_KEY_INVALID");
  }
  read(): string | undefined {
    if (!existsSync(this.file)) return;
    try {
      const data = readFileSync(this.file);
      if (this.codec) return this.codec.decryptString(data);
      const cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
    } catch { throw new Fault("MUSIC_CREDENTIAL_UNREADABLE"); }
  }
  save(cookie: string) {
    if (this.codec) {
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, this.codec.encryptString(cookie), { mode: 0o600 });
      renameSync(temporary, this.file);
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(cookie, "utf8"), cipher.final()]);
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }
  clear() { if (existsSync(this.file)) unlinkSync(this.file); }
}
const profileSchema = z.object({ userId: z.number(), nickname: z.string().max(100) });
export class MusicAccount {
  private pending = new Map<string, { expires: number; checked: number }>();
  private cookie?: string;
  private authGeneration = 0;
  constructor(private knowledge: Knowledge, private music: NeteaseMusic,
    private credentials: MusicCredentials, private api: Api = require("@neteasecloudmusicapienhanced/api"),
    fallbackCookie?: string) {
    this.cookie = credentials.read() || fallbackCookie;
    this.music.setCookie(this.cookie);
  }
  private async call(name: string, query: Record<string, unknown> = {}, cookie = this.cookie) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.api[name]({ ...query, ...(cookie ? { cookie } : {}), timeout: 7000, unblock: "false" }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 9000); }),
      ]);
      const code = result.body?.code;
      if (typeof code === "number" && ![200, 800, 801, 802, 803].includes(code)) {
        throw new Fault("MUSIC_ACCOUNT_UNAVAILABLE", 502);
      }
      return result.body;
    } catch { throw new Fault("MUSIC_ACCOUNT_UNAVAILABLE: 网易请求失败，请稍后重试。", 502); }
    finally { clearTimeout(timer); }
  }
  async status() {
    if (!this.cookie) return { connected: false, profile: null };
    const result = await this.call("login_status");
    const profile = profileSchema.nullable().safeParse(result?.data?.profile ?? null);
    return { connected: Boolean(profile.success && profile.data), profile: profile.success ? profile.data : null };
  }
  async acceptSession(cookie: string, signal?: AbortSignal) {
    const generation = this.authGeneration;
    cookie = z.string().trim().min(1).max(16_000).parse(cookie);
    if (/[\r\n]/.test(cookie) || !/(?:^|;\s*)MUSIC_U=[^;]+/.test(cookie)) {
      throw new Fault("MUSIC_LOGIN_INVALID_SESSION", 400);
    }
    signal?.throwIfAborted();
    const result = await this.call("login_status", {}, cookie);
    signal?.throwIfAborted();
    if (generation !== this.authGeneration) throw new Fault("MUSIC_LOGIN_CANCELLED", 409);
    const profile = profileSchema.safeParse(result?.data?.profile);
    if (!profile.success) throw new Fault("MUSIC_LOGIN_NOT_CONFIRMED", 401);
    this.credentials.save(cookie);
    this.cookie = cookie;
    this.music.setCookie(cookie);
    this.pending.clear();
    this.authGeneration++;
    return { connected: true as const, profile: profile.data };
  }
  async qr() {
    for (const [key, value] of this.pending) if (value.expires <= Date.now()) this.pending.delete(key);
    if (this.pending.size >= 4) throw new Fault("MUSIC_LOGIN_ALREADY_PENDING", 429);
    const result = await this.call("login_qr_key");
    const key = z.string().min(1).max(200).parse(result?.data?.unikey);
    const created = await this.call("login_qr_create", { key, qrimg: true });
    const image = z.string().max(200_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).parse(created?.data?.qrimg);
    this.pending.set(key, { expires: Date.now() + 180_000, checked: 0 });
    return { key, image, expiresAt: new Date(Date.now() + 180_000).toISOString() };
  }
  async check(key: string) {
    const pending = this.pending.get(key);
    if (!pending || pending.expires <= Date.now()) return { status: "expired" };
    if (Date.now() - pending.checked < 1500) return { status: "waiting" };
    pending.checked = Date.now();
    const result = await this.call("login_qr_check", { key });
    if (result.code === 800) { this.pending.delete(key); return { status: "expired" }; }
    if (result.code === 803) {
      const cookie = z.string().min(1).max(16_000).parse(result.cookie);
      this.credentials.save(cookie);
      this.cookie = cookie;
      this.music.setCookie(cookie);
      this.pending.delete(key);
      return { status: "connected", ...(await this.status()) };
    }
    return { status: result.code === 802 ? "scanned" : "waiting" };
  }
  logout() {
    this.authGeneration++;
    this.credentials.clear();
    this.cookie = undefined;
    this.music.setCookie(undefined);
    this.pending.clear();
    return { connected: false, profile: null };
  }
  async playlists() {
    const account = await this.status();
    if (!account.profile) throw new Fault("MUSIC_LOGIN_REQUIRED", 401);
    const result = await this.call("user_playlist", { uid: account.profile.userId, limit: 50 });
    return z.array(z.object({ id: z.number(), name: z.string(), trackCount: z.number().optional() }))
      .parse(result.playlist);
  }
  async importPlaylist(value: string) {
    const id = /^\d+$/.test(value) ? value : value.match(/[?&]id=(\d+)/)?.[1];
    if (!id || id.length > 30) throw new Fault("PLAYLIST_ID_INVALID", 400);
    const result = await this.call("playlist_detail", { id });
    const playlist = z.object({ id: z.number(), name: z.string(),
      trackIds: z.array(z.object({ id: z.number() })).optional(),
      tracks: z.array(z.object({ id: z.number(), name: z.string(), dt: z.number().optional(),
        ar: z.array(z.object({ name: z.string() })), al: z.object({ name: z.string().optional() }).optional() })) })
      .parse(result.playlist);
    const seen = new Set<string>();
    const tracks: Track[] = playlist.tracks.slice(0, 500).map((track) => ({
      id: `netease:${track.id}`, title: track.name, artist: track.ar.map((a) => a.name).join(", "),
      durationMs: track.dt, album: track.al?.name,
    })).filter((track) => !seen.has(track.id) && Boolean(seen.add(track.id)));
    if (!tracks.length) throw new Fault("PLAYLIST_EMPTY_OR_UNAVAILABLE", 400);
    this.knowledge.setConfig(`playlist:${id}`, { id, name: playlist.name, tracks, importedAt: new Date().toISOString() });
    this.knowledge.seedImport(tracks, `playlist:${id}`);
    const artists = new Map<string, number>();
    for (const track of tracks) for (const artist of track.artist.split(", ")) artists.set(artist, (artists.get(artist) ?? 0) + 1);
    const top = [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const memory = this.knowledge.save({ text: `导入歌单《${playlist.name}》中常出现的艺人：${top.map(([name]) => name).join("、")}；仅作初始选歌线索，不代表每首都喜欢。`,
      kind: "preference", scope: "imported playlist", certainty: "inferred", sourceIds: [`playlist:${id}`] }, "playlist");
    return { id, name: playlist.name, imported: tracks.length,
      total: playlist.trackIds?.length ?? tracks.length, partial: (playlist.trackIds?.length ?? 0) > tracks.length, memory };
  }
  async importHistory() {
    const account = await this.status();
    if (!account.profile) throw new Fault("MUSIC_LOGIN_REQUIRED", 401);
    const result = await this.call("user_record", { uid: account.profile.userId, type: 1 });
    const entries = z.array(z.object({ playCount: z.number().optional(),
      song: z.object({ id: z.number(), name: z.string(), ar: z.array(z.object({ name: z.string() })) }) }))
      .parse(result.weekData ?? []);
    const records = entries.slice(0, 100).map((entry) => ({
      id: `netease:${entry.song.id}`, title: entry.song.name,
      artist: entry.song.ar.map((a) => a.name).join(", "), playCount: entry.playCount,
    }));
    this.knowledge.setConfig("importedListeningHistory", records);
    this.knowledge.seedImport(records, "netease:week-history");
    if (records.length) this.knowledge.save({ text: `导入的近一周听歌记录中常见：${records.slice(0, 8)
      .map((record) => `${record.artist}《${record.title}》`).join("、")}；仅作弱偏好线索。`,
      kind: "preference", scope: "imported history", certainty: "inferred", sourceIds: ["netease:week-history"] }, "playlist");
    return { imported: records.length };
  }
}
