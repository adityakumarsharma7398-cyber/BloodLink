/**
 * An error whose status, code and message are safe to show to the client.
 * Anything that is NOT an HttpError is treated as an internal error and never exposed.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'ERROR',
    public readonly details?: unknown,
    public readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (code: string, message: string) => new HttpError(401, message, code);
export const forbidden = (code = 'FORBIDDEN', message = 'You do not have permission to do this') =>
  new HttpError(403, message, code);
export const notFound = (message = 'Resource not found') => new HttpError(404, message, 'NOT_FOUND');
