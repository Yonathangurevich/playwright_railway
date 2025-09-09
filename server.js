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
const SESSION_MAX = parseInt(process.env.SESSION_MAX || '100');
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT || '3');
const REQUEST_TIMEOUT_MS = NAV_TIMEOUT_MS + 5000; // Server timeout buffer
const USE_CHROME_CHANNEL = process.env.USE_CHROME_CHANNEL === 'true';

// Parse proxy URL into Playwright format
function parseProxy(proxyUrl) {
  try {
    const url = new URL(proxyUrl);
    const proxy = {
      server: `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`
    };
    
    // Extract and decode credentials if present
    if (url.username) {
      proxy.username = decodeURIComponent(url.username);
    }
    if (url.password) {
      proxy.password = decodeURIComponent(url.password);
    }
    
    return proxy;
  } catch (error) {
    logger.error({ error: error.message, proxyUrl }, 'Failed to parse proxy URL');
    return null;
  }
}

// Parse proxy from environment
const envProxy = process.env.PROXY ? parseProxy(process.env.PROXY) : null;

// Default headers for stealth
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
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

// Session management with proper pooling
const sessions = new Map(); // Map<sessionId, { context, lastUsedAt, createdAt }>

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
  INTERNAL: (msg, hint) => new ServiceError('INTERNAL', msg, hint),
  CF_CHALLENGE: (msg, hint) => new ServiceError('CF_CHALLENGE', msg, hint),
  CONTENT_NOT_READY: (msg, hint) => new ServiceError('CONTENT_NOT_READY', msg, hint),
  PROXY_ERROR: (msg, hint) => new ServiceError('PROXY_ERROR', msg, hint)
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

// Utility: Mask cookie value
const maskCookieValue = (value) => {
  if (!value || value.length <= 6) return '***';
  return value.slice(0, 3) + '***' + value.slice(-3);
};

// Check if URL needs Cloudflare hardening
const needsCfHardening = (url, challengeMode) => {
  if (challengeMode) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /(partsouq\.com|cloudflare|cf)/i.test(hostname);
  } catch {
    return false;
  }
};

// Helper: Check for cf_clearance cookie
async function hasCfClearance(context, hostname) {
  try {
    const cs = await context.cookies(`https://${hostname}`);
    return cs.some(c => c.name === 'cf_clearance');
  } catch {
    return false;
  }
}

// Helper: Check if page is challenged
async function pageChallenged(page) {
  try {
    const t = await page.title().catch(() => '');
    const b = await page.evaluate(() => 
      document.body ? document.body.innerText.slice(0, 2000) : ''
    ).catch(() => '');
    return /just a moment|checking your browser|cloudflare|cf-browser-verification/i.test(t + ' ' + b);
  } catch {
    return false;
  }
}

// Helper: Run humanization actions
async function runHumanization(page, logger, requestId) {
  try {
    // Random wait 800-1400ms
    await randomDelay(800, 1400);
    
    // Small mouse movement
    await page.mouse.move(
      200 + Math.floor(Math.random() * 100), 
      200 + Math.floor(Math.random() * 100), 
      { steps: 4 }
    );
  } catch (err) {
    logger.debug({ requestId, err: err.message }, 'Mouse move failed (non-critical)');
  }
  
  try {
    // Tiny scroll
    await page.evaluate(() => {
      window.scrollBy(0, 50 + Math.floor(Math.random() * 70));
    });
  } catch (err) {
    logger.debug({ requestId, err: err.message }, 'Scroll action failed (non-critical)');
  }
}

