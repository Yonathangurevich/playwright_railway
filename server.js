const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const genericPool = require('generic-pool');
const pino = require('pino');
const crypto = require('crypto');

// Configure and apply stealth plugin with all evasions
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('iframe.contentWindow');
stealth.enabledEvasions.delete('media.codecs');
chromium.use(stealth);

// Configuration from ENV
const PORT = parseInt(process.env.PORT || '3000');
const HEADLESS = process.env.HEADLESS !== 'false';
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '3');
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || '30000');
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '300000');
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '3');
const PROXY = process.env.PROXY || null;
const REQUEST_TIMEOUT_MS = NAV_TIMEOUT_MS + 5000; // Server timeout buffer

// Default headers for stealth
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

// Logger setup
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: { colorize: true }
  } : undefined
});

// Service state
let browser = null;
let isReady = false;
let isShuttingDown = false;
let server = null;

// Session management
const sessions = new Map();
const sessionLastAccess = new Map();

// Error taxonomy
class ServiceError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = 'ServiceError';
  }
}

const ErrorTypes = {
  BAD_REQUEST: (msg, hint) => new ServiceError('BAD_REQUEST', msg, hint),
  TIMEOUT: (msg, hint) => new ServiceError('TIMEOUT', msg, hint),
  PAGE_ERROR: (msg, hint) => new ServiceError('PAGE_ERROR', msg, hint),
  BROWSER_ERROR: (msg, hint) => new ServiceError('BROWSER_ERROR', msg, hint),
  INTERNAL: (msg, hint) => new ServiceError('INTERNAL', msg, hint)
};

// Utility: random delay
const randomDelay = (min, max) => {
  return new Promise(resolve => {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    setTimeout(resolve, delay);
  });
};

// Utility: UUID v4 generator
const generateRequestId = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

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

  drain() {
    return new Promise((resolve) => {
      if (this.current === 0) {
        resolve();
      } else {
        const checkDrained = setInterval(() => {
          if (this.current === 0) {
            clearInterval(checkDrained);
            resolve();
          }
        }, 100);
      }
    });
  }
}

const semaphore = new Semaphore(CONCURRENCY_LIMIT);

