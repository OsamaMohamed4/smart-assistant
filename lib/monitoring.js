// Optional Sentry error tracking + process-level failure handlers.
// Sentry activates only when SENTRY_DSN is set, so local dev and CI run
// without it. Process handlers are always installed: before this module
// existed, one rejected promise outside an Express handler could kill the
// process silently (Railway would restart it, nobody would know why).

let Sentry = null;

function initMonitoring(logger) {
  const dsn = (process.env.SENTRY_DSN || '').trim();
  if (dsn) {
    try {
      Sentry = require('@sentry/node');
      Sentry.init({
        dsn,
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development',
        release    : process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
        // Error tracking only — no performance tracing (keeps quota + overhead low).
        tracesSampleRate: 0,
      });
      logger.info('sentry enabled');
    } catch (e) {
      Sentry = null;
      logger.warn('sentry init failed', { err: e.message });
    }
  }

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandledRejection', { err: err.message, stack: err.stack });
    if (Sentry) Sentry.captureException(err);
    // Don't exit: a stray rejection in a fire-and-forget path shouldn't drop
    // live phone calls. It's reported; the process stays up.
  });

  process.on('uncaughtException', (err) => {
    // State is unknown after an uncaught throw — log, flush, and let the
    // platform restart us (Railway restartPolicy ON_FAILURE).
    logger.error('uncaughtException — exiting', { err: err.message, stack: err.stack });
    const done = () => process.exit(1);
    if (Sentry) {
      Sentry.captureException(err);
      Sentry.close(2000).then(done, done);
    } else {
      done();
    }
  });
}

// Manual capture for caught-but-noteworthy errors (route error middleware).
function captureError(err, extra) {
  if (Sentry) Sentry.captureException(err, extra ? { extra } : undefined);
}

module.exports = { initMonitoring, captureError };
