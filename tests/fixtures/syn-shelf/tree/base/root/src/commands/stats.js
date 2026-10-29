import { store } from '../store.js';

// shelf stats: how many books have been finished.
export function stats() {
  const { finishedCount } = store.data.stats;
  console.log(`Finished books: ${finishedCount}.`);
}
