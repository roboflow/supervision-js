import { useEffect, useRef } from "react";
import {
  resolveShuttleCommand,
  stepPlaybackRate,
  type ShuttleCommand,
} from "../session/playback-rate";

const SKIP_SECONDS = 1;
const LONG_SKIP_SECONDS = 10;

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
 * their keys.
 *
 * Frame stepping and speed sit on the physical comma and period keys, read
 * through `code` so a layout that prints something else there still steps.
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
    const skip = (direction: 1 | -1, seconds: number) => {
      const { currentTime: time } = bindingsRef.current;

      if (time === null) {
        return;
      }

      seekTo(time + direction * seconds);
    };
    const stepRate = (direction: 1 | -1) => {
      const bindings = bindingsRef.current;

      bindings.onSetPlaybackRate(
        stepPlaybackRate(bindings.playbackRate, direction),
      );
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

      const stepDirection = FRAME_STEP_DIRECTIONS[event.code];

      if (stepDirection !== undefined) {
        event.preventDefault();
        if (!event.shiftKey) {
          bindingsRef.current.onStepFrame(stepDirection);
        } else if (!event.repeat) {
          stepRate(stepDirection);
        }
        return;
      }

      const skipSeconds = event.shiftKey ? LONG_SKIP_SECONDS : SKIP_SECONDS;

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          skip(-1, skipSeconds);
          return;
        case "ArrowRight":
          event.preventDefault();
          skip(1, skipSeconds);
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

/**
 * Inputs that hold focus after a click without accepting text. A layer checkbox
 * keeps focus once clicked, and treating it as a typing target retires every
 * shortcut the hint bar still advertises.
 */
const NON_TYPING_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "radio",
  "range",
]);

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target instanceof HTMLTextAreaElement) {
    return true;
  }

  return (
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement &&
      !NON_TYPING_INPUT_TYPES.has(target.type))
  );
}

const FRAME_STEP_DIRECTIONS: Record<string, 1 | -1 | undefined> = {
  Comma: -1,
  Period: 1,
};
