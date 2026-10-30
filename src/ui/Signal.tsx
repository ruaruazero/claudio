import { useEffect, useRef, useState } from "react";
import { audioEngine } from "../audio-engine";

export function Signal({ playing, speaking, ambient = false, preview }: {
  playing: boolean; speaking: boolean; ambient?: boolean; preview?: boolean;
}) {
  const [clock, setClock] = useState(() => new Date());
  const matrix = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const columns = [...matrix.current!.children].map(column => [...column.children] as HTMLElement[]);
    if (!playing && !speaking && !ambient) {
      columns.flat().forEach(dot => dot.style.setProperty("--intensity", "0"));
      return;
    }
    const samples = new Float32Array(2048);
    const heights = new Float32Array(33);
    const mobile = matchMedia("(max-width: 599px)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, last = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - last < (reduced.matches ? 180 : 33)) return;
      last = now;
      const active = playing || speaking || ambient;
      audioEngine.read(speaking ? "speech" : playing ? "music" : "ambient", samples);
      const rows = mobile.matches ? 9 : 15, count = mobile.matches ? 25 : 33;
      let rms = 0;
      for (const sample of samples) rms += sample * sample;
      rms = Math.sqrt(rms / samples.length);
      if (!speaking && ambient && rms < .0001) {
        audioEngine.read("ambient", samples);
        rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      }
      const audible = active && rms > .0001;
      // Normalize quietly mastered tracks without animating digital silence.
      const gain = Math.min(12, .32 / Math.max(.025, rms));
      columns.forEach((dots, column) => {
        let energy = 0;
        const start = Math.floor(column / count * samples.length), length = Math.floor(samples.length / count);
        for (let i = start; i < Math.min(samples.length, start + length); i++) energy += samples[i] ** 2;
        const target = audible ? Math.min(1, Math.sqrt(energy / length) * gain * 2.1) : 0;
        heights[column] += (target - heights[column]) * (target > heights[column] ? .6 : .22);
        dots.forEach((dot, row) => {
          const distance = 14 - row;
          const strength = Math.max(0, Math.min(1, heights[column] * (rows - 1) - distance + 1));
          dot.style.setProperty("--intensity", audible ? String(strength) : "0");
        });
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [playing, speaking, ambient]);
  return <section className={`signal ${playing || ambient ? "is-playing" : ""} ${speaking ? "is-speaking" : ""} ${preview ? "is-preview" : ""}`}
    aria-label={speaking ? "Claudio 正在说话" : playing ? "音乐正在播放" : ambient ? "环境声正在播放" : "电台待机"}>
    <p className="signal-eyebrow">YOUR PERSONAL RADIO</p>
    <div className="dot-matrix" ref={matrix} aria-hidden="true">
      {Array.from({ length: 33 }, (_, column) => <span className="dot-column" key={column}>
        {Array.from({ length: 15 }, (_, row) => <i key={row} />)}
      </span>)}
    </div>
    <div className="signal-caption"><span>{speaking ? "Claudio 在说话" : ambient && !playing ? "听一会儿自然" : "音乐里见"}</span>
      <time>{preview ? "23:41" : clock.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
    </div>
  </section>;
}
