# LLMHub Discord Bot

An intelligent Discord bot with persistent memory, personality evolution, content moderation, and rate limiting. Built for the LLMHub server.

## Features

- **Conversational AI** — GPT-4o powered responses with configurable personality
- **Persistent Memory** — Extracts and recalls facts from conversations using embeddings
- **User Profiles** — Tracks user preferences, topics, and personality notes
- **Soul System** — Bot personality that evolves through self-reflection
- **Content Moderation** — OpenAI Moderation API checks on input and output
- **Rate Limiting** — Per-user and per-channel sliding window rate limits
- **Thread Support** — `/chat` slash command creates private conversation threads
- **Smart Relevance** — In main channel, bot decides when to respond based on context

## Architecture

| Module | Purpose |
|---|---|
| `index.js` | Main entry point, message handling, lifecycle |
| `openai-client.js` | OpenAI API wrapper for chat completions |
| `context.js` | In-memory conversation context management |
| `db.js` | SQLite database layer (better-sqlite3) |
| `soul.js` | Personality system, system prompts, self-reflection |
| `memory.js` | Fact extraction, embedding storage, semantic recall |
| `users.js` | User profile tracking and enrichment |
| `threads.js` | Thread creation for `/chat` command |
| `relevance.js` | Smart response decision engine |
| `moderator.js` | Content moderation (input + output) |
| `ratelimiter.js` | Sliding window rate limiter with cooldowns |

## Setup

1. Clone the repo
2. `npm install`
3. Copy `.env.example` to `.env` and fill in values
4. `node index.js` (or use systemd)

### .env.example

```env
DISCORD_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key
GUILD_ID=your_guild_id
GPT_CHANNEL_ID=channel_id_for_bot
APP_ID=your_app_id
RATE_LIMIT_USER=5
RATE_LIMIT_WINDOW=30
MODERATION_ENABLED=true
```

## Slash Commands

| Command | Description |
|---|---|
| `/chat` | Creates a private thread for 1-on-1 conversation |

## Memory System

Every 15 messages per channel, the bot extracts facts from recent conversation using GPT. Facts are stored with embeddings in SQLite for semantic retrieval. When responding, relevant memories are included in the system prompt for context-aware replies.

User profiles accumulate over time — topics discussed, personality notes, and preferences.

## Moderation

When `MODERATION_ENABLED=true`, every incoming message and outgoing response is checked via OpenAI's Moderation API. Flagged categories: hate, harassment, self-harm, sexual, violence.

- Flagged input → message ignored, ⚠️ reaction added
- Flagged output → response blocked, user notified

All moderation events are logged to the `moderation_log` SQLite table.

## Rate Limiting

- **Per-user:** 5 messages per 30s in main channel, 10 per 30s in threads
- **Per-channel:** 30 bot responses per minute
- **Cooldown:** Users who hit the limit are silently ignored for 60 seconds

Configurable via `RATE_LIMIT_USER` and `RATE_LIMIT_WINDOW` env vars.

## Production

Run with systemd:

```bash
systemctl enable llmhub-bot
systemctl start llmhub-bot
journalctl -u llmhub-bot -f
```

Error logs: `data/error.log`

## License

MIT
