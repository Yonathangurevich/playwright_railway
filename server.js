const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const genericPool = require('generic-pool');
const pino = require('pino');
const crypto = require('crypto');

// Apply stealth plugin
chromium.use(StealthPlugin());

// Configuration from ENV
const PORT = parseInt(process.env.PORT || '3000');
const HEADLESS = process.env.HEADLESS !== 'false';
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '3');
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '30000');
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '300000');
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '3');
const PROXY = process.env.PROXY || null;

// Logger setup
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined
});

// Global browser instance
let browser = null;

// Session management
const sessions = new Map();
const sessionLastAccess = new Map();

// Concurrency control semaphore
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const resolve = this.queue.shift();
      resolve();
    }
  }
}

const semaphore = new Semaphore(CONCURRENCY_LIMIT);

// Context pool factory
const contextPool = genericPool.createPool({
  create: async () => {
    logger.debug('Creating new browser context');
    const contextOptions = {};
    if (PROXY) {
      contextOptions.proxy = { server: PROXY };
    }
    return await browser.newContext(contextOptions);
  },
  destroy: async (context) => {
    logger.debug('Destroying browser context');
    await context.close();
  },
  validate: async (context) => {
    // Basic validation - check if context is still usable
    try {
      await context.pages();
      return true;
    } catch {
      return false;
    }
  }
}, {
  min: POOL_SIZE,
  max: POOL_SIZE,
  testOnBorrow: true,
  acquireTimeoutMillis: 10000,
  evictionRunIntervalMillis: 30000,
  idleTimeoutMillis: 60000
});

// Session cleanup task
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, lastAccess] of sessionLastAccess.entries()) {
    if (now - lastAccess > SESSION_TTL_MS) {
      logger.info({ sessionId }, 'Cleaning expired session');
      const context = sessions.get(sessionId);
      if (context) {
        context.close().catch(err => 
          logger.error({ err, sessionId }, 'Error closing session context')
        );
      }
      sessions.delete(sessionId);
      sessionLastAccess.delete(sessionId);
    }
  }
}, 60000); // Run every minute

// Express app
const app = express();
app.use(express.json());

// Request ID middleware
app.use((req, res, next) => {
  req.id = crypto.randomBytes(8).toString('hex');
  req.startTime = Date.now();
  next();
});

// Health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// Main solve endpoint
app.post('/solve', async (req, res) => {
  const { url, userAgent, cookies, waitUntil, sessionId, blockAssets = true } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  logger.info({ requestId: req.id, url, sessionId }, 'Solving URL');
  
  let context = null;
  let page = null;
  let fromPool = false;
  
  try {
    await semaphore.acquire();
    
    // Session handling
    if (sessionId) {
      context = sessions.get(sessionId);
      if (context) {
        sessionLastAccess.set(sessionId, Date.now());
        logger.debug({ sessionId }, 'Reusing session context');
      } else {
        // Create new session context
        const contextOptions = {};
        if (PROXY) contextOptions.proxy = { server: PROXY };
        context = await browser.newContext(contextOptions);
        sessions.set(sessionId, context);
        sessionLastAccess.set(sessionId, Date.now());
        logger.debug({ sessionId }, 'Created new session context');
      }
    } else {
      // Use pooled context
      context = await contextPool.acquire();
      fromPool = true;
    }
    
    // Create page
    page = await context.newPage();
    
    // Set user agent if provided
    if (userAgent) {
      await page.setExtraHTTPHeaders({ 'User-Agent': userAgent });
    }
    
    // Set cookies if provided
    if (cookies && Array.isArray(cookies)) {
      await context.addCookies(cookies);
    }
    
    // Asset blocking
    if (blockAssets) {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }
    
    // Navigate with timeout
    const response = await page.goto(url, {
      waitUntil: waitUntil || 'networkidle',
      timeout: NAV_TIMEOUT_MS
    });
    
    // Get final URL and HTML
    const finalUrl = page.url();
    const html = await page.content();
    
    const duration = Date.now() - req.startTime;
    logger.info({ 
      requestId: req.id, 
      url, 
      finalUrl, 
      status: response?.status(), 
      duration 
    }, 'Request completed');
    
    res.json({
      url: finalUrl,
      status: response?.status() || 200,
      html
    });
    
  } catch (error) {
    const duration = Date.now() - req.startTime;
    logger.error({ 
      requestId: req.id, 
      url, 
      error: error.message, 
      duration 
    }, 'Request failed');
    
    res.status(500).json({
      error: error.message,
      type: error.name
    });
    
  } finally {
    // Cleanup
    if (page) {
      await page.close().catch(err => 
        logger.error({ err }, 'Error closing page')
      );
    }
    
    if (fromPool && context) {
      contextPool.release(context);
    }
    
    semaphore.release();
  }
});

// Startup
async function start() {
  try {
    logger.info('Starting scraper service...');
    
    // Launch browser
    const launchOptions = {
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    };
    
    if (PROXY) {
      launchOptions.proxy = { server: PROXY };
    }
    
    browser = await chromium.launch(launchOptions);
    logger.info({ headless: HEADLESS, poolSize: POOL_SIZE }, 'Browser launched');
    
    // Pre-warm the pool
    await contextPool.ready();
    logger.info('Context pool initialized');
    
    // Start server
    app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT }, 'Server listening');
    });
    
  } catch (error) {
    logger.fatal({ error: error.message }, 'Failed to start');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  
  // Close all sessions
  for (const context of sessions.values()) {
    await context.close().catch(() => {});
  }
  
  // Drain and close pool
  await contextPool.drain();
  await contextPool.clear();
  
  // Close browser
  if (browser) {
    await browser.close();
  }
  
  process.exit(0);
});

// Start the service
start();
