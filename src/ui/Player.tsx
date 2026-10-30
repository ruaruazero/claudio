import { ChevronDown, Heart, LoaderCircle, Pause, Play, SkipForward } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { Track } from "../protocol";
import { Cover, durationLabel, IconButton } from "./primitives";

export type PlayerProps = {
  current: Track | null; queueCount: number; playing: boolean; loading: boolean;
  nextPending: boolean; nextDisabled: boolean; liked: boolean; canLike: boolean;
  position: number; duration: number; volume: number; canSeek: boolean;
  notice: string; onPlayPause: () => void; onNext: () => void; onLike: () => void;
  onSeek: (value: number) => void; onVolume: (value: number) => void; onQueue: () => void;
  ambient?: ReactNode;
};
export function Player(props: PlayerProps) {
  const progress = Math.min(100, props.duration ? props.position / props.duration * 100 : 0);
  return <section className="player" aria-label="音乐播放器">
    <div className="player-main">
      <div className="current-track"><Cover track={props.current} />
        <div className="track-text">
          <h2 title={props.current?.title}>{props.current?.title || "还没有在播放的歌"}</h2>
          <p title={props.current?.artist}>{props.current?.artist || "Claudio"}</p>
        </div>
      </div>
      <div className="transport">
        <IconButton label={props.liked ? "取消喜欢这首" : "喜欢这首"} pressed={props.liked}
          className={props.liked ? "is-liked" : ""} disabled={!props.canLike} onClick={props.onLike}>
          <Heart size={16} fill={props.liked ? "currentColor" : "none"} />
        </IconButton>
        <IconButton label={props.playing ? "暂停" : "播放"} disabled={!props.current} onClick={props.onPlayPause}>
          {props.loading ? <LoaderCircle size={18} className="spin" /> :
            props.playing ? <Pause size={19} fill="currentColor" strokeWidth={0} /> : <Play size={18} fill="currentColor" strokeWidth={1} />}
        </IconButton>
        <IconButton label="下一首" disabled={props.nextDisabled} onClick={props.onNext}>
          {props.nextPending ? <LoaderCircle className="spin" size={18} /> : <SkipForward size={20} fill="currentColor" strokeWidth={1} />}
        </IconButton>
        <label className="volume-control"><span>VOL</span>
          <input type="range" aria-label="音乐音量" min={0} max={1} step={.01} value={props.volume}
            style={{ "--volume": `${props.volume * 100}%` } as CSSProperties}
            onChange={event => props.onVolume(Number(event.target.value))} />
        </label>
      </div>
    </div>
    <div className="playback-progress" style={{ "--progress": `${progress}%` } as CSSProperties}>
      <div className="timeline-ticks" aria-hidden="true" />
      <input type="range" aria-label="播放进度" min={0} max={props.duration || 1} step={.1}
        value={Math.min(props.position, props.duration || 1)} disabled={!props.canSeek}
        onChange={event => props.onSeek(Number(event.target.value))} />
      <div className="time-markers"><span>{durationLabel(props.position)}</span><span>{durationLabel(props.duration)}</span></div>
    </div>
    {props.current?.availability === "preview_only" && <span className="preview-label">试听片段</span>}
    <div className="queue-summary"><span>接下来 <small>{props.queueCount} 首</small></span>
      {props.ambient}
      <button type="button" onClick={props.onQueue} aria-haspopup="dialog" className="queue-expand">展开 <ChevronDown size={20} /></button>
    </div>
    {props.notice && <p className="playback-notice" role="status">{props.notice}</p>}
  </section>;
}
