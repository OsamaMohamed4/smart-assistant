// Prometheus metrics (Task #6 Observability).
//
// Exposes:
//   - default Node/process metrics (memory, CPU, event-loop lag, GC…)
//   - http_request_duration_seconds  (histogram, labels: method/route/status)
//   - http_requests_total            (counter)
//   - http_errors_total              (counter, status >= 500)
//   - app_unhandled_errors_total     (counter, errors reaching the error handler)
//   - db_up                          (gauge, 1/0 from the health check)
//   - db_query_duration_seconds      (histogram — wired opportunistically)
//
// Route labels use the matched Express route PATTERN (e.g. /api/companies/:id),
// never the raw path, so tenant/record IDs can't explode metric cardinality.
const crypto = require('node:crypto');
const client = require('prom-client');
const { logger } = require('./logger');

const register = new client.Registry();
register.setDefaultLabels({ app: 'smart-assistant' });
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});
const httpTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});
const httpErrors = new client.Counter({
  name: 'http_errors_total',
  help: 'HTTP responses with status >= 500',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});
const appErrors = new client.Counter({
  name: 'app_unhandled_errors_total',
  help: 'Errors reaching the last-resort error handler',
  registers: [register],
});
const dbUp = new client.Gauge({
  name: 'db_up',
  help: 'Database reachable (1) or not (0)',
  registers: [register],
});
const dbQuery = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'DB query latency in seconds',
  labelNames: ['op'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});
const jobs = new client.Counter({
  name: 'jobs_total',
  help: 'Background jobs processed, by queue and status (completed/failed/dead)',
  labelNames: ['queue', 'status'],
  registers: [register],
});

function routeLabel(req) {
  if (req.route && req.route.path) return (req.baseUrl || '') + req.route.path;
  if (['/metrics', '/health', '/livez'].includes(req.path)) return req.path;
  return 'unmatched';
}

// Wraps every request: records latency + counts on response finish, and emits a
// structured access-log line (skipping the noisy health/metrics scrapes).
function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
    httpDuration.observe(labels, seconds);
    httpTotal.inc(labels);
    if (res.statusCode >= 500) httpErrors.inc(labels);
    if (!['/metrics', '/livez', '/health'].includes(req.path)) {
      const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      (req.log || logger)[lvl]('request', {
        method: req.method, path: req.path, status: res.statusCode, ms: Math.round(seconds * 1000),
      });
    }
  });
  next();
}

// GET /metrics — token-gated.
//
// Fails CLOSED in production: without METRICS_TOKEN this endpoint used to
// serve to anyone, exposing route latencies, error rates, and Node heap/GC
// internals — useful reconnaissance and a free view of platform load. A
// missing token in production is a misconfiguration, so we refuse rather
// than silently publish. Dev/CI (no NODE_ENV=production) stay open so local
// scraping and the smoke suite work with no setup.
async function metricsHandler(req, res) {
  const token = (process.env.METRICS_TOKEN || '').trim();
  const isProd = process.env.NODE_ENV === 'production';

  if (!token) {
    if (isProd) {
      logger.warn('metrics: refused — METRICS_TOKEN is not set in production');
      return res.status(503).end('metrics disabled: METRICS_TOKEN not configured');
    }
    res.set('Content-Type', register.contentType);
    return res.end(await register.metrics());
  }

  // Constant-time compare so the token can't be recovered byte-by-byte.
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(req.get('authorization') || '');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return res.status(401).end('unauthorized');
  }
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

const recordDbUp = (up) => dbUp.set(up ? 1 : 0);
const recordAppError = () => appErrors.inc();
const timeDbQuery = (op, ms) => dbQuery.observe({ op }, ms / 1000);
const recordJob = (queue, status) => jobs.inc({ queue, status });

module.exports = {
  register, httpMetricsMiddleware, metricsHandler,
  recordDbUp, recordAppError, timeDbQuery, recordJob, client,
};
