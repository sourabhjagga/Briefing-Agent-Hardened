/**
 * Unified Puppeteer Headless Stealth Browser Manager
 * 
 * - Ensures a single shared Chromium instance is used to save memory.
 * - Lazily launches the browser only when an active scraping task requests it.
 * - Automatically closes the browser after 2 minutes of idle time to conserve RAM.
 * - Configured with standard anti-detection stealth plugins.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('./logger');

// Load stealth plugin
puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor() {
    this.browser = null;
    this.activePagesCount = 0;
    this.idleTimeoutId = null;
    this.idleLimit = 2 * 60 * 1000; // 2 minutes in milliseconds
    this.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  }

  /**
   * Returns the shared browser instance, launching it lazily if not currently open.
   */
  async getBrowser() {
    // Reset idle timer since we have activity
    this._resetIdleTimer();

    if (this.browser) {
      return this.browser;
    }

    logger.info('🌐 Spawning headless Chromium browser with Puppeteer Stealth...');
    try {
      this.browser = await puppeteer.launch({
        executablePath: this.executablePath,
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-crash-reporter',
          '--crash-dumps-dir=/tmp',
          '--window-size=1280,720'
        ]
      });
      logger.info('✅ Headless Chromium successfully started!');
      return this.browser;
    } catch (err) {
      logger.error(`Failed to launch Chromium browser: ${err.message}`);
      throw err;
    }
  }

  /**
   * Helper to open a clean new tab, tracking active tabs for auto-shutdown.
   */
  async newPage() {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    this.activePagesCount++;
    this._resetIdleTimer();

    // Set standard viewport and headers to look like a desktop consumer
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Override webdriver properties for maximum anti-detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Custom close wrapper to safely decrement pages and start idle clock
    const originalClose = page.close.bind(page);
    page.close = async () => {
      await originalClose();
      this.activePagesCount = Math.max(0, this.activePagesCount - 1);
      this._startIdleTimer();
    };

    return page;
  }

  /**
   * Safely closes the browser instance.
   */
  async close() {
    if (this.browser) {
      logger.info('🧹 Closing idle Chromium browser to save system memory...');
      try {
        await this.browser.close();
      } catch (err) {
        logger.error(`Error closing browser: ${err.message}`);
      }
      this.browser = null;
      this.activePagesCount = 0;
    }
  }

  _resetIdleTimer() {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
  }

  _startIdleTimer() {
    this._resetIdleTimer();
    // Only idle-shutdown if there are zero active pages
    if (this.activePagesCount === 0 && this.browser) {
      this.idleTimeoutId = setTimeout(() => {
        this.close();
      }, this.idleLimit);
    }
  }
}

// Export as a singleton
module.exports = new BrowserManager();
