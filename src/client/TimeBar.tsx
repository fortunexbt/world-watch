import { useEffect, useRef, useState } from "react";
import { Link, Pause, Play, X } from "lucide-react";
import { translate, type Language } from "./locale";

const MINUTE = 60000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
export const STEPS = [
  [15 * MINUTE, "15 min"],
  [HOUR, "1 hour"],
  [6 * HOUR, "6 hours"],
  [DAY, "1 day"],
] as const;
/** About a hundred stops across the retained history, never finer than 15 minutes. */
export const defaultStep = (span: number) =>
  STEPS.find(([ms]) => span / ms <= 120)?.[0] ?? DAY;
/** Stops fall on whole steps of local time, counted from the local midnight before `from`. */
export function stops(from: number, now: number, step: number) {
  const origin = new Date(from).setHours(0, 0, 0, 0),
    min = origin + Math.floor((from - origin) / step) * step,
    max = origin + Math.floor((now - origin) / step) * step;
  const snap = (t: number) => Math.min(max, Math.max(min, origin + Math.round((t - origin) / step) * step));
  return { min, max: Math.max(min, max), snap };
}
export const formatKnown = (ms: number, language: Language) =>
  new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(ms);

/**
 * Scrubs the knowledge time the map and feed are read at, over the history retention keeps.
 * Moves settle for a quarter second before they are committed, so a drag reads once; play
 * advances one step only after the previous step's view has arrived.
 */
export default function TimeBar({
  at,
  from,
  now,
  loaded,
  language,
  copied,
  onChange,
  onCopy,
  onClose,
}: {
  at: string;
  from: string | null;
  now: number;
  loaded: boolean;
  language: Language;
  copied: string;
  onChange: (at: string) => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const tr = (text: string) => translate(language, text);
  const earliest = from ? Math.min(Date.parse(from), now - HOUR) : now - 7 * DAY;
  // The step follows the history's length until a step is chosen.
  const [chosen, setChosen] = useState<number | null>(null),
    [draft, setDraft] = useState<number | null>(null),
    [playing, setPlaying] = useState(false);
  const step = chosen ?? defaultStep(now - earliest);
  const { min, max, snap } = stops(earliest, now, step);
  const value = snap(draft ?? (at ? Date.parse(at) : max));
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const commit = (t: number, wait = 250) => {
    setDraft(t);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      setDraft(null);
      onChange(new Date(snap(t)).toISOString());
    }, wait);
  };
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => {
    if (!playing || !loaded || draft !== null) return;
    if (value >= max) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => commit(value + step, 0), 1200);
    return () => clearTimeout(timer);
  }, [playing, loaded, draft, value, max, step]);
  const big = step < DAY ? DAY : 7 * DAY;
  // A linked time between stops is named as it is until the control moves.
  const label =
    draft !== null ? formatKnown(value, language) : at ? formatKnown(Date.parse(at), language) : tr("Live");
  return (
    <section className="time-bar" aria-label={tr("Time")}>
      <p className="time-bar-note" role="status">
        {at
          ? tr("Showing what World Watch knew by this time, not when events happened. Later updates, corrections and links are left out.")
          : tr("Move back to see what World Watch knew at an earlier time.")}
      </p>
      <div className="time-bar-controls">
        <button
          className="icon-button"
          aria-label={tr(playing ? "Pause" : "Play")}
          aria-pressed={playing}
          onClick={() => {
            if (!playing && value >= max) commit(Math.max(min, max - DAY), 0);
            setPlaying(!playing);
          }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <label className="time-bar-track">
          <span className="time-bar-label">
            <strong>{label}</strong>
            <small>
              {tr("History from")} {formatKnown(min, language)}
            </small>
          </span>
          <input
            type="range"
            aria-label={tr("Known by")}
            aria-valuetext={label}
            aria-keyshortcuts="PageUp PageDown Shift+ArrowLeft Shift+ArrowRight Home End"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => {
              setPlaying(false);
              commit(Number(e.target.value));
            }}
            onKeyDown={(e) => {
              const jump =
                e.key === "PageUp" || (e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowUp"))
                  ? big
                  : e.key === "PageDown" || (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowDown"))
                    ? -big
                    : 0;
              if (!jump) return;
              e.preventDefault();
              setPlaying(false);
              commit(value + jump);
            }}
          />
        </label>
        <select
          aria-label={tr("Step")}
          value={step}
          onChange={(e) => setChosen(Number(e.target.value))}
        >
          {STEPS.map(([ms, name]) => (
            <option key={ms} value={ms}>
              {tr(name)}
            </option>
          ))}
        </select>
        <button className="icon-button" aria-label={tr("Copy link")} onClick={onCopy}>
          <Link size={16} />
        </button>
        <button className="icon-button" aria-label={tr(at ? "Return to live" : "Close")} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {copied && <p className="time-bar-copied" role="status">{tr(copied)}</p>}
    </section>
  );
}
