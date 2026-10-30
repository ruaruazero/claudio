import { z } from "zod";
import { Knowledge } from "./knowledge.js";
import { Fault } from "./store.js";

export const LocationSchema = z.object({
  name: z.string().min(1).max(120), latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180), timezone: z.string().max(80).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }),
});
type Location = z.infer<typeof LocationSchema>;
type Weather = { location: string; temperature: number; code: number; description?: string; observedAt: string; fetchedAt: string };
const weatherDescriptions: Record<number, string> = {
  0: "晴", 1: "大致晴朗", 2: "局部多云", 3: "阴", 45: "雾", 48: "冻雾",
  51: "小毛毛雨", 53: "毛毛雨", 55: "较强毛毛雨", 56: "冻毛毛雨", 57: "较强冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "较强冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "小阵雨", 81: "阵雨", 82: "强阵雨", 85: "小阵雪", 86: "强阵雪",
  95: "雷雨", 96: "雷雨伴冰雹", 99: "强雷雨伴冰雹",
};
export class EnvironmentService {
  private job: Promise<Weather | null> | null = null;
  private closing = new AbortController();
  constructor(private knowledge: Knowledge, private fetcher: typeof fetch = fetch) {}
  async search(city: string, signal?: AbortSignal) {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.search = new URLSearchParams({ name: city, count: "5", language: "zh", format: "json" }).toString();
    const response = await this.fetcher(url, { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Fault("WEATHER_LOCATION_UNAVAILABLE", 502);
    const data = z.object({ results: z.array(z.object({ name: z.string(), latitude: z.number(),
      longitude: z.number(), timezone: z.string(), country: z.string().optional(),
      admin1: z.string().optional() })).optional() }).parse(await response.json());
    return (data.results ?? []).map((item) => LocationSchema.parse({
      ...item, name: [item.name, item.admin1, item.country].filter(Boolean).join(" · "),
    }));
  }
  setLocation(location: Location | null) {
    this.knowledge.setConfig("location", location ? LocationSchema.parse(location) : null);
    this.knowledge.setConfig("weather", null);
    this.knowledge.setConfig("weatherRetryAt", 0);
    if (location) this.knowledge.setConfig("timezone", location.timezone);
  }
  async current(signal?: AbortSignal, wait = true) {
    const location = this.knowledge.config<Location | null>("location", null);
    if (!location) return { location: null, weather: null };
    let cached = this.knowledge.config<Weather | null>("weather", null);
    if (!cached || Date.now() - Date.parse(cached.fetchedAt) > 20 * 60_000) {
      if (!this.closing.signal.aborted && this.knowledge.config("weatherRetryAt", 0) <= Date.now()) {
        this.job ??= this.fetchWeather(location, wait ? signal : undefined).catch(() => {
          this.knowledge.setConfig("weatherRetryAt", Date.now() + 5 * 60_000);
          return null;
        }).finally(() => { this.job = null; });
        if (wait) cached = await this.job ?? cached;
      }
    }
    if (JSON.stringify(location) !== JSON.stringify(this.knowledge.config("location", null))) return { location: null, weather: null };
    return { location: location.name, weather: cached && Date.now() - Date.parse(cached.fetchedAt) < 60 * 60_000 ? cached : null };
  }
  private async fetchWeather(location: Location, signal?: AbortSignal): Promise<Weather> {
    const response = await this.fetcher(`https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
      latitude: String(location.latitude), longitude: String(location.longitude),
      current: "temperature_2m,weather_code", timezone: location.timezone,
    })}`, { signal: AbortSignal.any([AbortSignal.timeout(6000), this.closing.signal, ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Fault("WEATHER_UNAVAILABLE", 502);
    const result = z.object({ current: z.object({ time: z.string(), temperature_2m: z.number(), weather_code: z.number() }) })
      .parse(await response.json());
    const weather = { location: location.name, temperature: result.current.temperature_2m,
      code: result.current.weather_code, description: weatherDescriptions[result.current.weather_code] ?? "天气状况未知",
      observedAt: result.current.time, fetchedAt: new Date().toISOString() };
    if (JSON.stringify(location) === JSON.stringify(this.knowledge.config("location", null))) {
      this.knowledge.setConfig("weather", weather);
    }
    return weather;
  }
  async close() { this.closing.abort(); await this.job; }
}
