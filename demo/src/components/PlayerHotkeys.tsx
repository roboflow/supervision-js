import { useEffect, useRef } from "react";
import {
  resolveShuttleCommand,
  type ShuttleCommand,
} from "../session/playback-rate";

const NUDGE_SECONDS = 1;

interface PlayerHotkeyBindings {
  readonly currentTime: number | null;
  readonly duration: number | null;
  readonly isPlaying: boolean;
  readonly onPause: () => void;
  readonly onPlay: () => void;
  readonly onSeek: (time: number) => void;
  readonly onSetPlaybackRate: (rate: number) => void;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
  readonly playbackRate: number;
}

/**
 * A player's keys have to answer while the pointer is somewhere else, so they
 * listen on the window rather than on a focused control. Typing surfaces keep
 * their keys, and the timeline's own range input keeps the arrows, Home, and
 * End the browser already gives it.
 */
export function PlayerHotkeys({
  currentTime,
  disabled,
  duration,
  isPlaying,
  onPause,
  onPlay,
  onSeek,
  onSetPlaybackRate,
  onStepFrame,
  onTogglePlayback,
  playbackRate,
}: PlayerHotkeyBindings & { readonly disabled: boolean }) {
  const bindingsRef = useRef<PlayerHotkeyBindings>({
    currentTime,
    duration,
    isPlaying,
    onPause,
    onPlay,
    onSeek,
    onSetPlaybackRate,
    onStepFrame,
    onTogglePlayback,
    playbackRate,
  });

  useEffect(() => {
    bindingsRef.current = {
      currentTime,
      duration,
      isPlaying,
      onPause,
      onPlay,
      onSeek,
      onSetPlaybackRate,
      onStepFrame,
      onTogglePlayback,
      playbackRate,
    };
  });

  useEffect(() => {
    if (disabled) {
      return;
    }

    const seekTo = (time: number) => {
      const { duration: mediaDuration, onSeek: seek } = bindingsRef.current;

      if (mediaDuration === null) {
        return;
      }

      seek(Math.min(Math.max(time, 0), mediaDuration));
    };
    const nudge = (direction: 1 | -1) => {
      const { currentTime: time } = bindingsRef.current;

      if (time === null) {
        return;
      }

      seekTo(time + direction * NUDGE_SECONDS);
    };
    const shuttle = (command: ShuttleCommand) => {
      const bindings = bindingsRef.current;

      bindings.onSetPlaybackRate(command.rate);

      if (command.playback === "play") {
        bindings.onPlay();
      } else if (command.playback === "pause") {
        bindings.onPause();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      if (event.key === " ") {
        if (!event.repeat) {
          event.preventDefault();
          bindingsRef.current.onTogglePlayback();
        }

        return;
      }

      const shuttleCommand = resolveShuttleCommand(event.key, {
        isPlaying: bindingsRef.current.isPlaying,
        rate: bindingsRef.current.playbackRate,
      });

      if (shuttleCommand) {
        if (!event.repeat) {
          event.preventDefault();
          shuttle(shuttleCommand);
        }

        return;
      }

      if (isRangeTarget(event.target)) {
        return;
      }

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          if (event.shiftKey) {
            nudge(-1);
          } else {
            bindingsRef.current.onStepFrame(-1);
          }
          return;
        case "ArrowRight":
          event.preventDefault();
          if (event.shiftKey) {
            nudge(1);
          } else {
            bindingsRef.current.onStepFrame(1);
          }
          return;
        case "End":
          event.preventDefault();
          seekTo(bindingsRef.current.duration ?? 0);
          return;
        case "Home":
          event.preventDefault();
          seekTo(0);
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [disabled]);

  return null;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }

  return (
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && target.type !== "range")
  );
}

function isRangeTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement && target.type === "range";
}
