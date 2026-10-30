// Reserved model control syntax is never a user-facing reply or an executable command.
export function hasToolProtocolText(text: string): boolean {
  return /<\s*\/?\s*[|｜]+\s*(?:DSML\b|tool[ _▁](?:calls?|outputs?|sep)|function_call\b)/i.test(text) ||
    /<\s*\/?\s*(?:tool_call|function_call)\b/i.test(text);
}

export function isInternalReply(text: string): boolean {
  return hasToolProtocolText(text) || text.trim() === "REPLY_DELIVERED";
}

export const hiddenReplyText = "这条回复未能正常显示，已隐藏。";
