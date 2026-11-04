/**
 * Sai Traders Agent — Local SQLite Outbox
 * Guarantees local durability first before cloud upload.
 * Powered by native node:sqlite (zero external compilation).
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'outbox.db');
const db = new DatabaseSync(DB_PATH);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS outbox_jobs (
    job_id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    payload TEXT,
    result TEXT,
    error TEXT,
    status TEXT NOT NULL DEFAULT 'pending_upload',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    uploaded_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_jobs(status, created_at ASC);
`);

/**
 * Saves job execution result locally first before uploading to cloud
 */
function saveJobResultLocally({ jobId, shopId, jobType, payload, result, error }) {
  const stmt = db.prepare(`
    INSERT INTO outbox_jobs (job_id, shop_id, job_type, payload, result, error, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending_upload', ?)
    ON CONFLICT(job_id) DO UPDATE SET
      result = excluded.result,
      error = excluded.error,
      attempts = attempts + 1,
      status = 'pending_upload'
  `);

  stmt.run(
    jobId,
    shopId,
    jobType,
    typeof payload === 'object' ? JSON.stringify(payload) : String(payload || ''),
    typeof result === 'object' ? JSON.stringify(result) : String(result || ''),
    error ? String(error) : null,
    new Date().toISOString()
  );

  return true;
}

/**
 * Marks job as successfully uploaded to cloud
 */
function markJobUploaded(jobId) {
  const stmt = db.prepare(`
    UPDATE outbox_jobs
    SET status = 'uploaded', uploaded_at = ?
    WHERE job_id = ?
  `);
  stmt.run(new Date().toISOString(), jobId);
}

/**
 * Retrieves all pending upload items to retry
 */
function getPendingUploads() {
  const stmt = db.prepare(`
    SELECT * FROM outbox_jobs
    WHERE status = 'pending_upload'
    ORDER BY created_at ASC
    LIMIT 20
  `);
  return stmt.all();
}

/**
 * Retrieves a specific job result from outbox
 */
function getJob(jobId) {
  const stmt = db.prepare(`SELECT * FROM outbox_jobs WHERE job_id = ?`);
  return stmt.get(jobId);
}

module.exports = {
  saveJobResultLocally,
  markJobUploaded,
  getPendingUploads,
  getJob
};