// LRU eviction for sessions
const evictLRUSession = async () => {
  if (sessions.size === 0) return;
  
  let oldestId = null;
  let oldestTime = Date.now();
  
  for (const [sessionId, session] of sessions.entries()) {
    if (session.lastUsedAt < oldestTime) {
      oldestTime = session.lastUsedAt;
      oldestId = sessionId;
    }
  }
  
  if (oldestId) {
    const session = sessions.get(oldestId);
    logger.info({ sessionId: oldestId }, 'Evicting LRU session due to SESSION_MAX limit');
    
    try {
      await session.context.close();
    } catch (err) {
      logger.error({ err: err.message, sessionId: oldestId }, 'Error closing evicted session');
    }
    
    sessions.delete(oldestId);
  }
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
    
    return await browser.newContext(contextOptions);
  },
  destroy: async (context) => {
    logger.debug('Destroying browser context');
    await context.close();
  },
  validate: async (context) => {
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

// Session cleanup task - runs every 60 seconds
const sessionCleanupInterval = setInterval(async () => {
  const now = Date.now();
  const toDelete = [];
  
  for (const [sessionId, session] of sessions.entries()) {
    const age = now - session.lastUsedAt;
    if (age > SESSION_TTL_MS) {
      toDelete.push(sessionId);
    }
  }
  
  for (const sessionId of toDelete) {
    const session = sessions.get(sessionId);
    logger.info({ 
      sessionId, 
      age: Math.round((now - session.createdAt) / 1000) + 's',
      idle: Math.round((now - session.lastUsedAt) / 1000) + 's'
    }, 'Cleaning expired session');
    
    try {
      await session.context.close();
    } catch (err) {
      logger.error({ err: err.message, sessionId }, 'Error closing expired session');
    }
    
    sessions.delete(sessionId);
  }
  
  if (toDelete.length > 0) {
    logger.info({ 
      cleaned: toDelete.length, 
      remaining: sessions.size 
    }, 'Session cleanup completed');
  }
}, 60000);

// Express app
const app = express();
app.use(express.json({ limit: '50mb' })); // Increase limit for screenshot responses

// Request ID middleware
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
    chromeChannel: USE_CHROME_CHANNEL,
    usingProxy: !!(envProxy && envProxy.server),
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'production',
    ready: isReady
  });
});

// Admin endpoint for session monitoring
app.get('/sessions', (req, res) => {
  const now = Date.now();
  const sessionInfo = [];
  
  for (const [sessionId, session] of sessions.entries()) {
    sessionInfo.push({
      sessionId: sessionId.substring(0, 8) + '...',
      createdAt: new Date(session.createdAt).toISOString(),
      lastUsedAt: new Date(session.lastUsedAt).toISOString(),
      ageSeconds: Math.round((now - session.createdAt) / 1000),
      idleSeconds: Math.round((now - session.lastUsedAt) / 1000),
      ttlRemaining: Math.max(0, Math.round((SESSION_TTL_MS - (now - session.lastUsedAt)) / 1000))
    });
  }
  
  sessionInfo.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  
  res.json({
    totalSessions: sessions.size,
    maxSessions: SESSION_MAX,
    ttlMs: SESSION_TTL_MS,
    poolSize: POOL_SIZE,
    poolAvailable: contextPool.available,
    sessions: sessionInfo
  });
});

// Health check with browser verification
let healthCheckCache = { ok: false, lastCheck: 0 };
const HEALTH_CACHE_TTL = 5000;

