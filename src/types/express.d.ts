import type { AuthUser, SessionRow } from './auth';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      authSession?: SessionRow;
    }
  }
}

export {};
