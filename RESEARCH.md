# Briefing Agent - Codebase Research Document

## Overview
**Project**: CC & Deals Briefing Agent - A credit card and deals monitoring/briefing system
**Architecture**: Turborepo monorepo with Node.js API and Next.js Dashboard
**Primary Function**: Monitors WhatsApp groups, Telegram channels, forums (TechnoFino, DesiDime), Reddit, YouTube, RSS feeds, and Email for credit card/deals content, then generates AI-powered daily briefs via Telegram/WhatsApp

---

## Tech Stack

### Runtime & Build
- **Runtime**: Node.js 20 (LTS) - `node:20-slim` in production
- **Package Manager**: npm with Turborepo for monorepo management
- **Build**: Docker multi-stage build (builder → runner)
- **Process Manager**: Native Node.js (no PM2, runs directly in container)

### Core Dependencies (API)
| Package | Version | Purpose |
|---------|---------|---------|
| `@whiskeysockets/baileys` | ^6.7.18 | WhatsApp Web API (socket-based, Puppeteer-free) |
| `better-sqlite3` | ^11.7.0 | High-performance SQLite database |
| `telegraf` | ^4.16.3 | Telegram Bot API framework |
| `@google/generative-ai` | ^0.11.0 | Google Gemini AI for summarization |
| `axios` | ^1.7.2 | HTTP client for scrapers |
| `cheerio` | ^1.0.0 | Server-side HTML parsing |
| `puppeteer-extra` + stealth | ^3.3.6 | Headless Chrome for web scraping (TechnoFino, DesiDime) |
| `yt-dlp` (system) | - | YouTube transcript/caption extraction |
| `imapflow` | ^1.4.2 | Email IMAP scraping |
| `node-cron` | ^3.0.3 | Scheduled briefings (IST timezone) |
| `express` | ^4.19.2 | REST API + static file serving |

### Dashboard (Next.js 15)
- **Framework**: Next.js 15.1.0 with App Router
- **UI**: Radix UI + Tailwind CSS + shadcn/ui patterns
- **State**: TanStack Query (React Query) v5
- **Language**: TypeScript + React 19

### Database
- **Engine**: SQLite (better-sqlite3) with WAL mode
- **Schema**: Messages, sources, categories, schedules, scraper health, cookies, briefs, summaries, source instances
- **Persistence**: Docker volume `/app/data` (mapped to `cc_brief_data`)

---

## Architecture

### Monorepo Structure
```
briefing-agent/
├── apps/
│   ├── api/                 # Main Node.js application (Express + background workers)
│   │   ├── src/
│   │   │   ├── index.js           # Main entry point (1107 lines)
│   │   │   ├── database.js        # SQLite layer (827 lines, pre-compiled statements)
│   │   │   ├── whatsapp.js        # Baileys WhatsApp listener (513 lines)
│   │   │   ├── telegram-bot.js    # Telegram bot dispatcher (425 lines)
│   │   │   ├── telegram-user.js   # Telegram user listener (GramJS)
│   │   │   ├── summarizer.js      # AI summarization with fallback chain (446 lines)
│   │   │   ├── scheduler.js       # Cron-based scheduler (242 lines)
│   │   │   ├── logger.js          # Sanitizing logger (75 lines)
│   │   │   ├── browser-manager.js # Puppeteer singleton (126 lines)
│   │   │   └── scrapers/          # Modular scrapers
│   │   │       ├── web-scraper.js      # TechnoFino, DesiDime, Reddit (554 lines)
│   │   │       ├── youtube-scraper.js  # YouTube RSS + captions + audio (549 lines)
│   │   │       ├── api-scraper.js      # Generic JSON API (78 lines)
│   │   │       ├── rss-scraper.js      # RSS/Atom feeds (155 lines)
│   │   │       └── email-scraper.js    # IMAP email (149 lines)
│   │   └── public/            # Next.js static export (served by Express)
│   └── dashboard/             # Next.js 15 frontend
│       ├── src/app/           # App Router pages (Dashboard, Sources, Categories, etc.)
│       └── src/components/    # UI components (shadcn-style)
├── packages/
│   └── types/                 # Shared Zod schemas + TypeScript types
├── docker-compose.yaml        # Coolify deployment config
├── Dockerfile                 # Multi-arch (amd64/arm64) build
└── turbo.json                 # Turborepo config
```

