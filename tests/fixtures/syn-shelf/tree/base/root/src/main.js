import { commands } from './commands/index.js';
import { bus } from './events.js';
import { loadPlugins } from './plugins/index.js';
import { store } from './store.js';

// Runs one shelf command: shelf <command> [arguments].
export function run([name, ...args]) {
  const command = Object.hasOwn(commands, name ?? '') ? commands[name] : null;
  if (!command) throw new Error(`Unknown command: ${name ?? '(none)'}. Commands: ${Object.keys(commands).join(', ')}.`);
  store.load();
  loadPlugins(bus, store);
  command(args);
}
