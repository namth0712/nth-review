import { HttpError } from './http.js';

const sessions = new Map();

export function startSession(token, customerId) {
  sessions.set(token, { customerId });
}

export function requireSession(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const session = sessions.get(token);
  if (!session) throw new HttpError(401, 'unauthenticated');
  return session;
}