### Data Flow
```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Data Sources   │────▶│  Scrapers/Listeners │────▶│  SQLite Database │
│  (WhatsApp,     │     │  (web, yt, rss,   │     │  (messages,      │
│   Telegram,     │     │   email, api)     │     │   sources, etc)  │
│   Forums, YT)   │     └────────┬─────────┘     └────────┬────────┘
└─────────────────┘              │                      │
                                 ▼                      ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │  Summarizer AI  │◀───│  Scheduler      │
                        │  (Gemini + OR)  │     │  (cron rules)   │
                        └────────┬────────┘     └────────┬────────┘
                                 │                      │
                                 ▼                      ▼
                        ┌─────────────────────────────────────────┐
                        │  Delivery: Telegram Bot / WhatsApp      │
                        └─────────────────────────────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │  Web Dashboard  │
                        │  (Next.js)      │
                        └─────────────────┘
```

---

## Key Components Analysis

### 1. Database Layer (`database.js` - 827 lines)
**Pattern**: Pre-compiled prepared statements for performance
- **WAL mode** enabled for concurrent reads/writes
- **Foreign keys** enforced
- **Migrations**: Automatic schema evolution via `ALTER TABLE` in `_initSchema()`
- **Tables**:
  - `messages` - Core message storage with source_type indexing
  - `sources` - Monitored sources (WhatsApp groups, Telegram channels, forums, etc.)
  - `categories` - Briefing categories (cc, deals, custom)
  - `schedule_rules` - Per-category cron expressions
  - `scraper_health` - Operational metrics per source
  - `cookies_store` - Site authentication cookies (DB + file backup)
  - `source_instances` - Normalized source→group mapping
  - `daily_briefs` / `summary_log` - Historical briefs

**Key Methods**:
- `getTodayMessages(sourcePrefix)` - IST day boundary aware
- `smartSample()` - Keyword-weighted message sampling for AI
- `upsertScraperHealth()` - Tracks success/error rates

### 2. WhatsApp Listener (`whatsapp.js` - 513 lines)
**Library**: `@whiskeysockets/baileys` (WebSocket-based, no Puppeteer)
**Auth**: Multi-file auth state in `/app/data/baileys_auth`
**Features**:
- QR code generation (terminal + admin WhatsApp)
- Group/Newsletter discovery and name mapping
- Message processing with `instanceFk` threading
- Session corruption detection and auto-recovery
- **Critical Bug Fixed** (commit 8f5c092): "Over 2000 messages into the future" was incorrectly treated as fatal session corruption, causing infinite wipe/restart loops. Now handled as recoverable counter mismatch.

**Event Handlers**:
- `messaging-history.set` - Historical sync on reconnect
- `messages.upsert` - Real-time incoming messages
- `connection.update` - QR, connect, disconnect, loggedOut

### 3. Telegram Bot (`telegram-bot.js` - 425 lines)
**Library**: Telegraf
**Per-Category Instances**: Each category (cc, deals, custom) gets its own bot
**Commands**:
- `/brief` - On-demand summary
- `/status` - Agent health + active groups
- `/groups` - All monitored sources with activity
- `/ask <question>` - AI Q&A over historical messages
- `/search <keyword>` - Full-text search
- `/stats` - 7-day statistics
- `/total` - All-time message count
- `/test` - Latest message verification per source

**HTML Safety**: Single-pass tag balancer for Telegram HTML parsing

### 4. Summarizer (`summarizer.js` - 446 lines)
**Fallback Chain** (16 models):
1. Gemini 2.5 Flash (Primary)
2. Gemini 3.5 Flash (Frontier)
3. Gemini 3.1 Flash Lite (Fastest)
4. Gemini 2.5 Pro (Reasoning)
5. ... 11 OpenRouter free models (Hermes, Nemotron, Llama, Qwen, Gemma, GPT-OSS)

**Features**:
- Token estimation & batch processing (>200K tokens)
- Smart sampling (keyword-weighted, 2000 msg default)
- Deal URL extraction & mandatory linking
- Custom prompts per category
- HTML repair for Telegram compatibility

### 5. Scheduler (`scheduler.js` - 242 lines)
**Per-Category Rules**: Multiple cron expressions per category
**Defaults** (IST): 6 AM, 2 PM, 10 PM for both cc & deals
**Staggering**: 30-second delay between categories on global trigger
**DB Cleanup**: Daily 3 AM IST (30-day retention)

