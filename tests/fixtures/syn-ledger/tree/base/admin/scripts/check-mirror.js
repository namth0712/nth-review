import fs from 'node:fs';
import path from 'node:path';

const apiRoot = process.argv[2];
if (!apiRoot) {
  console.error('usage: node scripts/check-mirror.js <path to api>');
  process.exit(2);
}
const source = fs.readFileSync(path.join(apiRoot, 'src', 'shared', 'limits.js'), 'utf8');
const mirror = fs.readFileSync(new URL('../src/shared/limits.js', import.meta.url), 'utf8');
if (source !== mirror) {
  console.error('src/shared/limits.js differs from the api copy');
  process.exit(1);
}
console.log('limits mirror is current');
