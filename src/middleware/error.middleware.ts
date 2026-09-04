import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { ApiError } from '../utils/errors';
import { StorageError } from '../storage/storage.provider';
import { logger } from '../utils/logger';
import { isProduction } from '../config/env';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint topilmadi' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  // Phase 10A: stable business responses for expected MySQL conflicts —
  // internal SQL details are logged, never sent to the client. No blanket
  // automatic retry: transactions here carry audit writes and other side
  // effects, so retrying is the CLIENT's decision (409 signals it is safe).
  const mysqlErrno = (err as { errno?: number } | null)?.errno;
  if (mysqlErrno === 1062) {
    logger.warn({ err }, 'Duplicate key conflict');
    res.status(409).json({ error: { code: 'DUPLICATE', message: "Bu ma'lumot allaqachon mavjud" } });
    return;
  }
  if (mysqlErrno === 1213 || mysqlErrno === 1205) {
    logger.warn({ err }, 'Lock conflict (deadlock or lock wait timeout)');
    res.status(409).json({
      error: { code: 'CONFLICT_RETRY', message: "Boshqa amal bilan to'qnashuv yuz berdi — qayta urinib ko'ring" },
    });
    return;
  }

  // Storage failures never leak provider detail to the client.
  if (err instanceof StorageError) {
    logger.error({ err: { kind: err.kind, message: err.message } }, 'Storage error');
    res.status(502).json({ error: { code: 'STORAGE_UNAVAILABLE', message: "Fayl xizmatida xatolik — qayta urinib ko'ring" } });
    return;
  }

  if (err instanceof MulterError) {
    res.status(422).json({
      error: {
        code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR',
        message: err.code === 'LIMIT_FILE_SIZE' ? 'Fayl juda katta (maksimum 10 MB)' : "Fayl yuklashda xatolik",
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: "Kiritilgan ma'lumotlar noto'g'ri",
        details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'Ichki server xatosi' : err instanceof Error ? err.message : 'Ichki server xatosi',
    },
  });
}
