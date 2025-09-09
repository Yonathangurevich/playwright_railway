FROM node:20-slim

# Install dependencies for Chrome and Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Add Google Chrome repo and install Chrome stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Skip browser download during npm install (we'll install manually)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install Node dependencies
RUN npm install --omit=dev --no-audit --no-fund

# Install Playwright dependencies for Chromium (shared libs)
RUN npx playwright install-deps chromium

# Install Chromium as fallback when not using Chrome channel
RUN npx playwright install chromium

# Copy application code
COPY . .

# Set default environment variables
ENV PORT=3000
ENV HEADLESS=true
ENV POOL_SIZE=3
ENV NAV_TIMEOUT_MS=30000
ENV SESSION_TTL_MS=300000
ENV SESSION_MAX=100
ENV CONCURRENCY_LIMIT=3
ENV NODE_ENV=production
ENV USE_CHROME_CHANNEL=false

# Expose port
EXPOSE 3000

# Run the application
CMD ["node", "server.js"]
