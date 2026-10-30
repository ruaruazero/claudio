import type { FastifyInstance } from "fastify";
import type { Track } from "../src/protocol.js";
import type { Music, Resource } from "./music.js";

const seconds = 24;
const catalog = [
  { key: "focus-1", name: "静心循环", tags: "安静 轻柔 专注 工作 学习 写作 钢琴 quiet calm focus piano ambient", notes: [220, 261.63, 329.63], bpm: 64 },
  { key: "focus-2", name: "午后微光", tags: "安静 专注 工作 学习 无人声 纯音乐 lofi instrumental chill", notes: [196, 246.94, 293.66], bpm: 72 },
  { key: "focus-3", name: "慢速留白", tags: "安静 放松 休息 傍晚 睡眠 calm quiet sleep rest ambient", notes: [174.61, 220, 261.63], bpm: 56 },
  { key: "energy-1", name: "下班节拍", tags: "工作结束 下班 兴奋 动感 high energetic upbeat dance electronic", notes: [220, 261.63, 329.63], bpm: 128 },
  { key: "energy-2", name: "夜间跃动", tags: "嗨 high 开心 运动 跑步 动感 energetic workout dance rock", notes: [196, 246.94, 293.66], bpm: 140 },
  { key: "energy-3", name: "轻快出发", tags: "开心 活力 明亮 high 快乐 pop upbeat happy energetic", notes: [261.63, 329.63, 392], bpm: 116 },
];
type Entry = typeof catalog[number];

function track(entry: Entry): Track {
  return {
    id: `mock:${entry.key}`, title: `[Mock] ${entry.name}`,
    artist: "Claudio 合成测试音频", album: "本地验证素材 · 非真实歌曲",
    durationMs: seconds * 1000, availability: "full",
  };
}

// Small deterministic chord loops keep playback tests independent of external media.
export function synthesize(entry: Entry): Buffer {
  const sampleRate = 16000;
  const frames = sampleRate * seconds;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const beat = t * entry.bpm / 60;
    const note = entry.notes[Math.floor(beat) % entry.notes.length];
    const envelope = Math.exp(-(beat % 1) * 4);
    const fade = Math.min(1, t * 4, (seconds - t) * 4);
    const tone = Math.sin(2 * Math.PI * note * t) + 0.25 * Math.sin(2 * Math.PI * note * 2 * t);
    const bass = Math.sin(2 * Math.PI * entry.notes[0] / 2 * t) * 0.25;
    wav.writeInt16LE(Math.round((tone * envelope + bass) * fade * 4000), 44 + i * 2);
  }
  return wav;
}

export class MockMusic implements Music {
  constructor(private baseUrl: string) {}

  async search(query: string, limit: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const lower = query.toLowerCase();
    const ranked = catalog.map((entry, order) => ({
      entry, order,
      score: entry.tags.split(" ").filter((tag) => lower.includes(tag)).length +
        (lower.includes(entry.name) ? 10 : 0),
    }));
    ranked.sort((a, b) => b.score - a.score || a.order - b.order);
    const matched = ranked.filter((item) => item.score > 0);
    // Unknown artist/song names deliberately return no matches.
    return matched.slice(0, limit).map((item) => track(item.entry));
  }

  async inspect(item: Track, signal: AbortSignal): Promise<Resource> {
    signal.throwIfAborted();
    const entry = catalog.find((entry) => item.id === `mock:${entry.key}`);
    if (!entry) return { availability: "unknown", reason: "MOCK_TRACK_NOT_FOUND", expiresAt: Date.now() + 120_000 };
    return {
      availability: "full", reason: "MOCK_SYNTHETIC_AUDIO_BROWSER_ACK_REQUIRED",
      url: `${this.baseUrl}/api/lab/mock-audio/${entry.key}.wav`,
      expiresAt: Date.now() + 120_000,
    };
  }
}

export function registerMockAudio(app: FastifyInstance) {
  const cache = new Map<string, Buffer>();
  app.get<{ Params: { file: string } }>("/api/lab/mock-audio/:file", async (request, reply) => {
    const entry = catalog.find((entry) => `${entry.key}.wav` === request.params.file);
    if (!entry) return reply.code(404).send({ error: "MOCK_TRACK_NOT_FOUND" });
    let wav = cache.get(entry.key);
    if (!wav) { wav = synthesize(entry); cache.set(entry.key, wav); }
    reply.header("Accept-Ranges", "bytes").header("Cache-Control", "public, max-age=3600");
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const suffix = match && !match[1] && match[2] ? Number(match[2]) : null;
      const start = suffix !== null ? Math.max(0, wav.length - suffix) : Number(match?.[1] || 0);
      const end = suffix !== null ? wav.length - 1 : Math.min(Number(match?.[2] || wav.length - 1), wav.length - 1);
      if (!match || start > end || start >= wav.length || suffix === 0) {
        return reply.code(416).header("Content-Range", `bytes */${wav.length}`).send();
      }
      return reply.code(206).header("Content-Range", `bytes ${start}-${end}/${wav.length}`)
        .type("audio/wav").send(wav.subarray(start, end + 1));
    }
    return reply.type("audio/wav").send(wav);
  });
}
