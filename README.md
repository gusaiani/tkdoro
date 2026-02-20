# tt — time tracker

A minimal, keyboard-driven time tracker inspired by Notational Velocity.

![tt screenshot](screenshot.png)

## Requirements

- Python 3 (comes pre-installed on macOS)

## Start

```bash
python3 server.py
```

This starts a local server on port 5555 and opens the app in your browser automatically. If it doesn't open, navigate to [http://localhost:5555](http://localhost:5555).

## Usage

| Key | Action |
|-----|--------|
| Type | Search existing tasks or name a new one |
| `↵` | Start/stop the matched task — or create and start a new one if no match |
| `↑` `↓` | Navigate the task list |
| `Tab` | Expand/collapse today's session log for the selected task |
| `Esc` | Clear the search |

You can also click any task row to start/stop it, and hover to reveal the `✕` delete button.

Only one task runs at a time — starting a new one automatically stops the current one.

## Data

All data is stored in `data.json` in the project folder. It's plain JSON and safe to edit by hand, back up, or put in version control.

## Files

```
index.html   — the app UI
server.py    — local HTTP server (serves the app + reads/writes data.json)
data.json    — your time tracking data (created on first use)
```
