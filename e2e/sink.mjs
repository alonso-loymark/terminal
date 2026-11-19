// Records, byte for byte, the input a terminal delivers to a program (raw mode, no line editing),
// so a test can compare it with what was typed. Echoes like a shell would (rendering load while
// typing). Ends on Ctrl+D (0x04): writes "SINK fin <bytes>" and exits.
//
//   node e2e/sink.mjs <output file>
import fs from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('uso: node sink.mjs <archivo>');
  process.exit(2);
}
fs.writeFileSync(out, '');
let total = 0;
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const end = chunk.indexOf(0x04);
  const data = end >= 0 ? chunk.subarray(0, end) : chunk;
  fs.appendFileSync(out, data);
  total += data.length;
  process.stdout.write(data);
  if (end >= 0) {
    process.stdout.write(`\r\nSINK fin ${total}\r\n`);
    process.stdin.setRawMode(false);
    process.exit(0);
  }
});
process.stdout.write('SINK listo\r\n');
