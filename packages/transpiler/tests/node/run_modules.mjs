// Runs compiled snippet modules in order and prints {name: output} as JSON. Each
// module's print() output is captured; an uncaught Python exception is reported the way
// the CPython side reports it: "<TypeName>: <str(exc)>".
import { argv, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const rt = await import('parallax/__rt__');
const { setActiveRandom } = await import(new URL('../../../runtime/src/api/random.ts', import.meta.url).href);
const { SeededRandom } = await import(new URL('../../../runtime/src/core/index.ts', import.meta.url).href);

const modules = JSON.parse(readFileSync(argv[2], 'utf8'));
const results = {};
let out = '';
rt.setPrintSink((text) => { out += text; });
for (const { name, path } of modules) {
  out = '';
  setActiveRandom(new SeededRandom(7));
  try {
    const mod = await import(pathToFileURL(path).href);
    const gen = typeof mod.main === 'function' ? mod.main() : undefined;
    if (rt.isCoroutine(gen)) {
      for (let step = gen.next(); !step.done; step = gen.next(`sent:${rt.repr(step.value)}`)) out += `yield ${rt.repr(step.value)}\n`;
    }
  } catch (e) {
    if (e instanceof rt.BaseException) out += `${e.constructor.name}: ${rt.str(e)}\n`;
    else out += `JS-ERROR ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)}\n`;
  }
  results[name] = out;
}
stdout.write(JSON.stringify(results));
