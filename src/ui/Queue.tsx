import { useEffect, useRef } from "react";
import { ListMusic, X } from "lucide-react";
import type { Track } from "../protocol";
import { IconButton } from "./primitives";

function Tracks({ tracks }: { tracks: Track[] }) {
  return tracks.length ? <ol className="queue-list">
    {tracks.map((track, i) => <li key={`${track.id}-${i}`}>
      <span className="queue-index">{String(i + 1).padStart(2, "0")}</span>
      <span className="queue-title" title={track.title}>{track.title}
        {track.availability === "preview_only" && <small>试听</small>}</span>
      <span className="queue-artist" title={track.artist}>{track.artist}</span>
    </li>)}
  </ol> : <div className="empty-queue"><ListMusic size={24} strokeWidth={1.3} /><span>接下来的音乐，会在这里等你。</span></div>;
}
export function InlineQueue({ tracks }: { tracks: Track[] }) {
  return <section className="inline-queue" aria-label="待播队列">
    <h2>接下来 <span>{tracks.length} 首</span></h2><Tracks tracks={tracks} />
  </section>;
}
export function QueueDrawer({ tracks, open, onClose }: { tracks: Track[]; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      dialog.dataset.closing = "false";
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (!dialog.open) return;
    dialog.dataset.closing = "true";
    const timer = window.setTimeout(() => dialog.close(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
    return () => window.clearTimeout(timer);
  }, [open]);
  useEffect(() => {
    const media = matchMedia("(min-width: 1024px)");
    const resize = () => { if (media.matches && ref.current?.open) onClose(); };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, [onClose]);
  return <dialog ref={ref} className="queue-dialog" aria-labelledby="queue-heading" onClose={onClose}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <div className="drawer-handle" aria-hidden="true" />
    <header className="dialog-heading"><h2 id="queue-heading">接下来 <small>{tracks.length} 首</small></h2>
      <IconButton label="关闭队列" onClick={onClose}><X size={20} /></IconButton>
    </header><Tracks tracks={tracks} />
  </dialog>;
}