### 6. Scrapers (Modular, Independent Intervals)

| Scraper | Interval | Targets | Auth |
|---------|----------|---------|------|
| WebScraper | 15 min (DesiDime/Reddit), 45 min (TechnoFino) | Forums, Reddit | Puppeteer + DB cookies |
| YouTubeScraper | 60 min | Channel RSS | yt-dlp + Gemini audio |
| ApiScraper | 5 min | JSON APIs | None/Headers |
| RssScraper | 10 min | RSS/Atom feeds | None |
| EmailScraper | 5 min | IMAP (Gmail) | IMAP credentials |

**Cookie Management**: DB primary, file backup (`site_cookies.json`). Netscape + JSON format support.

---

## Deployment (Coolify + Docker)

### Dockerfile (Multi-stage)
1. **Builder**: `node:20` - npm install + Next.js build
2. **Runner**: `node:20-slim` - Chromium, yt-dlp, ffmpeg, python3
3. **User**: Non-root `agentuser` with `/app/data` + `/app/logs` volumes

### docker-compose.yaml
```yaml
services:
  cc-brief-agent:
    image: sourabhjagga/briefing-agent-fresh:latest
    pull_policy: always
    volumes:
      - cc_brief_data:/app/data      # SQLite, baileys_auth, cookies
      - cc_brief_logs:/app/logs
    ports: "3456:3000"
    environment: (all env vars from .env)
    depends_on: warp-proxy (healthcheck)
    
  warp-proxy:
    image: ghcr.io/mon-ius/docker-warp-socks:v6
    healthcheck: nc -z localhost 9091
```

### GitHub Actions (`.github/workflows/docker-publish-fresh.yml`)
- **Trigger**: Push to main, manual dispatch
- **Multi-arch**: linux/amd64 + linux/arm64 (QEMU)
- **Cache**: GHA layer caching scoped to branch
- **Verification**: Manifest inspection confirms arm64 present

---

## Environment Variables (from `.env.example`)

### Required
| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Main CC bot from @BotFather |
| `TELEGRAM_CHAT_ID` | Your personal chat ID for summaries |
| `GEMINI_API_KEY` | Google AI Studio key |

