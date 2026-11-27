"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getFaq } from "./faqData";
import { withTicker } from "../Ticker";
import s from "./catChat.module.css";

type Message = { id: number; from: "cato" | "you"; text: string };

const GREETING = "Ask me anything about staking. Pick a question below.";

/**
 * Scripted Q&A with the cat. It takes over the staking card while open; the
 * visitor taps a question and Cato answers. Every answer comes from faqData.
 */
export function CatChat({ onClose }: { onClose: () => void }) {
  const faq = useMemo(() => getFaq(), []);
  const [messages, setMessages] = useState<Message[]>([
    { id: 0, from: "cato", text: GREETING },
  ]);
  const [asked, setAsked] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const nextId = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    backRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer.current);
    };
  }, [onClose]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  function ask(id: string) {
    const entry = faq.find((f) => f.id === id);
    if (!entry || typing) return;
    setAsked((a) => [...a, id]);
    setMessages((m) => [...m, { id: nextId.current++, from: "you", text: entry.q }]);
    setTyping(true);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timer.current = setTimeout(
      () => {
        setTyping(false);
        setMessages((m) => [...m, { id: nextId.current++, from: "cato", text: entry.a }]);
      },
      reduced ? 0 : 600,
    );
  }

  const remaining = faq.filter((f) => !asked.includes(f.id));

  return (
    <div className={s.chat} role="dialog" aria-label="Ask Cato">
      <div className={s.head}>
        <strong>Ask Cato</strong>
        <button ref={backRef} type="button" className={s.back} onClick={onClose}>
          Back to staking
        </button>
      </div>

      <div ref={logRef} className={s.log} aria-live="polite">
        {messages.map((m) => (
          <p key={m.id} className={m.from === "cato" ? s.fromCato : s.fromYou}>
            {withTicker(m.text)}
          </p>
        ))}
        {typing && (
          <p className={`${s.fromCato} ${s.typing}`} aria-label="Cato is typing">
            <span />
            <span />
            <span />
          </p>
        )}
      </div>

      <div className={s.choices}>
        {remaining.length > 0 ? (
          remaining.map((f) => (
            <button
              key={f.id}
              type="button"
              className={s.choice}
              disabled={typing}
              onClick={() => ask(f.id)}
            >
              {withTicker(f.q)}
            </button>
          ))
        ) : (
          <p className={s.done}>That&apos;s everything I know. Happy staking!</p>
        )}
      </div>
    </div>
  );
}
