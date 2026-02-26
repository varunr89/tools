# Pomodoro Timer CLI - Design & Implementation Plan

## Overview

A Python CLI pomodoro timer with configurable work/break durations, session tracking, and macOS sound notifications.

## Design

### User Interface
```
$ python pomodoro.py
$ python pomodoro.py --work 25 --short-break 5 --long-break 15 --sessions 4
```

Output during a session:
```
Pomodoro Timer
==============
Session 1/4 [WORK] 24:59 remaining
████████████░░░░░░░░ 60%
```

### Architecture

Single file: `pomodoro/pomodoro.py`

**Components:**
1. `Timer` class - countdown logic with pause/resume
2. `PomodoroSession` class - manages work/break cycle state machine
3. `Display` class - terminal UI with progress bar
4. `notify()` function - macOS sound via `afplay` or `osascript`
5. `main()` - argparse CLI entry point

**State machine:**
```
WORK -> SHORT_BREAK -> WORK -> SHORT_BREAK -> ... -> LONG_BREAK -> WORK
         (repeat for N sessions, long break every 4th)
```

### Dependencies
- Python 3.9+ (stdlib only, no pip packages)
- `time`, `sys`, `argparse`, `subprocess` (for sound), `shutil` (terminal width)

### Sound Notifications
- Work complete: `afplay /System/Library/Sounds/Glass.aiff`
- Break complete: `afplay /System/Library/Sounds/Ping.aiff`
- All sessions done: `afplay /System/Library/Sounds/Hero.aiff`

---

## Implementation Tasks

### Task 1: Timer and PomodoroSession classes
- `Timer`: `start()`, `pause()`, `resume()`, `remaining()`, `is_done()`
- `PomodoroSession`: manages cycle of work/break states, tracks session count
- `notify()`: play system sounds via subprocess

### Task 2: Display and CLI
- `Display`: render countdown, progress bar, session info using `\r` overwrite
- `main()`: argparse for `--work`, `--short-break`, `--long-break`, `--sessions`
- Ctrl+C handling for graceful exit with session summary

### Task 3: Integration and polish
- Wire everything together in the main loop
- Add session summary on completion or Ctrl+C
- Test manually
