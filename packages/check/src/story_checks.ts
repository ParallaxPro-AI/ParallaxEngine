/**
 * Dialogue against the game: every `.yarn` file parses (the story plugin's own parser, so
 * check and runtime agree), and names only declared facts, with the right types, and
 * declared `@dialogue_command`s (`checkDialogue`).
 *
 * Dialogue in translations: a line's source text is its .yarn file, not locale/en.json, so a
 * translation (`locale/<lang>.json`) holds every line key (`story.<file>.<line>`), and those
 * keys are not "missing from en" (the resource loader's PP2061 knows only en.json keys).
 */

import { checkDialogue } from '@parallax/runtime/plugins/story';
import type { DialogueScope, ValueType } from '@parallax/runtime/plugins/story';
import type { CheckContext } from './context.js';

/** A fact's type from its declared default; undefined for a default fact() itself rejects. */
function factType(value: unknown): ValueType | undefined {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return undefined;
}

export function dialogueScope(ctx: CheckContext): DialogueScope {
  const facts = new Map<string, ValueType>();
  for (const [key, decl] of Object.entries(ctx.decl.facts)) {
    const type = factType(decl.default);
    if (type !== undefined) facts.set(key, type);
  }
  const commands = new Set(Object.values(ctx.decl.functions)
    .filter((f) => f.kind === 'dialogue_command' && f.id !== undefined)
    .map((f) => f.id!));
  return { facts, commands };
}

export function checkStory(ctx: CheckContext): void {
  if (ctx.dialogueFiles.size === 0) return;
  const scope = dialogueScope(ctx);
  for (const parsed of ctx.dialogueFiles.values()) {
    ctx.out.push(...parsed.diagnostics);
    if (parsed.doc !== undefined) ctx.out.push(...checkDialogue(parsed.doc, scope));
  }
  translations(ctx);
}

function translations(ctx: CheckContext): void {
  const translated = [...ctx.project.locales.values()].filter((l) => l.language !== SOURCE_LANGUAGE);
  const paths = new Set(translated.map((l) => l.path));
  const kept = ctx.out.filter((d) => !(d.code === 'PP2061' && d.path !== undefined && paths.has(d.path)
    && d.pointer !== undefined && ctx.dialogueKeys.has(d.pointer.slice(1))));
  ctx.out.splice(0, ctx.out.length, ...kept);
  for (const locale of translated) {
    for (const key of [...ctx.dialogueKeys].sort()) {
      if (key in locale.strings) continue;
      ctx.report('PP2060', `Dialogue line "${key}" is missing in ${locale.language}`, {
        path: locale.path, fix: `Add "${key}": the line ("Speaker: text") from story/${key.split('.')[1]!}.yarn, translated.`,
      });
    }
  }
}

const SOURCE_LANGUAGE = 'en';
