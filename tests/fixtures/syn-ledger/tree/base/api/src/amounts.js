import { HttpError } from './http.js';
import { LIMITS } from './shared/limits.js';

export function parseAmount(value) {
  if (!Number.isInteger(value) || value <= 0 || value > LIMITS.maxTransferCents) {
    throw new HttpError(400, 'invalid amount');
  }
  return value;
}
