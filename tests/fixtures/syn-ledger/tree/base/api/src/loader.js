import { creditInterest } from './jobs/interest.js';

const DAY = 24 * 60 * 60 * 1000;

export function registerJobs(pool) {
  setInterval(() => {
    creditInterest(pool, new Date()).catch((error) => console.error('interest', error));
  }, DAY);
}