### Optional
| Variable | Purpose |
|----------|---------|
| `DEALS_BOT_TOKEN` | Separate bot for Deals category |
| `OPENROUTER_API_KEY` | Fallback AI models |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | Personal API for private channel scraping |
| `WHATSAPP_ADMIN_JID` | Admin WhatsApp for QR alerts |
| `TELEGRAM_PROXY` | SOCKS5/HTTP proxy for Telegram |
| `EMAIL_IMAP_HOST/PORT/USER/PASSWORD` | Email scraping |
| `TECHNOFINO_USERNAME/PASSWORD` | Forum credentials (cookies |
| `DESIDIME_USERNAME/PASSWORD` | Forum credentials |

---

## Dashboard Features (Next.js 15)

### Pages
| Route | Purpose |
|-------|---------|
| `/` | Dashboard - health, stats, scraper health table |
| `/sources` | Source CRUD (name, ID, type, category, URL, private) |
| `/categories` | Category management (slug, display, bot token, chat ID, AI prompt, delivery channel) |
| `/schedules` | Per-category cron rules |
| `/cookies` | Cookie import/export (JSON + Netscape) per site |
| `/telegram` | OTP login, group discovery, session management |
| `/whatsapp` | Group discovery, QR code display |
| `/settings` | System configuration |

### API Endpoints (Express, served at `/api/*`)
- **Sources**: `GET/POST/PATCH/DELETE /api/sources`
- **Categories**: `GET/POST/PATCH/DELETE /api/categories` + `/test`
- **Source Types**: `GET/POST/PATCH/DELETE /api/source-types`
- **Schedules**: `GET/POST/PATCH/DELETE /api/schedules` + `/trigger`
- **Cookies**: `GET/POST/DELETE /api/cookies` + `/import` + `/status`
- **Telegram**: `/api/telegram/*` (OTP, discover, logout)
- **WhatsApp**: `/api/whatsapp/*` (discover, sources)
- **Webhooks**: `POST /api/webhook/:sourceId` (HMAC verified)
- **Health**: `/health`, `/api/health`, `/api/stats`, `/api/source-stats`

---

## Critical Bugs Fixed (Recent History)

| Commit | Issue | Fix |
|--------|-------|-----|
| `8f5c092` | WhatsApp infinite restart loop | "Over 2000 messages into the future" is recoverable counter mismatch, not session corruption |
| `bdfb7f8` | WhatsApp session wipe on counter mismatch | Added specific error handling to skip bad messages instead of wiping auth |
| `efceb09` | Scraper type matching | Changed `includes()` to `endsWith()` for source type filtering |
| `426f781` | Type error in health aggregation | Fixed number vs string comparison |
| `e92d12e` | 4 bugs: WhatsApp groups, cookie delete, health agg, telegram session | Multiple targeted fixes |
| `c8c66d2` | "No updates today" false positives | Hardened crash resilience, fixed root causes |

---

## Known Patterns & Conventions

### Code Style
- **CommonJS** in API (`require`/`module.exports`)
- **ESM/TypeScript** in Dashboard (`import`/`export`)
- **Pre-compiled SQL** - All queries prepared at startup
- **IST Timezone** - All scheduling in Asia/Kolkata
- **Category Prefixing** - Source types: `cc-forums`, `deals-whatsapp`, etc.

### Error Handling
- Scrapers: Try/catch per source, health tracking, alert on N consecutive failures
- AI: 16-model fallback chain, batch processing for large inputs
- WhatsApp: Session corruption detection with auto-wipe + QR regeneration
- Telegram: Auth guard on bot commands (chat ID verification)

### Logging
- **File**: `/app/logs/agent.log` (JSON lines with timestamp)
- **Sanitization**: WhatsApp session keys, noise protocol data redacted
- **Levels**: INFO, WARN, ERROR, DEBUG (dev only)

---

## Development Workflow

### Local Development
```bash
# Install dependencies
npm install

# Run API (with .env)
cd apps/api && npm run dev

# Run Dashboard
cd apps/dashboard && npm run dev

# Build all
npm run build
```

### Testing
- No formal test suite (manual verification via dashboard + Telegram)
- `/test` bot command verifies all sources
- Health endpoints for monitoring

### Database
- SQLite file at `/app/data/messages.db`
- Auto-migrations on startup
- WAL mode for concurrency

---

## Pain Points & Technical Debt

1. **No automated tests** - Relies on manual verification
2. **Single-process architecture** - All scrapers, listeners, scheduler, API in one Node process
3. **Memory pressure** - Puppeteer + yt-dlp + multiple intervals in one container
4. **WhatsApp Baileys version pinning** - Hardcoded fallback version `[2, 3000, 1015024227]`
5. **Cookie management split** - DB + file system dual-write
6. **No TypeScript in API** - JavaScript only, JSDoc for types
7. **Hardcoded site configs** - TechnoFino/DesiDime selectors in WebScraper

---

## Security Considerations

- **Non-root container user** (`agentuser`)
- **Secrets in env vars** (Coolify injects at deploy)
- **HMAC verification** on webhook endpoints
- **Chat ID authorization** on Telegram bot commands
- **Log sanitization** removes WhatsApp crypto keys
- **HTTPS enforced** via Coolify + Cloudflare (typical)

---

## Scaling Considerations

### Horizontal Scaling Blockers
- SQLite file-based (single writer)
- Baileys auth state in local filesystem
- Puppeteer browser singleton
- In-memory scheduler (node-cron)

### Vertical Scaling Path
- Increase container memory (Oracle ARM 4GB+ recommended)
- Externalize SQLite to PostgreSQL (schema compatible)
- Extract scrapers to separate workers (BullMQ/Redis)
- Use Baileys multi-file auth with shared volume

---

## Summary

This is a **production-grade, single-container monitoring agent** designed for Oracle Cloud ARM instances (via Coolify). It combines:
- **Real-time listeners** (WhatsApp, Telegram user)
- **Polling scrapers** (forums, Reddit, YouTube, RSS, Email, APIs)
- **AI summarization** with 16-model fallback
- **Per-category scheduling** with IST timezone
- **Web dashboard** for full CRUD management
- **Persistent sessions** via Docker volumes

The architecture prioritizes **operational simplicity** (single container, SQLite, file-based auth) over horizontal scalability, which fits the "personal/team briefing agent" use case perfectly.