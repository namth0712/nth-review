// A small synchronous event bus: listeners run in the order they were added.
const listeners = new Map();

export const bus = {
  on(name, listener) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(listener);
  },

  emit(name, payload) {
    for (const listener of listeners.get(name) ?? []) listener(payload);
  },
};
