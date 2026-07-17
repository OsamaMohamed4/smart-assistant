// Request validation middleware (Zod).
//
// validate({ body, params, query }) returns an Express middleware that rejects
// malformed input with HTTP 400 BEFORE it reaches the handler or the database.
//
// - body   : parsed and written back to req.body (unknown keys stripped, values
//            coerced) so the handler receives clean, typed data.
// - params : validated in place. NOT reassigned — Express 5 exposes req.query
//            (and treats req.params carefully) via getters, so we validate
//            without mutating routing internals. Handlers keep their own coercion.
// - query  : validated in place, same reason.
//
// The 400 body is a structured, non-sensitive list of field errors — never the
// raw value or a stack trace.
const { ZodError } = require('zod');

function formatIssues(err) {
  return err.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

function validate(schemas = {}) {
  return (req, res, next) => {
    try {
      if (schemas.params) schemas.params.parse(req.params);
      if (schemas.query) schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({ error: 'validation failed', details: formatIssues(err) });
      }
      return next(err);
    }
  };
}

module.exports = { validate, formatIssues };
