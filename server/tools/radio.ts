import { z } from "zod";
import { tool } from "langchain";
import { playbackInput, queueInput, type RadioContext } from "../radio-contracts.js";
import type { RadioService } from "../radio-service.js";
import type { PlaybackCommands } from "../playback-commands.js";
import type { ToolWrapper } from "./runtime.js";

export function radioTools(radio: RadioService, commands: PlaybackCommands, wrap: ToolWrapper,
  readState: (sessionId: string) => unknown, assertLive: (context: RadioContext, signal?: AbortSignal) => void) {
  const observe = async (context: RadioContext, result: unknown, signal?: AbortSignal) => {
    const outcome = await commands.waitForResult(context.sessionId, result, signal);
    assertLive(context, signal);
    return outcome;
  };
  return [
    tool(wrap("get_radio_state", async (_, runtime) => readState(runtime.context.sessionId)), {
      name: "get_radio_state",
      description: "Read the player's current song from current (title, artist, album). Use current to answer what song this is; no playback acknowledgment is required to identify it. Also returns queue and playback state; playback acknowledgments confirm command execution only. The prompt already includes a fresh currentTrack snapshot.",
      schema: z.object({}),
    }),
    tool(wrap("update_music_queue", async (input, runtime) => observe(runtime.context,
      radio.updateQueue(input, runtime.context, `${runtime.context.requestId}:${runtime.toolCallId}`, runtime.signal),
      runtime.signal)), {
      name: "update_music_queue",
      description: "Commit inspected playable candidates atomically. Replace for a changed scene or '换一批'; after_current preserves the current track. Use latest queue version. Accepted is not proof of playback.",
      schema: queueInput,
    }),
    tool(wrap("control_playback", async (input, runtime) => observe(runtime.context,
      await radio.control(input, runtime.context.sessionId, `${runtime.context.requestId}:${runtime.toolCallId}`,
        runtime.signal, runtime.context), runtime.signal)), {
      name: "control_playback",
      description: "Issue a versioned browser command. Read playbackOutcome: playing/paused, failed, blocked, ended, superseded, interrupted or pending. Pending means the system is still tracking execution, not failure; do not resubmit. Repeated play of the same playing or pending track reuses its command.",
      schema: playbackInput,
    }),
  ];
}