app.get('/healthz', async (req, res) => {
  const now = Date.now();
  
  if (healthCheckCache.ok && (now - healthCheckCache.lastCheck) < HEALTH_CACHE_TTL) {
    return res.json({ 
      ok: true, 
      cached: true,
      ready: isReady,
      poolSize: contextPool.size,
      poolAvailable: contextPool.available
    });
  }
  
  if (!isReady || !browser) {
    return res.status(503).json({
      ok: false,
      ready: false,
      message: 'Service not ready'
    });
  }
  
  let testContext = null;
  let testPage = null;
  
  try {
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

// Main solve endpoint
app.post('/solve', async (req, res) => {
  const { 
    url, 
    userAgent, 
    cookies, 
    waitUntil, 
    sessionId, 
    blockAssets = true,
    challengeMode = false,
    contentReadySelector = null,
    minHtmlLength = 40000,
    postNavigateWaitMs = null,
    maxChallengeRounds = 5,
    returnScreenshot = false
  } = req.body;
  
  // Input validation
  if (!url) {
    return res.status(400).json({
      code: 'BAD_REQUEST',
      message: 'Missing required field: url',
      hint: 'Please provide a valid URL to scrape'
    });
  }
  
  let hostname;
  try {
    const urlObj = new URL(url);
    hostname = urlObj.hostname;
  } catch (error) {
    return res.status(400).json({
      code: 'BAD_REQUEST',
      message: 'Invalid URL format',
      hint: 'Please provide a valid URL with protocol (http:// or https://)'
    });
  }

  // Check if CF hardening needed
  const cfHardening = needsCfHardening(url, challengeMode);
  
  // Override settings for CF-protected sites
  const effectiveBlockAssets = cfHardening ? false : blockAssets;
  const effectiveWaitUntil = cfHardening ? (waitUntil || 'domcontentloaded') : (waitUntil || 'domcontentloaded');
  const effectiveUserAgent = userAgent || DEFAULT_USER_AGENT;
  const effectivePostNavigateWait = postNavigateWaitMs !== null ? postNavigateWaitMs : (800 + Math.floor(Math.random() * 600));

  logger.info({ 
    requestId: req.id, 
    url,
    hostname,
    sessionId, 
    blockAssets: effectiveBlockAssets,
    waitUntil: effectiveWaitUntil,
    challengeMode,
    cfHardening,
    contentReadySelector,
    minHtmlLength,
    maxChallengeRounds,
    returnScreenshot,
    usingProxy: !!(envProxy && envProxy.server),
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
      const existingSession = sessions.get(sessionId);
      
      if (existingSession) {
        existingSession.lastUsedAt = Date.now();
        context = existingSession.context;
        logger.debug({ 
          sessionId,
          age: Math.round((Date.now() - existingSession.createdAt) / 1000) + 's'
        }, 'Reusing existing session');
      } else {
        if (sessions.size >= SESSION_MAX) {
          await evictLRUSession();
        }
        
        const contextOptions = {
          userAgent: effectiveUserAgent,
          locale: cfHardening ? 'en-US' : 'en-US',
          timezoneId: cfHardening ? 'UTC' : 'America/New_York',
          viewport: { width: 1920, height: 1080 },
          screen: { width: 1920, height: 1080 },
          deviceScaleFactor: 1,
          hasTouch: false,
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9'
          }
        };
        
        context = await browser.newContext(contextOptions);
        
        const now = Date.now();
        sessions.set(sessionId, {
          context,
          createdAt: now,
          lastUsedAt: now
        });
        
        logger.debug({ 
          sessionId,
          totalSessions: sessions.size
        }, 'Created new session');
      }
      
      fromPool = false;
    } else {
      context = await contextPool.acquire();
      fromPool = true;
    }
    
    // Create page
    page = await context.newPage();
    
    // Set custom user agent if provided
    if (userAgent && !sessionId) {
      await page.setExtraHTTPHeaders({ 
        'User-Agent': userAgent
      });
    }
    
    // Set headers based on CF hardening
    if (cfHardening) {
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="124", "Not.A/Brand";v="24", "Google Chrome";v="124"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      });
    } else {
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
    }
    
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
    
    // Asset blocking
    if (effectiveBlockAssets) {
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
    
    // Navigate
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: effectiveWaitUntil,
        timeout: NAV_TIMEOUT_MS
      });
    } catch (error) {
      // Check if this might be a proxy error
      if (envProxy && envProxy.server && 
          (error.message.includes('net::ERR_PROXY_CONNECTION_FAILED') ||
           error.message.includes('net::ERR_TUNNEL_CONNECTION_FAILED') ||
           error.message.includes('proxy') ||
           error.message.includes('ECONNREFUSED'))) {
        throw ErrorTypes.PROXY_ERROR(
          'Proxy connection failed',
          'Check proxy server availability and credentials. Format: http://user:pass@host:port or socks5://host:port'
        );
      }
      
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
    
    // Post-navigation wait
    await page.waitForTimeout(effectivePostNavigateWait);
    
    // Initial humanization
    await runHumanization(page, logger, req.id);
    
    // CF-specific logic
    let gotCfClearance = false;
    let roundsTried = 0;
    let challenged = await pageChallenged(page);
    
    if (challenged && cfHardening) {
      logger.info({ 
        requestId: req.id,
        hostname,
        challenged: true
      }, 'CF challenge detected');
      
      // Challenge resolution loop
      for (roundsTried = 1; roundsTried <= maxChallengeRounds; roundsTried++) {
        logger.debug({ 
          requestId: req.id,
          round: roundsTried,
          maxRounds: maxChallengeRounds
        }, 'Attempting CF challenge resolution');
        
        await page.waitForTimeout(3500);
        
        try {
          await page.waitForNavigation({ 
            waitUntil: 'domcontentloaded', 
            timeout: 15000 
          });
        } catch {}
        
        await runHumanization(page, logger, req.id);
        
        // Check for cf_clearance cookie
        gotCfClearance = await hasCfClearance(context, hostname);
        if (gotCfClearance) {
          logger.info({ 
            requestId: req.id,
            hostname,
            roundsTried,
            gotCfClearance: true
          }, 'CF clearance obtained');
          break;
        }
        
        challenged = await pageChallenged(page);
        if (!challenged) {
          logger.info({ 
            requestId: req.id,
            hostname,
            roundsTried
          }, 'CF challenge no longer detected');
          break;
        }
      }
      
      // Try hard reload if still challenged
      if (!gotCfClearance && challenged) {
        logger.debug({ requestId: req.id }, 'Attempting hard reload');
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1000);
          await runHumanization(page, logger, req.id);
          gotCfClearance = await hasCfClearance(context, hostname);
          challenged = await pageChallenged(page);
        } catch {}
      }
    } else {
      // Check if we already have cf_clearance even without challenge
      gotCfClearance = await hasCfClearance(context, hostname);
    }
    
    // Content readiness check
    if (contentReadySelector) {
      try {
        await page.waitForSelector(contentReadySelector, { timeout: 10000 });
        logger.debug({ 
          requestId: req.id,
          selector: contentReadySelector
        }, 'Content selector found');
      } catch {
        logger.debug({ 
          requestId: req.id,
          selector: contentReadySelector
        }, 'Content selector not found within timeout');
      }
    }
    
    // Get HTML content
    const html = await page.content();
    
    // Final readiness decision
    const htmlLength = html.length;
    const stillChallenged = await pageChallenged(page);
    
    if (htmlLength < minHtmlLength && stillChallenged) {
      logger.warn({ 
        requestId: req.id,
        hostname,
        htmlLength,
        minHtmlLength,
        stillChallenged
      }, 'Content too short and still challenged');
      
      throw ErrorTypes.CF_CHALLENGE(
        'Cloudflare challenge could not be bypassed',
        `HTML too short (${htmlLength} < ${minHtmlLength}) and still challenged. Try session reuse or residential proxy`
      );
    }
    
    // Get screenshot if requested
    let screenshot = undefined;
    if (returnScreenshot) {
      try {
        const screenshotBuffer = await page.screenshot({ 
          type: 'jpeg', 
          quality: 60, 
          fullPage: true 
        });
        screenshot = screenshotBuffer.toString('base64');
        logger.debug({ requestId: req.id }, 'Screenshot captured');
      } catch (err) {
        logger.error({ 
          requestId: req.id,
          error: err.message 
        }, 'Failed to capture screenshot');
      }
    }
    
    // Get cookies for response
    const responseCookies = await context.cookies(`https://${hostname}`);
    const maskedCookies = responseCookies.map(c => ({
      name: c.name,
      value: maskCookieValue(c.value),
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite
    }));
    
    // Get final cf_clearance status
    const finalCfClearance = await hasCfClearance(context, hostname);
    
    logger.info({ 
      requestId: req.id,
      hostname,
      challenged: stillChallenged,
      roundsTried,
      gotCfClearance: finalCfClearance,
      htmlLength
    }, 'Request processing completed');
    
    // Get final URL
    const finalUrl = page.url();
    
    return { 
      status: 200,
      url: finalUrl,
      html,
      usingProxy: !!(envProxy && envProxy.server),
      gotCfClearance: finalCfClearance,
      cookies: maskedCookies,
      screenshot
    };
  };
  
  try {
    const result = await Promise.race([processRequest(), requestTimeout]);
    
    if (timeoutHandle) clearTimeout(timeoutHandle);
    
    const duration = Date.now() - req.startTime;
    
    logger.info({
      requestId: req.id,
      url,
      finalUrl: result.url,
      status: result.status,
      duration,
      gotCfClearance: result.gotCfClearance,
      usingProxy: result.usingProxy,
      htmlLength: result.html.length
    }, 'Request completed successfully');
    
    res.json(result);
    
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    
    const duration = Date.now() - req.startTime;
    
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
        case 'CONTENT_NOT_READY':
          statusCode = 502;
          break;
        case 'CF_CHALLENGE':
          statusCode = 403;
          break;
        case 'PROXY_ERROR':
          statusCode = 502;
          break;
        default:
          statusCode = 500;
      }
    }
    
    logger.error({ 
      requestId: req.id, 
      url,
      hostname,
      code: errorResponse.code,
      error: error.message,
      stack: error.stack,
      duration,
      cfHardening,
      challengeMode,
      usingProxy: !!(envProxy && envProxy.server)
    }, 'Request failed');
    
    errorResponse.status = statusCode;
    res.status(statusCode).json(errorResponse);
    
  } finally {
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
    logger.info({ 
      chromeChannel: USE_CHROME_CHANNEL,
      proxyEnabled: !!(envProxy && envProxy.server)
    }, 'Starting scraper service...');
    
    if (envProxy && envProxy.server) {
      logger.info(`Proxy enabled: ${envProxy.server} (auth: ${!!envProxy.username})`);
    }
    
    // Build launch options
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
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-web-security',
        '--disable-infobars',
        '--window-size=1920,1080',
        '--start-maximized'
      ]
    };
    
    // Use Chrome channel if configured
    if (USE_CHROME_CHANNEL) {
      launchOptions.channel = 'chrome';
      logger.info('Using Chrome stable channel');
    }
    
    // Add proxy configuration if available
    if (envProxy) {
      launchOptions.proxy = envProxy;
    }
    
    browser = await chromium.launch(launchOptions);
    logger.info({ 
      headless: HEADLESS,
      channel: USE_CHROME_CHANNEL ? 'chrome' : 'chromium',
      proxyEnabled: !!(envProxy && envProxy.server)
    }, 'Browser launched');
    
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
    
    isReady = true;
    
    server = app.listen(PORT, '0.0.0.0', () => {
      logger.info({ 
        port: PORT,
        proxyEnabled: !!(envProxy && envProxy.server)
      }, 'Server listening and ready to accept traffic');
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
  
  isReady = false;
  
  if (server) {
    logger.info('Closing HTTP server...');
    await new Promise((resolve) => {
      server.close(resolve);
    });
    logger.info('HTTP server closed');
  }
  
  logger.info('Waiting for ongoing requests to complete...');
  await semaphore.drain();
  logger.info('All requests completed');
  
  clearInterval(sessionCleanupInterval);
  
  logger.info('Closing active sessions...');
  for (const [sessionId, session] of sessions.entries()) {
    await session.context.close().catch(err => 
      logger.error({ err: err.message, sessionId }, 'Error closing session')
    );
  }
  sessions.clear();
  
  logger.info('Draining context pool...');
  await contextPool.drain();
  await contextPool.clear();
  logger.info('Context pool closed');
  
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
