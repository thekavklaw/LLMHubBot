# LLMHub Bot

An agentic AI Discord bot with a 5-layer thinking pipeline, 10-tool agent loop, persistent memory, and real personality. Not a wrapper — a genuine conversational AI assistant.

## What It Does

LLMHub thinks before it responds. Every message goes through five cognitive layers — a relevance gate, intent analysis, agentic tool execution, response synthesis, and async reflection — producing responses that feel natural, contextual, and intelligent.

It remembers your conversations, learns your preferences, detects your emotional tone, and adapts. It can search the web, generate images, run code in sandboxed environments, and pull from long-term memory — all decided autonomously by the thinking pipeline.

## Architecture

```
Message → Moderation → 5-Layer Thinking Pipeline → Response

Layer 1: Relevance Gate     — Should I respond? (heuristic, <1ms)
Layer 2: Intent Analysis    — What does the user want? (heuristic + context)
Layer 3: Agentic Execution  — Tool-calling loop (max 10 iterations)
Layer 4: Response Synthesis  — Format for Discord, smart message splitting
Layer 5: Async Reflection   — Learn from the interaction (non-blocking)
```

The agent loop in Layer 3 uses OpenAI function calling with a drop-in tool registry. GPT decides which tools to use, calls them, observes results, and iterates — just like a human would research before answering.

## Features

### Intelligence
- **5-layer cognitive pipeline** with graceful degradation under load
- **Iterative agent loop** — GPT autonomously selects and chains tools across multiple iterations
- **Persistent memory** — RAG-based recall with embedding search, scoped by guild
- **User profiles** — learns preferences, expertise level, communication style over time
- **Emotional tone detection** — adapts response style to frustrated, confused, excited, curious users
- **Multi-user thread awareness** — tracks participants, addresses people by name
- **Correction handling** — detects "you're wrong" gracefully, acknowledges and learns
- **Real personality** — defined in `data/soul.md`, not a generic assistant

### Tools (10)
| Tool | Description |
|------|-------------|
| `brave_search` | Quick web search via Brave API |
| `tavily_search` | Deep AI-synthesized search via Tavily |
| `generate_image` | Image generation via GPT Image |
| `calculator` | Safe math expression evaluation |
| `code_runner` | Sandboxed Python/JS execution via E2B |
| `timestamp` | Date/time with timezone support |
| `define_word` | Dictionary lookups |
| `summarize_url` | Webpage summarization with SSRF protection |
| `remember` | Explicitly store info to long-term memory |
| `recall` | Search long-term memory |

### Slash Commands
| Command | Description |
|---------|-------------|
| `/chat` | Start a conversation thread |
| `/imagine` | Generate an image from a prompt |
| `/tools` | List all available tools |
| `/reset` | Clear conversation context |
| `/settings` | Set preferences (verbosity, image generation) |
| `/help` | See everything LLMHub can do |
| `/export` | Export conversation as markdown |
| `/stats` | Bot statistics (admin only) |

### Production Hardening
- **Per-model priority queues** — separate concurrency for GPT-5.2, GPT-4.1-mini, image gen, moderation
- **Priority system** — mentions > replies > threads > ambient messages
- **Message debouncing** — coalesces rapid-fire messages into single processing runs
- **Circuit breaker** — trips after 3 consecutive API failures, auto-recovers after 30s
- **Retry with jitter** — exponential backoff with randomization to prevent thundering herd
- **Graceful degradation** — 4 load levels progressively disable non-essential features
- **Tool result caching** — LRU cache with TTL for search and dictionary lookups
- **Input validation** — 4000 char cap, SSRF protection, sandboxed code execution
- **Rolling summarization** — infinite conversations via automatic context compression
- **Context persistence** — survives restarts via SQLite write-through cache
- **Memory management** — deduplication, relevance decay, 90-day window, 10K cap with pruning
- **Backpressure signaling** — ⏳ emoji when queued, "still thinking..." for long operations
- **Channel lockdown** — DMs blocked, guild-locked, channel whitelist with thread support

### Security
- **E2B sandboxed code execution** — no local `vm` module, real cloud sandboxes
- **Omni-moderation** — multi-modal content moderation on text + images
- **DNS-based SSRF protection** — URL summarizer resolves DNS and blocks private IPs
- **Memory privacy scoping** — memories isolated by guild
- **No hardcoded secrets** — everything via `.env`
- **MemoryMax 512M** — systemd memory cap prevents runaway usage

## Tech Stack

- **Runtime:** Node.js + discord.js
- **AI:** OpenAI GPT-5.2 (main), GPT-4.1-mini (thinking/summarization)
- **Database:** SQLite with WAL mode (conversations, memory, user profiles, feedback, analytics)
- **Search:** Brave Search API + Tavily API
- **Code Execution:** E2B cloud sandboxes
- **Image Generation:** GPT Image (gpt-image-1)
- **Monitoring:** HTTP health endpoint on port 3870

## Setup

```bash
git clone https://github.com/thekavklaw/LLMHubBot.git
cd LLMHubBot
npm install
cp .env.example .env  # Fill in your keys
node index.js
```

### Required Environment Variables

```env
DISCORD_TOKEN=         # Discord bot token
APP_ID=                # Discord application ID
GUILD_ID=              # Target guild ID
OPENAI_API_KEY=        # OpenAI API key
BRAVE_API_KEY=         # Brave Search API key (optional)
TAVILY_API_KEY=        # Tavily API key (optional)
E2B_API_KEY=           # E2B sandbox API key (optional)
ALLOWED_GUILD_ID=      # Guild restriction
ALLOWED_CHANNEL_IDS=   # Comma-separated channel IDs
```

### systemd Service

```ini
[Unit]
Description=LLMHub Discord Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/llmhub-bot
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
MemoryMax=512M
EnvironmentFile=/opt/llmhub-bot/.env

[Install]
WantedBy=multi-user.target
```

## Stats

- **43 source files** | **~8,400 lines of code**
- **338 tests** (250 unit + 88 agentic)
- **~50MB memory footprint**
- **10 tools** | **8 slash commands** | **5 thinking layers**

## License

MIT
