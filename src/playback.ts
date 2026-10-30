// Native pause events are asynchronous, including those caused by replacing src.
export class MediaPauseGuard {
  private expected = new WeakMap<HTMLMediaElement, number>();
  mutate(audio: HTMLMediaElement, operation: () => void) {
    if (!audio.paused) this.expected.set(audio, (this.expected.get(audio) ?? 0) + 1);
    operation();
  }
  consume(audio: HTMLMediaElement) {
    const count = this.expected.get(audio) ?? 0;
    if (!count) return false;
    if (count === 1) this.expected.delete(audio); else this.expected.set(audio, count - 1);
    return true;
  }
  playing(audio: HTMLMediaElement) { this.expected.delete(audio); }
}

export function bufferedAhead(audio: Pick<HTMLMediaElement, "buffered" | "currentTime">) {
  for (let index = 0; index < audio.buffered.length; index++) {
    if (audio.buffered.start(index) <= audio.currentTime + 0.05 &&
      audio.buffered.end(index) > audio.currentTime) {
      return audio.buffered.end(index) - audio.currentTime;
    }
  }
  return 0;
}

// A fulfilled play() is also evidence when no new playing event is emitted.
export async function playWithConfirmation(
  audio: Pick<HTMLMediaElement, "play" | "paused" | "ended">,
  isCurrent: () => boolean,
  confirm: () => void,
) {
  await audio.play();
  if (isCurrent() && !audio.paused && !audio.ended) confirm();
}

// A tiny initial chunk can play briefly and then stall. Reserve a few seconds
// before starting, without waiting for the entire track to download.
export async function waitForPlaybackBuffer(audio: HTMLMediaElement, signal: AbortSignal) {
  signal.throwIfAborted();
  if (audio.error) throw new Error("MEDIA_RESOURCE_FAILED");
  const ready = () => audio.readyState >= 3 && (bufferedAhead(audio) >= 3 ||
    (Number.isFinite(audio.duration) && bufferedAhead(audio) >= audio.duration - audio.currentTime - 0.1));
  if (ready()) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(deadline);
      clearInterval(poll);
      signal.removeEventListener("abort", aborted);
      audio.removeEventListener("progress", check);
      audio.removeEventListener("canplay", check);
      audio.removeEventListener("error", failed);
      if (error) reject(error); else resolve();
    };
    const check = () => { if (ready()) finish(); };
    const aborted = () => finish(signal.reason);
    const failed = () => finish(new Error("MEDIA_RESOURCE_FAILED"));
    const deadline = setTimeout(() => finish(new Error("MEDIA_BUFFER_TIMEOUT")), 10_000);
    const poll = setInterval(check, 100);
    signal.addEventListener("abort", aborted, { once: true });
    audio.addEventListener("progress", check);
    audio.addEventListener("canplay", check);
    audio.addEventListener("error", failed);
    check();
  });
}
