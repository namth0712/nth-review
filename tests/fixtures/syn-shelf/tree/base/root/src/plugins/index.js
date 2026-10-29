import { recordFinished } from './stats.js';

// Registers the built-in plugins on the event bus. main.js calls this once per command.
export function loadPlugins(bus, store) {
  bus.on('book.finished', () => recordFinished(store));
}
