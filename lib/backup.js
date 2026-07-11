// Automatic offsite SQLite backups to any S3-compatible store (Cloudflare
// R2, AWS S3, Backblaze B2). The entire platform lives in one SQLite file
// on one Railway volume — this module is the difference between "we lost a
// disk" and "we lost the company".
//
// Configuration (all required to activate; missing = feature off with a
// boot warning):
//   BACKUP_S3_BUCKET             bucket name
//   BACKUP_S3_ACCESS_KEY_ID      access key
//   BACKUP_S3_SECRET_ACCESS_KEY  secret
//   BACKUP_S3_ENDPOINT           e.g. https://<account>.r2.cloudflarestorage.com
//                                (omit for real AWS S3)
//   BACKUP_S3_REGION             default "auto" (R2) — use e.g. eu-west-1 on AWS
// Optional:
//   BACKUP_INTERVAL_HOURS        default 24
//   BACKUP_KEEP                  how many snapshots to retain, default 14
//   BACKUP_PREFIX                object key prefix, default "smart-assistant/"

const zlib = require('zlib');
const { db } = require('../db');

const state = {
  configured : false,
  lastOkAt   : null,
  lastError  : null,
  lastKey    : null,
  runs       : 0,
};

function backupConfig() {
  const bucket = (process.env.BACKUP_S3_BUCKET || '').trim();
  const keyId  = (process.env.BACKUP_S3_ACCESS_KEY_ID || '').trim();
  const secret = (process.env.BACKUP_S3_SECRET_ACCESS_KEY || '').trim();
  if (!bucket || !keyId || !secret) return null;
  return {
    bucket,
    endpoint: (process.env.BACKUP_S3_ENDPOINT || '').trim() || undefined,
    region  : (process.env.BACKUP_S3_REGION || 'auto').trim(),
    keyId, secret,
    intervalMs: Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 24) * 3600 * 1000,
    keep      : Math.max(1, Number(process.env.BACKUP_KEEP) || 14),
    prefix    : (process.env.BACKUP_PREFIX || 'smart-assistant/').replace(/^\/+/, ''),
  };
}

function makeS3Client(cfg) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret },
  });
}

// One backup run: consistent in-process snapshot (safe under WAL) → gzip →
// upload → prune snapshots beyond the retention count. `deps` is injectable
// for tests.
async function runBackup(logger, deps = {}) {
  const cfg = deps.cfg || backupConfig();
  if (!cfg) throw new Error('backups not configured');
  const s3 = deps.s3 || makeS3Client(cfg);
  const { PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = deps.commands || require('@aws-sdk/client-s3');

  const snapshot = db.serialize();                       // consistent, WAL-safe
  const gz = zlib.gzipSync(snapshot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const key = `${cfg.prefix}data-${stamp}.db.gz`;

  await s3.send(new PutObjectCommand({
    Bucket: cfg.bucket, Key: key, Body: gz,
    ContentType: 'application/gzip',
    Metadata: { 'raw-bytes': String(snapshot.length) },
  }));

  // Prune: list our snapshots, keep the newest N (keys embed the timestamp
  // so lexicographic order == chronological order).
  let pruned = 0;
  try {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.prefix }));
    const keys = (listed.Contents || [])
      .map((o) => o.Key)
      .filter((k) => /data-.*\.db\.gz$/.test(k))
      .sort()
      .reverse();
    for (const old of keys.slice(cfg.keep)) {
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: old }));
      pruned++;
    }
  } catch (e) {
    logger.warn('backup prune failed (upload succeeded)', { err: e.message });
  }

  state.lastOkAt = new Date().toISOString();
  state.lastError = null;
  state.lastKey = key;
  state.runs++;
  logger.info('offsite backup ok', { key, rawBytes: snapshot.length, gzBytes: gz.length, pruned });
  return { key, rawBytes: snapshot.length, gzBytes: gz.length, pruned };
}

function getBackupStatus() {
  return { ...state };
}

// Boot-time scheduler. First run 30s after boot (lets the deploy settle),
// then every BACKUP_INTERVAL_HOURS. Failures are logged + kept in state so
// /health and the admin endpoint can surface them — they never crash boot.
function startBackupScheduler(logger) {
  const cfg = backupConfig();
  if (!cfg) {
    logger.warn('offsite backups NOT configured — set BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY (+ BACKUP_S3_ENDPOINT for R2)');
    return;
  }
  state.configured = true;
  const tick = () => runBackup(logger).catch((e) => {
    state.lastError = e.message;
    logger.error('offsite backup failed', { err: e.message });
  });
  setTimeout(tick, 30_000).unref();
  setInterval(tick, cfg.intervalMs).unref();
  logger.info('offsite backups scheduled', { everyHours: cfg.intervalMs / 3600000, keep: cfg.keep, bucket: cfg.bucket });
}

module.exports = { startBackupScheduler, runBackup, getBackupStatus, backupConfig };
