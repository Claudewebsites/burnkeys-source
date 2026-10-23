// Every line Burnkeys prints goes through here.
// Any secret value seen during this run is registered, and scrubbed from output
// as a last line of defence - even if some other code path tries to print it.

const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

export function scrub(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

let sink = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

// Tests swap the sink to capture output.
export function setSink(newSink) {
  const previous = sink;
  sink = newSink;
  return previous;
}

export function print(...parts) {
  sink.out(scrub(parts.join(' ')) + '\n');
}

export function printErr(...parts) {
  sink.err(scrub(parts.join(' ')) + '\n');
}
