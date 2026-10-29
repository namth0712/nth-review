export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

export function notFound() {
  return new HttpError(404, 'not found');
}