// Context pool factory
const contextPool = genericPool.createPool({
  create: async () => {
    logger.debug('Creating new browser context');
    const contextOptions = {
      userAgent: DEFAULT_USER_AGENT,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      hasTouch: false,
      extraHTTPHeaders: {
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE
      }
    };
    
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
const sessionCleanupInterval = setInterval(() => {
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

// Request ID middleware - add X-Request-Id header
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || generateRequestId();
  req.startTime = Date.now();
  res.setHeader('X-Request-Id', req.id);
  next();
});

// Ready check middleware
app.use((req, res, next) => {
  if (req.path === '/healthz' || req.path === '/version') {
    return next();
  }
  
  if (isShuttingDown) {
    return res.status(503).json({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service is shutting down',
      hint: 'Service is gracefully shutting down, please retry'
    });
  }
  
  if (!isReady) {
    return res.status(503).json({
      code: 'SERVICE_NOT_READY',
      message: 'Service is starting up',
      hint: 'Browser pool is still warming up, please wait'
    });
  }
  
  next();
});

// Version endpoint
app.get('/version', (req, res) => {
  const packageJson = require('./package.json');
  res.json({
    version: packageJson.version,
    node: process.version,
    playwright: packageJson.dependencies.playwright,
    chromium: chromium._launcher?._browserPath || 'embedded',
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'production',
    ready: isReady
  });
});

// Health check with browser verification
let healthCheckCache = { ok: false, lastCheck: 0 };
const HEALTH_CACHE_TTL = 5000; // 5 seconds cache

app.get('/healthz', async (req, res) => {
  const now = Date.now();
  
  // Return cached result if fresh
  if (healthCheckCache.ok && (now - healthCheckCache.lastCheck) < HEALTH_CACHE_TTL) {
    return res.json({ 
      ok: true, 
      cached: true,
      ready: isReady,
      poolSize: contextPool.size,
      poolAvailable: contextPool.available
    });
  }
  
  // If not ready, return not ok
  if (!isReady || !browser) {
    return res.status(503).json({
      ok: false,
      ready: false,
      message: 'Service not ready'
    });
  }
  
  // Verify browser is alive
  let testContext = null;
  let testPage = null;
  
  try {
    // Quick timeout for health check
    const healthTimeout = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Health check timeout')), 1000)
    );
    
    const healthTest = async () => {
      testContext = await contextPool.acquire();
      testPage = await testContext.newPage();
      await testPage.close();
      contextPool.release(testContext);
      return true;
    };
    
    await Promise.race([healthTest(), healthTimeout]);
    
    // Update cache
    healthCheckCache = { ok: true, lastCheck: now };
    
    res.json({ 
      ok: true,
      cached: false,
      ready: isReady,
      poolSize: contextPool.size,
      poolAvailable: contextPool.available
    });
    
  } catch (error) {
    logger.error({ error: error.message }, 'Health check failed');
    healthCheckCache = { ok: false, lastCheck: now };
    
    // Cleanup on failure
    if (testPage) await testPage.close().catch(() => {});
    if (testContext) contextPool.release(testContext);
    
    res.status(503).json({ 
      ok: false,
      ready: isReady,
      error: error.message,
      poolSize: contextPool.size,
      poolAvailable: contextPool.available
    });
  }
});

// Main solve endpoint with timeout
app.post('/solve', async (req, res) => {
  const { 
    url, 
    userAgent, 
    cookies, 
    waitUntil = 'domcontentloaded', 
    sessionId, 
    blockAssets = true 
  } = req.body;
  
  // Input validation
  if (!url) {
    return res.status(400).json({
      code: 'BAD_REQUEST',
      message: 'Missing required field: url',
      hint: 'Please provide a valid URL to scrape'
    });
  }
  
  // URL validation
  try {
    new URL(url);
  } catch (error) {
    return res.status(400).json({
      code: 'BAD_REQUEST',
      message: 'Invalid URL format',
      hint: 'Please provide a valid URL with protocol (http:// or https://)'
    });
  }

  logger.info({ 
    requestId: req.id, 
    url, 
    sessionId, 
    blockAssets,
    userAgent: userAgent ? 'custom' : 'default'
  }, 'Processing request');
  
  let context = null;
  let page = null;
  let fromPool = false;
  let timeoutHandle = null;
  
  // Set server-level timeout
  const requestTimeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(ErrorTypes.TIMEOUT(
        'Request timeout exceeded',
        `Request took longer than ${REQUEST_TIMEOUT_MS}ms. Consider increasing NAV_TIMEOUT_MS or simplifying the request`
      ));
    }, REQUEST_TIMEOUT_MS);
  });
  
  const processRequest = async () => {
    await semaphore.acquire();
    
    // Session handling
    if (sessionId) {
      context = sessions.get(sessionId);
      if (context) {
        sessionLastAccess.set(sessionId, Date.now());
        logger.debug({ sessionId }, 'Reusing session context');
      } else {
        // Create new session context with stealth settings
        const contextOptions = {
          userAgent: userAgent || DEFAULT_USER_AGENT,
          locale: 'en-US',
          timezoneId: 'America/New_York',
          viewport: { width: 1920, height: 1080 },
          screen: { width: 1920, height: 1080 },
          deviceScaleFactor: 1,
          hasTouch: false,
          extraHTTPHeaders: {
            'Accept-Language': DEFAULT_ACCEPT_LANGUAGE
          }
        };
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
    
    // Set custom user agent if provided and not using session
    if (userAgent && !sessionId) {
      await page.setExtraHTTPHeaders({ 
        'User-Agent': userAgent,
        'Accept-Language': DEFAULT_ACCEPT_LANGUAGE
      });
    }
    
    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    });
    
    // Set cookies if provided
    if (cookies && Array.isArray(cookies)) {
      const formattedCookies = cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        httpOnly: cookie.httpOnly !== false,
        secure: cookie.secure !== false,
        sameSite: 'Lax'
      }));
      await context.addCookies(formattedCookies);
    }
    
    // Enhanced asset blocking
    if (blockAssets) {
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        const blockedTypes = ['image', 'media', 'font', 'stylesheet', 'websocket'];
        
        if (blockedTypes.includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
      logger.debug({ requestId: req.id }, 'Asset blocking enabled');
    }
    
    // Navigate with timeout
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: waitUntil,
        timeout: NAV_TIMEOUT_MS
      });
    } catch (error) {
      if (error.message.includes('timeout')) {
        throw ErrorTypes.TIMEOUT(
          `Navigation timeout after ${NAV_TIMEOUT_MS}ms`,
          'Page took too long to load. Try increasing NAV_TIMEOUT_MS or using waitUntil="domcontentloaded"'
        );
      }
      throw ErrorTypes.PAGE_ERROR(
        'Failed to navigate to page',
        error.message
      );
    }
    
    // Add human-like behavior
    try {
      // Small random delay
      await randomDelay(20, 80);
      
      // Tiny scroll to trigger lazy loading
      await page.evaluate(() => {
        window.scrollBy(0, Math.random() * 100 + 50);
      });
      
      // Another small delay
      await randomDelay(20, 80);
      
      // Scroll back up slightly
      await page.evaluate(() => {
        window.scrollBy(0, -(Math.random() * 30 + 10));
      });
      
    } catch (err) {
      // Ignore errors from human-like actions
      logger.debug({ err: err.message }, 'Human-like action failed (non-critical)');
    }
    
    // Wait a bit for any lazy-loaded content
    await page.waitForTimeout(100);
    
    // Get final URL and HTML
    let finalUrl, html;
    try {
      finalUrl = page.url();
      html = await page.content();
    } catch (error) {
      throw ErrorTypes.PAGE_ERROR(
        'Failed to extract page content',
        'Page may have been closed or navigated away unexpectedly'
      );
    }
    
    return { finalUrl, html, status: response?.status() || 200 };
  };
  
  try {
    const result = await Promise.race([processRequest(), requestTimeout]);
    
    // Clear timeout
    if (timeoutHandle) clearTimeout(timeoutHandle);
    
    const duration = Date.now() - req.startTime;
    
    // Add timing metrics
    const metrics = {
      requestId: req.id,
      url,
      finalUrl: result.finalUrl,
      status: result.status,
      duration,
      blockAssets,
      waitUntil,
      sessionId: sessionId || null,
      poolAvailable: contextPool.available
    };
    
    logger.info(metrics, 'Request completed');
    
    res.json({
      url: result.finalUrl,
      status: result.status,
      html: result.html
    });
    
  } catch (error) {
    // Clear timeout
    if (timeoutHandle) clearTimeout(timeoutHandle);
    
    const duration = Date.now() - req.startTime;
    
    // Determine appropriate status code and response
    let statusCode = 500;
    let errorResponse = {
      code: 'INTERNAL_ERROR',
      message: error.message
    };
    
    if (error instanceof ServiceError) {
      errorResponse.code = error.code;
      errorResponse.message = error.message;
      if (error.hint) errorResponse.hint = error.hint;
      
      switch (error.code) {
        case 'BAD_REQUEST':
          statusCode = 400;
          break;
        case 'TIMEOUT':
          statusCode = 408;
          break;
        case 'PAGE_ERROR':
        case 'BROWSER_ERROR':
          statusCode = 502;
          break;
        default:
          statusCode = 500;
      }
    }
    
    logger.error({ 
      requestId: req.id, 
      url,
      code: errorResponse.code,
      error: error.message,
      stack: error.stack,
      duration 
    }, 'Request failed');
    
    res.status(statusCode).json(errorResponse);
    
  } finally {
    // Cleanup
    if (page) {
      await page.close().catch(err => 
        logger.error({ err: err.message }, 'Error closing page')
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
    
    // Launch browser with stealth-optimized args
    const launchOptions = {
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-web-security',
        '--disable-infobars'
      ]
    };
    
    if (PROXY) {
      launchOptions.proxy = { server: PROXY };
    }
    
    browser = await chromium.launch(launchOptions);
    logger.info({ headless: HEADLESS }, 'Browser launched');
    
    // Pre-warm the pool
    logger.info({ poolSize: POOL_SIZE }, 'Pre-warming context pool...');
    const warmupPromises = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      warmupPromises.push(contextPool.acquire().then(ctx => {
        contextPool.release(ctx);
        logger.debug(`Context ${i + 1}/${POOL_SIZE} warmed`);
      }));
    }
    await Promise.all(warmupPromises);
    logger.info('Context pool pre-warmed and ready');
    
    // Mark service as ready
    isReady = true;
    
    // Start server
    server = app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT }, 'Server listening and ready to accept traffic');
    });
    
  } catch (error) {
    logger.fatal({ error: error.message, stack: error.stack }, 'Failed to start');
    process.exit(1);
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.info('Shutdown already in progress');
    return;
  }
  
  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown initiated');
  
  // Stop accepting new requests
  isReady = false;
  
  // Close server
  if (server) {
    logger.info('Closing HTTP server...');
    await new Promise((resolve) => {
      server.close(resolve);
    });
    logger.info('HTTP server closed');
  }
  
  // Wait for ongoing requests to complete
  logger.info('Waiting for ongoing requests to complete...');
  await semaphore.drain();
  logger.info('All requests completed');
  
  // Clear session cleanup interval
  clearInterval(sessionCleanupInterval);
  
  // Close all sessions
  logger.info('Closing active sessions...');
  for (const [sessionId, session] of sessions.entries()) {
    await session.context.close().catch(err => 
      logger.error({ err: err.message, sessionId }, 'Error closing session')
    );
  }
  sessions.clear();
  
  // Drain and close pool
  logger.info('Draining context pool...');
  await contextPool.drain();
  await contextPool.clear();
  logger.info('Context pool closed');
  
  // Close browser
  if (browser) {
    logger.info('Closing browser...');
    await browser.close();
    logger.info('Browser closed');
  }
  
  logger.info('Graceful shutdown complete');
  process.exit(0);
}

// Signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Uncaught error handlers
process.on('uncaughtException', (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled rejection');
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start the service
start();
