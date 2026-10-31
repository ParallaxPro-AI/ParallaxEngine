// Boots a compiled build headless against the runtime source and runs it for N frames:
//   PARALLAX_BUILD=<build> node --import ./register.mjs boot_build.mjs <project_dir> <build_dir> [frames]
// The build needs the transpiler's modules plus `parallax check`'s project.js.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

const [projectDir, buildDir, frameArg] = argv.slice(2);
const frames = Number(frameArg ?? 120);
const manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(projectDir, path)];
  });
}
const paths = walk(projectDir).filter((p) => !p.endsWith('.py') && !p.includes('__pycache__')).sort();
const files = { list: () => paths, read: (p) => readFileSync(join(projectDir, p), 'utf8') };

const { bootHeadless } = await import(new URL('../../../runtime/src/boot/headless.ts', import.meta.url).href);
const entry = await import(pathToFileURL(join(buildDir, manifest.entry)).href);
const game = await bootHeadless({ entry, files });
game.frames(frames);
console.log(JSON.stringify({ booted: true, frames, warnings: game.warnings.map((w) => w.code) }));
game.stop();
