import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Disc3 } from "lucide-react";
import { z } from "zod";
import { request } from "../api";
import type { Track } from "../protocol";

export function IconButton({ label, children, className = "", type = "button", ...props }: {
  label: string; children: ReactNode; className?: string; type?: "button" | "submit";
  onClick?: () => void; disabled?: boolean; pressed?: boolean;
}) {
  const { pressed, ...rest } = props;
  return <button type={type} className={`icon-button ${className}`} aria-label={label}
    title={label} aria-pressed={pressed} {...rest}>{children}</button>;
}

export const ArtworkBackend = createContext<string | null>(null);
const artworkCache = new Map<string, string>();
const artworkPending = new Map<string, Promise<string | null>>();
function resolveArtwork(backend: string, trackId: string) {
  const key = `${backend}:${trackId}`;
  const cached = artworkCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = artworkPending.get(key);
  if (pending) return pending;
  const job = request(backend, `/music/artwork?trackId=${encodeURIComponent(trackId)}`,
    z.object({ artworkUrl: z.string().url().nullable() }), { timeoutMs: 10000 }).then(result => {
    if (result.artworkUrl) {
      if (artworkCache.size >= 500) artworkCache.delete(artworkCache.keys().next().value!);
      artworkCache.set(key, result.artworkUrl);
    }
    return result.artworkUrl;
  }).finally(() => artworkPending.delete(key));
  artworkPending.set(key, job);
  return job;
}

export function Cover({ track, className = "" }: { track?: Track | null; className?: string }) {
  const backend = useContext(ArtworkBackend);
  const [resolved, setResolved] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState("");
  const id = track?.id;
  const direct = track?.artworkUrl;
  useEffect(() => {
    if (!backend || !id || direct || !/^netease:\d+$/.test(id)) return;
    let live = true;
    void resolveArtwork(backend, id).then(url => {
      if (live && url) setResolved({ id, url });
    }).catch(() => { /* Artwork failure must not interrupt music playback. */ });
    return () => { live = false; };
  }, [backend, id, direct]);
  const url = direct || (resolved?.id === id ? resolved?.url : undefined);
  return <span className={`cover ${className}`}>
    {url && url !== failed
      ? <img key={url} src={url} alt={`${track?.album || track?.title} 专辑封面`} referrerPolicy="no-referrer"
        onError={() => setFailed(url)} />
      : <Disc3 size={24} strokeWidth={1} aria-hidden="true" />}
  </span>;
}

export function Switch({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: () => void; disabled?: boolean;
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label}
    className="settings-row toggle-row" disabled={disabled} onClick={onChange}>
    <span>{label}</span><span className={`switch ${checked ? "is-on" : ""}`}><i /></span>
  </button>;
}

export function durationLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
