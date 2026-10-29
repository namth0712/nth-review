// Keeps the finished total that `shelf stats` shows.
export function recordFinished(store) {
  store.data.stats.finishedCount += 1;
  store.save();
}
