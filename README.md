# Scraper Service

A self-hosted, production-ready scraper service built with Node.js, Playwright-extra, and stealth plugin. Designed for Railway deployment with minimal resource usage.

## Features

- 🚀 Pre-warmed browser context pool for low latency
- 🥷 Stealth mode with anti-detection measures
- 🔒 Session support for stateful scraping
- 🚫 Asset blocking to reduce bandwidth (images, media, fonts, stylesheets, websockets)
- ⚡ Configurable concurrency limits
- 🐳 Docker-ready with minimal RAM footprint
- 📊 Structured logging with Pino (request IDs, timing metrics, error stacks)
- 🎭 Human-like behavior (random delays, scrolling)
- ❤️ Health checks with browser verification

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
    "waitUntil": "domcontentloaded",
    "userAgent": "Custom User Agent",
    "sessionId": "optional-session-123",
    "cookies": [
      {
        "name": "session",
        "value": "abc123",
        "domain": ".example.com",
        "path": "/",
        "httpOnly": true,
        "secure": true
      }
    ]
  }'
```

**Request Body:**
- `url` (required): Target URL to scrape
- `blockAssets` (optional, default: true): Block images/media/fonts/stylesheets/websockets
- `waitUntil` (optional, default: "domcontentloaded"): Playwright wait strategy (domcontentloaded/networkidle/load)
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

Health check endpoint with browser verification.

```bash
curl http://localhost:3000/healthz
# Response: 
{
  "ok": true,
  "cached": false,
  "poolSize": 3,
  "poolAvailable": 2
}
```

### GET /version

Runtime version information.

```bash
curl http://localhost:3000/version
# Response:
{
  "version": "1.0.0",
  "node": "v20.11.0",
  "playwright": "^1.45.3",
  "chromium": "embedded",
  "uptime": 3600,
  "env": "production"
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `HEADLESS` | true | Run browser in headless mode |
| `POOL_SIZE` | 3 | Number of pre-warmed contexts per container |
| `NAV_TIMEOUT_MS` | 30000 | Navigation timeout in milliseconds |
| `SESSION_TTL_MS` | 300000 | Session lifetime (5 minutes) |
| `CONCURRENCY_LIMIT` | 3 | Max concurrent requests per container |
| `PROXY` | null | Optional proxy server URL (http://user:pass@host:port) |
| `LOG_LEVEL` | info | Logging level (debug/info/warn/error) |

## Railway Deployment Guide

### Recommended Railway Configuration

#### Plan & Resources
- **Recommended Plan**: Hobby ($5/month) or Pro ($20/month)
- **Memory**: 1GB minimum (2GB recommended for production)
- **CPU**: 1 vCPU minimum (2 vCPU recommended)
- **Replicas**: 2-5 for high availability

#### Deployment Steps

1. **Create a new Railway project**

2. **Deploy from GitHub**:
   ```bash
   # Push to GitHub
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin YOUR_GITHUB_REPO
   git push -u origin main
   ```

3. **Configure Railway Service**:
   
   In Railway dashboard, set these environment variables:
   
   ```env
   # Basic Configuration
   PORT=3000
   NODE_ENV=production
   
   # Performance Tuning (per container)
   POOL_SIZE=3              # 2-4 depending on memory
   CONCURRENCY_LIMIT=3      # Match or slightly below POOL_SIZE
   NAV_TIMEOUT_MS=45000     # Increase for slow sites
   
   # Optional Proxy Configuration
   PROXY=http://username:password@proxy.example.com:8080
   
   # Logging
   LOG_LEVEL=info
   ```

4. **Configure Health Checks** in Railway:
   ```yaml
   Path: /healthz
   Method: GET
   Interval: 30s
   Timeout: 10s
   Success Threshold: 1
   Failure Threshold: 3
   ```

5. **Enable Horizontal Scaling**:
   - Go to Settings → Scaling
   - Set Replicas: 2-5
   - Enable Auto-scaling (if on Pro plan)

### Scaling Configuration

#### Vertical Scaling (Single Container)
Best for: Low traffic, cost optimization

```env
# 512MB RAM Container
POOL_SIZE=2
CONCURRENCY_LIMIT=2

# 1GB RAM Container
POOL_SIZE=3
CONCURRENCY_LIMIT=3

# 2GB RAM Container
POOL_SIZE=5
CONCURRENCY_LIMIT=4
```

#### Horizontal Scaling (Multiple Containers)
Best for: High traffic, high availability

```env
# Per Container (with 3 replicas)
POOL_SIZE=3
CONCURRENCY_LIMIT=3
# Total capacity: 9 concurrent requests
```

**Scaling Formula:**
- Total Capacity = Replicas × CONCURRENCY_LIMIT
- Memory per container = 200MB (base) + (POOL_SIZE × 100MB)

### Proxy Configuration

If you need to use a proxy (for IP rotation or geographic targeting):

```env
# HTTP/HTTPS Proxy
PROXY=http://proxy.example.com:8080

# Authenticated Proxy
PROXY=http://username:password@proxy.example.com:8080

# SOCKS5 Proxy
PROXY=socks5://proxy.example.com:1080
```

### Monitoring & Debugging

#### View Logs
```bash
# Railway CLI
railway logs -n 100

# Or use Railway dashboard logs viewer
```

#### Key Metrics to Monitor
- **Memory Usage**: Should stay below 80% of limit
- **Response Time**: Target < 5s for most sites
- **Pool Availability**: Should rarely hit 0
- **Error Rate**: Keep below 5%

#### Debug Mode
For troubleshooting, temporarily set:
```env
LOG_LEVEL=debug
HEADLESS=false  # Only in development
```

### Performance Optimization Tips

1. **Cold Start Mitigation**:
   - Keep at least 1 replica always running
   - Use POOL_SIZE >= 2 for pre-warmed contexts

2. **Memory Management**:
   - Monitor memory with `/healthz` endpoint
   - Reduce POOL_SIZE if OOM errors occur
   - Enable swap if available (Railway Pro)

3. **Request Optimization**:
   - Use `blockAssets=true` (saves 40-60% bandwidth)
   - Set `waitUntil="domcontentloaded"` for faster responses
   - Reuse sessions for authenticated scraping

4. **High Traffic Handling**:
   ```env
   # Configuration for 100+ req/min
   Replicas=5
   POOL_SIZE=3
   CONCURRENCY_LIMIT=3
   # Total: 15 concurrent requests
   ```

## Architecture

```
┌─────────────────────────────────────────────┐
│              Load Balancer                   │
│               (Railway)                      │
└───────┬──────────────┬──────────────┬───────┘
        │              │              │
   ┌────▼────┐    ┌────▼────┐   ┌────▼────┐
   │Replica 1│    │Replica 2│   │Replica 3│
   └────┬────┘    └────┬────┘   └────┬────┘
        │              │              │
┌───────▼──────────────▼──────────────▼────────┐
│         Per Container Resources:              │
│                                               │
│  ┌──────────────────────────────────────┐    │
│  │         Browser Instance             │    │
│  └────────────┬─────────────────────────┘    │
│               │                               │
│      ┌────────▼────────┐                     │
│      │  Generic Pool   │                     │
│      │  (POOL_SIZE)    │                     │
│      │   Anonymous     │                     │
│      │   Contexts      │                     │
│      └─────────────────┘                     │
│                                               │
│      ┌─────────────────┐                     │
│      │  Session Map    │                     │
│      │ (SESSION_MAX)   │                     │
│      │   Dedicated     │                     │
│      │   Contexts      │                     │
│      └─────────────────┘                     │
│                                               │
│      ┌─────────────────┐                     │
│      │   Semaphore     │                     │
│      │(CONCURRENCY_    │                     │
│      │    LIMIT)       │                     │
│      └─────────────────┘                     │
└───────────────────────────────────────────────┘
```

## Troubleshooting

### High Memory Usage
```env
# Reduce pool size
POOL_SIZE=2
# Ensure headless mode
HEADLESS=true
# Check for memory leaks in sessions
SESSION_TTL_MS=180000  # Reduce to 3 minutes
```

### Timeout Errors
```env
# Increase navigation timeout
NAV_TIMEOUT_MS=60000
# Reduce wait strategy
waitUntil="domcontentloaded"  # in request
```

### Detection Issues
- Rotate user agents per request
- Use residential proxies
- Add more random delays
- Disable asset blocking for specific sites

### Railway-Specific Issues

**Build Failures:**
- Ensure Dockerfile is in root directory
- Check Railway build logs for missing dependencies

**OOM Kills:**
- Reduce POOL_SIZE
- Increase memory limit in Railway
- Monitor with `railway logs`

**Slow Cold Starts:**
- Keep minimum 1 replica always running
- Use health checks to keep warm
- Consider Railway's "Always On" feature

## Production Checklist

- [ ] Set appropriate POOL_SIZE for your memory limit
- [ ] Configure health checks in Railway
- [ ] Set up monitoring/alerting
- [ ] Enable horizontal scaling (2+ replicas)
- [ ] Configure proxy if needed
- [ ] Set LOG_LEVEL=info (not debug)
- [ ] Test with your target sites
- [ ] Monitor memory usage for first 24h
- [ ] Document rate limits for your use case
