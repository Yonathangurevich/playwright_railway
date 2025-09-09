# Scraper Service

A self-hosted, production-ready scraper service built with Node.js, Playwright-extra, and stealth plugin. Designed for Railway deployment with minimal resource usage.

## Features

- 🚀 Pre-warmed browser context pool for low latency
- 🥷 Stealth mode to avoid detection
- 🔒 Session support for stateful scraping
- 🚫 Asset blocking to reduce bandwidth
- ⚡ Configurable concurrency limits
- 🐳 Docker-ready with minimal RAM footprint
- 📊 Structured logging with Pino

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Or with custom settings
POOL_SIZE=5 NAV_TIMEOUT_MS=60000 npm run dev
```

### Docker

```bash
# Build image
docker build -t scraper-service .

# Run container
docker run -p 3000:3000 \
  -e POOL_SIZE=3 \
  -e HEADLESS=true \
  scraper-service
```

## API Endpoints

### POST /solve

Scrape a URL and return rendered HTML.

```bash
curl -X POST http://localhost:3000/solve \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "blockAssets": true,
    "waitUntil": "networkidle",
    "userAgent": "Custom User Agent",
    "sessionId": "optional-session-123",
    "cookies": [
      {
        "name": "session",
        "value": "abc123",
        "domain": ".example.com"
      }
    ]
  }'
```

**Request Body:**
- `url` (required): Target URL to scrape
- `blockAssets` (optional, default: true): Block images/media/fonts
- `waitUntil` (optional): Playwright wait strategy (load/domcontentloaded/networkidle)
- `userAgent` (optional): Custom user agent string
- `sessionId` (optional): Reuse browser context across requests
- `cookies` (optional): Array of cookie objects

**Response:**
```json
{
  "url": "https://example.com/final-url",
  "status": 200,
  "html": "<!DOCTYPE html>..."
}
```

### GET /healthz

Health check endpoint.

```bash
curl http://localhost:3000/healthz
# Response: {"ok":true}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `HEADLESS` | true | Run browser in headless mode |
| `POOL_SIZE` | 3 | Number of pre-warmed contexts |
| `NAV_TIMEOUT_MS` | 30000 | Navigation timeout in milliseconds |
| `SESSION_TTL_MS` | 300000 | Session lifetime (5 minutes) |
| `CONCURRENCY_LIMIT` | 3 | Max concurrent requests |
| `PROXY` | null | Optional proxy server URL |
| `LOG_LEVEL` | info | Logging level (debug/info/warn/error) |

## Railway Deployment

1. **Create a new Railway project**

2. **Deploy from GitHub** (recommended):
   - Push this code to a GitHub repository
   - Connect Railway to your repo
   - Railway will auto-detect the Dockerfile

3. **Configure environment variables** in Railway dashboard:
   ```
   POOL_SIZE=2
   NAV_TIMEOUT_MS=45000
   CONCURRENCY_LIMIT=2
   ```
   
   💡 **Railway Tips:**
   - Start with `POOL_SIZE=2` for 512MB RAM instances
   - Increase to `POOL_SIZE=3-4` for 1GB+ RAM
   - Monitor memory usage and adjust accordingly

4. **Add a custom domain** or use the provided Railway domain

## Performance Tuning

### Memory Optimization
- Each browser context uses ~50-100MB
- Calculate: Base (~200MB) + (POOL_SIZE × 75MB)
- For 512MB container: Use POOL_SIZE=2
- For 1GB container: Use POOL_SIZE=3-5

### Latency Optimization
- Pre-warmed contexts eliminate cold starts
- Asset blocking reduces page load time by 40-60%
- Session reuse avoids login flows

### Concurrency
- Set CONCURRENCY_LIMIT ≤ POOL_SIZE
- Higher values risk OOM errors
- Monitor response times and adjust

## Architecture

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ HTTP POST /solve
       ▼
┌─────────────┐
│  Express    │
│   Server    │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│  Semaphore  │────▶│ Context Pool │
│  (Limiter)  │     │  (generic-   │
└─────────────┘     │    pool)     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Playwright  │
                    │   Browser    │
                    │  + Stealth   │
                    └──────────────┘
```

## Troubleshooting

### High Memory Usage
- Reduce POOL_SIZE
- Enable HEADLESS=true
- Increase container RAM

### Timeout Errors
- Increase NAV_TIMEOUT_MS
- Check target site performance
- Verify network connectivity

### Detection Issues
- Stealth plugin is active by default
- Rotate user agents
- Use residential proxies if needed

## License

MIT
