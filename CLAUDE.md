# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**통빱 호출벨 시스템** — A WebSocket-based restaurant table call bell management system for two locations: `3루점` and `1루점`.

## Development Commands

```bash
npm start       # Start the server (port 3000)
npm run dev     # Same as start
```

No build step, lint, or real test suite. The app runs directly as Node.js + static HTML files.

## Architecture

**Stack:** Node.js + Express + WebSocket (`ws` library) on the backend; Vanilla JS/HTML/CSS on the frontend.

### Server (`server.js`)

Single server handles both restaurant locations. Each location (store) has independent state:

```javascript
stores['3ru'] = { displayClients, inputClients, currentNumbers[], currentDisplayMode, soldOutMenus[], currentStatus, currentMsgDisplay }
stores['1ru'] = { ... }  // same structure
```

Clients connect via WebSocket and register by sending `DISPLAY` or `INPUT` as the first message, along with a `storeKey` to join the right location.

### Frontend Pages

| File | Role | Store |
|------|------|-------|
| `input.html` | Admin panel (staff) | 3루점 |
| `input1.html` | Admin panel (staff) | 1루점 |
| `display.html` | Customer-facing TV/kiosk | 3루점 |
| `display1.html` | Customer-facing TV/kiosk | 1루점 |

### WebSocket Message Flow

Admin panel → server → broadcast to all display clients for that store.

Key message types (input → server):
- `CALL:NUMBER` — call a table number (adds to list, max 10)
- `CALL_LAST` — re-announce the last called number
- `CALL_PLUS_ONE:NUMBER` — add number (server handles identically to `CALL:`)
- `MODE:WAITING` / `MODE:CALL` — switch between promo slide and call screen
- `STATUS:text` — update status bar text
- `TOGGLE_MENU:name` — toggle a menu item's sold-out state
- `MSG_DISPLAY:text|duration` — show timed banner on display (empty text clears it)
- `SEQUENCE:n1,n2,...` / `SEQUENCE_NEW:n1,n2,...` — set number list (NEW variant includes all as calledNumbers)
- `AUDIO:type` — trigger audio on displays only
- `MSG:text` — general message broadcast
- `CLEAR` — reset all numbers

**1루점-only messages:**
- `TIME:sam:noodle` — update wait times (삼겹/국수), display-only
- `MSG:N번 손님까지 드립니다` — parsed as `SERVE_UNTIL` with auto-number-add

### Display Screen Modes

1. **WAITING** — shows `slide1.jpg` promotional image
2. **CALL** — shows called number boxes (up to 10, max 5 per row)
3. **CLOSED** — red overlay for end-of-day/sold out

New number calls trigger a fullscreen animation + queued audio from `voice/` MP3 files (numbered `N번.mp3`, ~700 files).

### Audio System (Display)

Audio uses a single cached `Audio` element with a playback queue to prevent overlap. Files: `voice/N번.mp3`. The display screen requires a user click interaction before audio can play (browser autoplay restriction).

## Key Constants

- Default port: `3000` (override with `PORT` env var)
- Admin password: `"1234"` (hardcoded, for closing/emergency actions)
- Heartbeat interval: 300s (5min)
- Client timeout: 600s (10min, 2x heartbeat)
- Max displayed numbers: 10

## URL Routes

- `/` — 3루점 admin (input.html)
- `/1ru` — 1루점 admin (input1.html)
- `/input.html`, `/input1.html` — served by express.static
- `/display.html` — 3루점 display
- `/display1.html` — 1루점 display

## REST API

- `GET /health` — full system state (modes, clients, numbers, menus)
- `GET /status` — quick uptime + client count check

## Security

- Static file serving blocks sensitive paths: `server.js`, `package.json`, `package-lock.json`, `CLAUDE.md`, `.git/`, `.claude/`, `node_modules/`
- Admin pages use `escHtml()` helper to sanitize all WebSocket text before `innerHTML` insertion (XSS prevention)
- Display pages use `textContent`/`innerText` for user-facing text (safe by default)
