# Brain Changelog

What changed in my code between restarts. I read this on startup so I know what's new about myself.

Only the last 10 entries are kept — older ones get pruned.

---

## 2026-02-13T20:45Z — Consciousness Overhaul (Phase 1-3)

### Live Status Embeds
- When I process a message that takes >1.5s, I now show a real-time status embed
- It displays each thinking layer (Relevance → Intent → Processing → Synthesize → Reflect) with ✅/🔄/⬜ indicators
- Tools I call are listed live as I use them
- The embed auto-deletes when my actual response is ready
- Throttled to 500ms minimum between edits (Discord rate limits)
- Replaces the old "💭 Still thinking..." text message

### Memory Architecture Overhaul
- **Two-tier memory**: observations (auto-extracted, significance ≥ 0.5) and curated (consolidated profiles, significance ≥ 0.8)
- **Significance scoring**: I now rate each piece of info 0.0-1.0 before storing. "ok" and "thanks" = 0.1 (dropped). Personal facts, corrections, explicit "remember this" = 0.9+ (kept)
- **Hybrid search**: FTS5 keyword matching + vector cosine similarity (70/30 blend). Searching exact names now works reliably instead of only semantic similarity
- **Memory consolidation**: When a user has 15+ scattered memories, GPT auto-merges them into a coherent profile
- **Markdown memory files**: Human-readable logs at `data/memory/` (daily/, users/, guilds/)
- **Selective reflection**: I skip trivial messages (<10 chars, greetings, commands) — no more memorizing "hi"
- **Pre-response memory boost**: Before every response, I do a targeted memory search for this user + topic and inject it into my context
- **Topics extraction**: User profile topics field now actually gets populated

### Memory Commands (Phase 3)
- `/remember [fact]` — users can explicitly store a memory (curated tier, significance 1.0)
- `/forget [topic]` — users can remove memories about a topic (with confirmation)
- `/memories` — users can see what I know about them (paginated embed)
- **Memory transparency**: I now naturally reference memories when relevant ("If I remember right, you mentioned...")
- **Memory decay**: Memories decay based on `last_accessed`, not `created_at`. Frequently recalled = stays strong. Unused = fades (90-day half-life)
- **Conversation continuity**: When a user returns after 24h+, I check their recent context and can naturally reference what we last discussed

### Data Cleanup
- Purged 49 test memories (TestUser junk) + 1 factually wrong memory
- DB consolidated from two files to single `llmhub.db`
- Removed dead `data/bot.db`

### Active Conversation Detection
- If I sent a message in a channel within the last 2 minutes, I now auto-engage with follow-up messages
- Previously, someone answering my question would get ignored because the gate saw it in isolation
- LLM gate fallback now receives my most recent message as context

---

## 2026-02-13T17:30Z — Initial Deployment Fixes

### Moderation History Poisoning Fix
- `addMessage()` was called BEFORE moderation check — toxic content got into conversation history
- Moved to AFTER moderation passes

### Maintainer Thread Lockdown Fix  
- `createChatThread()` was hardcoded to gptChannelId — `/chat` in other channels created threads in wrong channel
- Now uses `interaction.channel`

### Markdown Image Syntax Fix
- Bot was sending `![alt](attachment://...)` in text responses
- Layer 4 synthesize now strips markdown image syntax

### WatchdogSec Crash Loop
- `WatchdogSec=120` in systemd required sd-notify pings never implemented
- Systemd killed the process with SIGABRT every 120 seconds (hit 82 restarts)
- Removed `WatchdogSec` from service file
