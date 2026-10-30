import { useRef } from "react";
import { browserPlaybackSync, type SyncScope } from "./playback-sync";

export function usePlaybackSync(scope: () => SyncScope | null, storageFailed: () => void) {
  const options = useRef({ scope, storageFailed });
  options.current = { scope, storageFailed };
  const service = useRef<ReturnType<typeof browserPlaybackSync> | null>(null);
  service.current ??= browserPlaybackSync(() => options.current.scope(), () => options.current.storageFailed());
  return service.current;
}
