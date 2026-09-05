import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates request parts against Zod schemas. Parsed (and transformed)
 * values replace the originals so downstream code works with clean data.
 * ZodError is forwarded to the error middleware (422).
 *
 * Express 5 note: `req.query` is a GETTER that RE-PARSES the query string on
 * every access, so `Object.assign(req.query, parsed)` mutates a throwaway object
 * and the coerced defaults/transforms (e.g. `page` defaulting to 1) never reach
 * the handler — which then computes `(undefined - 1) * limit = NaN` and hands a
 * NaN offset to Knex ("A valid integer must be provided to offset"). We instead
 * redefine `req.query` as a plain data property holding the parsed result so the
 * validated values actually persist. `req.body`/`req.params` are ordinary
 * writable objects, so a direct assign is fine there.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) {
        const parsedQuery = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', {
          value: parsedQuery,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (schemas.params) Object.assign(req.params, schemas.params.parse(req.params));
      next();
    } catch (err) {
      next(err);
    }
  };
}
