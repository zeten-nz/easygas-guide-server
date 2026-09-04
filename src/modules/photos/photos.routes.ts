import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { requirePermission } from '../../middleware/permission.middleware';
import { validate } from '../../middleware/validate.middleware';
import { ApiError } from '../../utils/errors';
import { requestMeta } from '../audit/audit.service';
import * as service from './photos.service';
import { MAX_PHOTO_BYTES } from './photos.service';

const stepParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
  stepId: z.coerce.number().int().positive(),
});

const photoParamsSchema = z.object({
  jobId: z.coerce.number().int().positive(),
  stepId: z.coerce.number().int().positive(),
  photoId: z.coerce.number().int().positive(),
});

// Memory storage: bytes are validated (magic numbers, size) before any
// storage write; multer's own limit is a hard backstop.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
});

/**
 * Mounted at /api/v1/jobs/:jobId/checklist/steps/:stepId/photos (mergeParams).
 * Photos are immutable evidence — there is NO delete/replace surface.
 * Ownership (job/step/uploader) is derived from the session and route
 * resources; any client-sent jobId/uploadedBy fields are ignored.
 */
export const stepPhotosRouter = Router({ mergeParams: true });

stepPhotosRouter.use(requireAuth);

stepPhotosRouter.get(
  '/',
  requirePermission('jobs.view'),
  validate({ params: stepParamsSchema }),
  async (req: Request, res: Response) => {
    const photos = await service.listStepPhotos(req.user!, Number(req.params.jobId), Number(req.params.stepId));
    res.json({ photos });
  },
);

stepPhotosRouter.post(
  '/',
  requirePermission('checklist.execute'),
  validate({ params: stepParamsSchema }),
  upload.single('photo'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      throw new ApiError(422, 'NO_FILE', "Rasm fayli yuborilmadi ('photo' maydoni)");
    }
    const photo = await service.uploadStepPhoto(
      req.user!,
      Number(req.params.jobId),
      Number(req.params.stepId),
      { buffer: req.file.buffer, originalname: req.file.originalname },
      requestMeta(req),
    );
    res.status(201).json({ photo, message: 'Rasm yuklandi' });
  },
);

stepPhotosRouter.get(
  '/:photoId/file',
  requirePermission('jobs.view'),
  validate({ params: photoParamsSchema }),
  async (req: Request, res: Response) => {
    const { stream, mimeType, sizeBytes } = await service.getPhotoStream(
      req.user!,
      Number(req.params.jobId),
      Number(req.params.stepId),
      Number(req.params.photoId),
    );
    // Safe download headers: never sniff, always render inline as the detected
    // type, never expose the internal storage key or filesystem path.
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="photo-${req.params.photoId}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rasm topilmadi' } });
      else res.destroy();
    });
    stream.pipe(res);
  },
);
