// Prints pyrt's surface as JSON: its exports, the method dispatcher's names, and the
// members of each stdlib shim (what the transpiler is allowed to emit references to).
const rt = await import('parallax/__rt__');
const shims = Object.fromEntries(['math', 'random', 'enum', 'dataclasses', 'typing', 'collections']
  .map((m) => [m, Object.keys(rt[m])]));
process.stdout.write(JSON.stringify({ exports: Object.keys(rt), methods: Object.keys(rt.M), shims, types: Object.keys(rt.types) }));
