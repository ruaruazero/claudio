import { ArrowUp, Check, CircleAlert, LoaderCircle, Play, RotateCcw, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import Markdown from "react-markdown";
import type { Message, Track } from "../protocol";
import { Cover, IconButton } from "./primitives";
import { hiddenReplyText, isInternalReply } from "../model-output";

export type ConversationProps = {
  messages: Message[]; draft: string; ready: boolean; canSend: boolean;
  busy: boolean; cancelling: boolean; online: boolean; canSpeak: boolean;
  activity?: string;
  readingId: string | null; cardPending: string | null; userName: string; avatar: string;
  onDraft: (draft: string) => void; onSend: () => void; onCancel: () => void;
  onRetry: (message: Message) => void; onRead: (message: Message) => void;
  onTrack: (messageId: string, track: Track) => void;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
};
export function Conversation(props: ConversationProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const composing = useRef(false);
  useEffect(() => {
    if (nearBottom.current && logRef.current) {
      logRef.current.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [props.messages.length, props.busy]);
  return <>
    <div ref={logRef} className="message-list" role="log" aria-label="对话记录" aria-live="polite"
      onScroll={event => {
        const node = event.currentTarget;
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
      }}>
      {!props.messages.length && <div className="empty-conversation"><p>我在。今天想听点什么？</p></div>}
      {props.messages.map(message => <article key={message.id} className={`message ${message.role}`}>
        <div className="message-meta">
          {message.role === "user" && props.avatar && <img className="chat-avatar" src={props.avatar} alt="" />}
          <span>{message.role === "user" ? props.userName : message.source === "system" ? "系统说明" : "Claudio"}</span>
          {message.proactive && <small>串场</small>}
          {message.role === "assistant" && message.source !== "system" && <IconButton
            label={props.readingId === message.id ? "停止朗读" : "朗读这条消息"}
            className={`message-read ${props.readingId === message.id ? "is-reading" : ""}`}
            disabled={!props.online || !props.canSpeak || isInternalReply(message.text)}
            onClick={() => props.onRead(message)}>
            {props.readingId === message.id ? <Square size={10} fill="currentColor" /> : <Volume2 size={13} />}
          </IconButton>}
        </div>
        <div className="message-content"><Markdown skipHtml components={{
          a: ({ children }) => <span>{children}</span>, img: () => null,
        }}>{message.role === "assistant" && isInternalReply(message.text) ? hiddenReplyText : message.text}</Markdown></div>
        {message.tracks?.length ? <div className="music-recommendations">{message.tracks.map(track =>
          <div className="music-card" key={track.id}>
            <Cover track={track} /><div className="music-card-info">
              <strong>{track.title}</strong><span>{track.artist}{track.availability === "preview_only" ? " · 试听" : ""}</span>
            </div>
            <IconButton label={`播放推荐：${track.title}`} disabled={!props.online || props.cardPending === track.id}
              onClick={() => props.onTrack(message.id, track)}>
              {props.cardPending === track.id ? <LoaderCircle size={20} className="spin" /> : <Play size={21} />}
            </IconButton>
          </div>)}</div> : null}
        {message.role === "user" && message.status !== "saved" && <div className={`save-status ${message.status}`}>
          {message.status === "pending" ? <LoaderCircle className="spin" size={11} /> : <CircleAlert size={11} />}
          <span>{message.status === "pending" ? "正在保存" : "保存待确认"}</span>
          <button type="button" disabled={!props.online || props.busy} onClick={() => props.onRetry(message)}
            className="inline-retry"><RotateCcw size={12} />重试</button>
        </div>}
      </article>)}
      {props.busy && <div className="agent-working" role="status" aria-label={props.activity === "正在整理前面的对话…" ? props.activity : "Claudio 正在回应"}>
        <span /><span /><span />
        {props.activity === "正在整理前面的对话…" && <small>{props.activity}</small>}
      </div>}
    </div>
    <form className="composer" onSubmit={event => {
      event.preventDefault();
      if (!composing.current && props.canSend && !props.busy) props.onSend();
    }}>
      <textarea ref={props.composerRef} aria-label="给 Claudio 发消息" placeholder="想说什么，都可以…"
        value={props.draft} maxLength={4000} rows={1} disabled={!props.ready}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onChange={event => props.onDraft(event.target.value)}
        onKeyDown={event => {
          // Safari can clear isComposing before the Enter that confirms an IME candidate.
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (props.canSend && !props.busy) props.onSend();
          }
        }} />
      {props.busy ? <IconButton className="send-button" label="停止本次生成" disabled={props.cancelling || !props.online}
        onClick={props.onCancel}>{props.cancelling ? <LoaderCircle size={18} className="spin" /> : <Square size={14} fill="currentColor" />}</IconButton>
        : <IconButton label="发送消息" className="send-button" type="submit" disabled={!props.canSend || !props.draft.trim()}>
          <ArrowUp size={21} strokeWidth={3} />
        </IconButton>}
    </form>
    <span className="sr-only"><Check size={10} />草稿自动保存在本机</span>
  </>;
}
