import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, type ConversationProps } from "../src/ui/Conversation.js";

const props: ConversationProps = {
  messages: [], draft: "", ready: true, canSend: true, busy: true, cancelling: false,
  online: true, canSpeak: false, readingId: null, cardPending: null, userName: "你", avatar: "",
  onDraft() {}, onSend() {}, onCancel() {}, onRetry() {}, onRead() {}, onTrack() {},
};
test("foreground context wait is visible and accessible without becoming a chat message", () => {
  const html = renderToStaticMarkup(createElement(Conversation, { ...props, activity: "正在整理前面的对话…" }));
  assert.match(html, /role="status" aria-label="正在整理前面的对话…"/);
  assert.match(html, /<small>正在整理前面的对话…<\/small>/);
  assert.ok(!html.includes("<article"));
});
test("ordinary replies and background housekeeping do not display compaction status", () => {
  const ordinary = renderToStaticMarkup(createElement(Conversation, { ...props, activity: "正在整理回应" }));
  assert.doesNotMatch(ordinary, /<small>正在整理前面的对话/);
  const background = renderToStaticMarkup(createElement(Conversation, { ...props, busy: false, activity: "正在整理前面的对话…" }));
  assert.doesNotMatch(background, /class="agent-working"/);
});

test("persisted protocol leaks are hidden and cannot be read aloud", () => {
  const html = renderToStaticMarkup(createElement(Conversation, {
    ...props, canSpeak: true, messages: [{
      id: "old", role: "assistant", source: "model", text: '<｜｜DSML｜｜ invoke name="send_message">private</｜｜DSML｜｜ invoke>',
      status: "complete", createdAt: new Date().toISOString(),
    }],
  }));
  assert.doesNotMatch(html, /DSML|private/);
  assert.match(html, /这条回复未能正常显示/);
  assert.match(html, /aria-label="朗读这条消息"[^>]*disabled/);
});
