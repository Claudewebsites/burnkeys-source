import { createInterface } from 'node:readline';

let lineIterator = null;

// Read one line from piped (non-terminal) stdin. Used by tests and scripts.
async function readPipedLine() {
  if (!lineIterator) {
    lineIterator = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  }
  const { value, done } = await lineIterator.next();
  return done ? '' : value;
}

// Ask for a secret without echoing it to the screen.
export async function promptHidden(question) {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    const line = await readPipedLine();
    process.stderr.write('\n');
    return clean(line);
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { // Ctrl-C
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        } else if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write(buf.length ? '  (received)\n' : '\n');
          resolve(clean(buf));
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function clean(s) {
  // Strip bracketed-paste markers and surrounding whitespace/quotes.
  return s.replace(/\x1b\[20[01]~/g, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

// Ask a normal (visible) question, e.g. a yes/no confirmation.
export async function promptVisible(question) {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    const line = await readPipedLine();
    process.stderr.write('\n');
    return line.trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  return answer.trim();
}
