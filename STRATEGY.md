# Tikkit Launch Strategy

> **Core message:** "The time tracker that gets out of your way."

---

## Channels & Tactics

### 1. Show HN (Highest ROI)

Hacker News is the best single channel for developer tools. A good Show HN can drive thousands of visits in a day.

**Format:**
```
Show HN: Tikkit – keyboard-driven time tracker (no menus, just Enter)
```

**Post body (~200 words):**
- Open with the problem: existing time trackers have too much friction, so people stop using them.
- The insight: the only interaction that needs to be fast is start/stop. Everything else can come later.
- How it works: type a task → Enter to start → Enter to stop. Sessions accumulate throughout the day.
- Built with: Go + SQLite + vanilla JS. No frameworks. ~600 lines total.
- What you want feedback on: keyboard UX, the "inline time editing" workflow, whether the model (tasks vs sessions) makes sense.

**Tips:**
- Post Monday–Wednesday between 09:00–11:00 ET for best front-page odds.
- Respond to every comment in the first hour.
- Don't upvote-beg; let the post stand on its own.

---

### 2. Product Hunt

PH works best when you have a network to activate on launch day. Use the footer PH link to get early upvotes from friends/colleagues before the daily ranking locks in.

**Steps:**
1. Create a Maker account at producthunt.com.
2. Schedule the post for 12:01 AM PT on a Tuesday or Wednesday.
3. Add a 60-second screen recording as the gallery item (see Twitter section below — same asset).
4. Tagline: "The time tracker that gets out of your way"
5. First comment: explain the keyboard-first philosophy.
6. Ask your network to visit & upvote on launch morning.

---

### 3. Twitter / X

The no-mouse UX is visually compelling — record a short clip and post it.

**Asset to create:** 30–60 second screen recording showing:
1. Typing a task → Enter → timer starts (dot blinks)
2. Switching tasks mid-work
3. End of day: all tasks with time breakdowns

**Tweet copy:**
```
I built a time tracker with one rule: the only input is your keyboard.

Type a task → ↵ start → ↵ stop. That's it.

No menus. No timers to configure. No mouse.

tikkit.fly.dev
```

Follow up replies with: the tech stack, the "why", and a link to the HN thread once live.

---

### 4. Indie Hackers

Post in the **"Share what you've built"** monthly thread and the **"Show your product"** section.

**Angle:** Focus on the decision to use zero frontend frameworks (Go + SQLite + ~600 lines of vanilla JS). IH readers appreciate the "built lean" story.

---

### 5. Reddit

| Subreddit | Angle |
|---|---|
| r/productivity | "How I actually got myself to track time every day" |
| r/SideProject | "I built a keyboard-only time tracker" |
| r/webdev | "I wrote a time tracker in Go + SQLite + zero JS frameworks" |

Reddit requires genuine participation — don't just drop a link. Write a real post describing the problem and solution, and put the link at the end.

---

## Quick Wins (Do First)

- [ ] **Google Search Console** — add the site, submit `sitemap.xml` (or just the homepage URL). Gets the page indexed within days.
- [ ] **Custom domain** — `tikkit.app` or `tikkit.io` would look more polished than `tikkit.fly.dev` for PH/HN posts. Check availability.
- [ ] **OG image** — already added at `/static/og.svg`. Verify at https://opengraph.xyz before posting anywhere.
- [ ] **Twitter Card** — verify at https://cards-dev.twitter.com/validator.

---

## Messaging Cheat Sheet

| Context | Headline |
|---|---|
| HN title | `Tikkit – keyboard-driven time tracker (no menus, just Enter)` |
| PH tagline | `The time tracker that gets out of your way` |
| Tweet hook | `I built a time tracker with one rule: the only input is your keyboard.` |
| OG description | `Type a task, press Enter to start. No menus, no friction. See where your day actually went.` |
