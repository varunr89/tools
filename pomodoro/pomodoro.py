#!/usr/bin/env python3
"""Pomodoro Timer CLI - work/break sessions with sound notifications."""

import argparse
import shutil
import subprocess
import sys
import time

# ── Timer ────────────────────────────────────────────────────────────

class Timer:
    """Countdown timer using monotonic clock to avoid drift."""

    def __init__(self, duration_seconds: int):
        self.duration = duration_seconds
        self._start_time = None

    def start(self):
        self._start_time = time.monotonic()

    def remaining(self) -> float:
        if self._start_time is None:
            return self.duration
        elapsed = time.monotonic() - self._start_time
        return max(0, self.duration - elapsed)

    def is_done(self) -> bool:
        return self.remaining() <= 0


# ── Sound Notifications ──────────────────────────────────────────────

def notify(sound_type: str):
    """Play a system sound notification (non-blocking, platform-aware)."""
    sounds = {
        "work_done": "/System/Library/Sounds/Glass.aiff",
        "break_done": "/System/Library/Sounds/Ping.aiff",
        "all_done": "/System/Library/Sounds/Hero.aiff",
    }
    path = sounds.get(sound_type)
    if not path:
        return

    if sys.platform == "darwin" and shutil.which("afplay"):
        try:
            subprocess.Popen(
                ["afplay", path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            pass
    else:
        # Terminal bell fallback
        print("\a", end="", flush=True)


# ── Pomodoro Session ─────────────────────────────────────────────────

class PomodoroSession:
    """Manages the work/break cycle state machine.

    Cycle: WORK -> SHORT_BREAK -> WORK -> ... -> LONG_BREAK (every Nth)
    Ends after the final WORK session (no trailing break).
    """

    WORK = "WORK"
    SHORT_BREAK = "SHORT BREAK"
    LONG_BREAK = "LONG BREAK"

    def __init__(self, work_mins, short_break_mins, long_break_mins, total_sessions):
        self.work_secs = work_mins * 60
        self.short_break_secs = short_break_mins * 60
        self.long_break_secs = long_break_mins * 60
        self.total_sessions = total_sessions
        self.current_session = 1
        self.phase = self.WORK
        self._done = False

    def current_duration(self) -> int:
        if self.phase == self.WORK:
            return self.work_secs
        elif self.phase == self.LONG_BREAK:
            return self.long_break_secs
        else:
            return self.short_break_secs

    def advance(self):
        """Transition to the next phase. Returns False when all sessions are done."""
        if self.phase == self.WORK:
            if self.current_session >= self.total_sessions:
                self._done = True
                return False
            # Determine break type
            if self.current_session % 4 == 0:
                self.phase = self.LONG_BREAK
            else:
                self.phase = self.SHORT_BREAK
        else:
            # Break just ended, start next work session
            self.current_session += 1
            self.phase = self.WORK
        return True

    def is_complete(self) -> bool:
        return self._done

    def sound_for_completed_phase(self, completed_phase: str) -> str:
        """Return the sound to play after a phase completes."""
        if self._done:
            return "all_done"
        if completed_phase == self.WORK:
            return "work_done"
        return "break_done"


# ── Display ──────────────────────────────────────────────────────────

class Display:
    """Terminal display with progress bar and session info."""

    def __init__(self):
        self._last_line_len = 0

    def render(self, session: PomodoroSession, remaining: float):
        total = session.current_duration()
        elapsed = total - remaining
        progress = elapsed / total if total > 0 else 1.0

        mins, secs = divmod(int(remaining), 60)
        term_width = shutil.get_terminal_size((80, 24)).columns

        # Build status line
        status = f"[{session.current_session}/{session.total_sessions}] {session.phase} {mins:02d}:{secs:02d} "
        bar_width = max(10, term_width - len(status) - 3)
        filled = int(bar_width * progress)
        bar = "#" * filled + "-" * (bar_width - filled)
        line = f"\r{status}[{bar}]"

        # Clear stale characters
        if len(line) < self._last_line_len:
            line += " " * (self._last_line_len - len(line))
        self._last_line_len = len(line)

        print(line, end="", flush=True)

    def clear_line(self):
        term_width = shutil.get_terminal_size((80, 24)).columns
        print("\r" + " " * term_width + "\r", end="", flush=True)

    def phase_complete(self, session: PomodoroSession):
        self.clear_line()
        if session.is_complete():
            print(f"All {session.total_sessions} sessions complete!")
        elif session.phase == session.WORK:
            print(f"Break over. Starting session {session.current_session}/{session.total_sessions}.")
        else:
            print(f"Session {session.current_session}/{session.total_sessions} complete. Take a break!")


# ── Main ─────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(description="Pomodoro Timer CLI")
    parser.add_argument("--work", type=int, default=25, help="Work duration in minutes (default: 25)")
    parser.add_argument("--short-break", type=int, default=5, help="Short break in minutes (default: 5)")
    parser.add_argument("--long-break", type=int, default=15, help="Long break in minutes (default: 15)")
    parser.add_argument("--sessions", type=int, default=4, help="Number of work sessions (default: 4)")
    args = parser.parse_args()

    if args.work <= 0 or args.short_break <= 0 or args.long_break <= 0:
        parser.error("Durations must be positive integers")
    if args.sessions < 1:
        parser.error("Sessions must be at least 1")

    return args


def main():
    args = parse_args()
    session = PomodoroSession(args.work, args.short_break, args.long_break, args.sessions)
    display = Display()
    completed_work = 0
    start_time = time.monotonic()

    print(f"Pomodoro Timer: {args.work}m work / {args.short_break}m break / {args.sessions} sessions")
    print("Press Ctrl+C to stop.\n")

    try:
        while not session.is_complete():
            timer = Timer(session.current_duration())
            timer.start()

            while not timer.is_done():
                display.render(session, timer.remaining())
                time.sleep(0.5)

            completed_phase = session.phase
            if completed_phase == session.WORK:
                completed_work += 1

            session.advance()

            sound = session.sound_for_completed_phase(completed_phase)
            notify(sound)
            display.phase_complete(session)

    except KeyboardInterrupt:
        display.clear_line()
        print("\nInterrupted.")

    # Summary
    elapsed = time.monotonic() - start_time
    elapsed_mins = int(elapsed / 60)
    print(f"\nSummary: {completed_work} work sessions completed in {elapsed_mins} minutes.")


if __name__ == "__main__":
    main()
