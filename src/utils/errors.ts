export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = "Avtorizatsiyadan o'tilmagan", code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = 'Ruxsat berilmagan', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static notFound(message = 'Topilmadi', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static conflict(message: string, code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }

  static tooMany(message = "Urinishlar soni oshib ketdi. Keyinroq urinib ko'ring.", code = 'TOO_MANY_REQUESTS') {
    return new ApiError(429, code, message);
  }
}
