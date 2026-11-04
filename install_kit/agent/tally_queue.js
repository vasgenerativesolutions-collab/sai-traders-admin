/**
 * Sai Traders — TallyPrime Concurrency-Safe Queue Manager (SEC-08)
 *
 * Implements a Leaky-Bucket Sequential FIFO Queue (Concurrency = 1)
 * with a mandatory 250ms spacing and exponential backoff retry.
 * Protects TallyPrime's single-threaded XML engine from concurrent lockups.
 */

const http = require('http');

class TallyQueueManager {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = parseInt(options.port || '9000', 10);
    this.spacingMs = options.spacingMs || 250;
    this.queue = [];
    this.isProcessing = false;
    this.lastExecutedAt = 0;
    this.totalExecuted = 0;
  }

  /**
   * Enqueue an XML payload for serialized execution against Tally
   * @param {string} xml - Valid Tally XML envelope
   * @param {number} customTimeout - Socket timeout in milliseconds
   * @returns {Promise<string>} - Resolves with raw Tally XML response string
   */
  enqueue(xml, customTimeout = 5000) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        xml,
        customTimeout,
        resolve,
        reject,
        retries: 0,
        enqueuedAt: Date.now()
      });
      this.processNext();
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const task = this.queue.shift();

    // Enforce polite spacing between consecutive Tally calls
    const timeSinceLast = Date.now() - this.lastExecutedAt;
    if (timeSinceLast < this.spacingMs) {
      await new Promise(r => setTimeout(r, this.spacingMs - timeSinceLast));
    }

    try {
      const result = await this.executeRaw(task.xml, task.customTimeout);
      this.lastExecutedAt = Date.now();
      this.totalExecuted++;
      task.resolve(result);
    } catch (err) {
      this.lastExecutedAt = Date.now();
      const isTransient = /ECONNRESET|ECONNREFUSED|Server busy|busy/i.test(err.message);
      if (isTransient && task.retries < 2) {
        task.retries++;
        const backoffMs = task.retries * 1200;
        console.warn(`[TallyQueue] Transient notice (${err.message}). Retrying in ${backoffMs}ms (Attempt ${task.retries + 1}/3)...`);
        await new Promise(r => setTimeout(r, backoffMs));
        this.queue.unshift(task); // Re-insert at the front of the queue
      } else {
        task.reject(err);
      }
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  executeRaw(xml, customTimeout) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml;charset=utf-8',
          'Content-Length': Buffer.byteLength(xml)
        },
        timeout: customTimeout
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Tally connection timed out'));
      });
      req.write(xml);
      req.end();
    });
  }

  getStats() {
    return {
      pending: this.queue.length,
      isProcessing: this.isProcessing,
      totalExecuted: this.totalExecuted,
      spacingMs: this.spacingMs
    };
  }
}

module.exports = { TallyQueueManager };
