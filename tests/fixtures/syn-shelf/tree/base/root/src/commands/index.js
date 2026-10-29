import { add } from './add.js';
import { finish } from './finish.js';
import { list } from './list.js';
import { remove } from './remove.js';
import { stats } from './stats.js';

// The command table: shelf <name> runs commands[name].
export const commands = {
  add,
  list,
  finish,
  remove,
  stats,
};
