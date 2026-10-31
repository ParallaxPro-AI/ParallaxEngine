/**
 * @parallax/check — project validation and codegen. Diagnostics use the shared format from `@parallax/runtime/core`.
 */

export type { Diagnostic } from '@parallax/runtime/core';
export { checkFiles, checkProject, formatResult, resultJson } from './check.js';
export type { CheckProjectOptions, CheckResult } from './check.js';
export type { CheckOptions } from './context.js';
export { generateProject } from './codegen.js';
export type { ProjectModule } from './codegen.js';
export type { Declarations } from './declarations.js';
export { runExtract } from './extract.js';
export { directoryFiles, memoryFiles } from './files.js';
export type { ProjectTree } from './files.js';
export { main } from './cli.js';
