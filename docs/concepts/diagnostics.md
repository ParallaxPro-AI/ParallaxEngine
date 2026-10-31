# Diagnostics

The checker, transpiler, and runtime report problems with stable `PP` codes.
A diagnostic identifies the problem, its location when known, a suggested fix,
and a documentation link.

```text
PP2041  Unknown prefab "brik"
  at scenes/level_1/scene.json  (/entities/3/prefab)
  Fix: Change "brik" to "brick".
  Docs: https://parallaxpro.ai/docs/engine/errors/PP2041
```

For JSON data, the location may include a JSON pointer such as
`/entities/3/prefab`. For code, it may include a line number. Read the suggested
fix in context, correct the source file, and check again: several diagnostics
can come from one broken declaration or reference.

## Check a project

From the engine checkout, with a game at `../my-game`:

```sh
pnpm parallax check ../my-game --json
```

The JSON result contains `errors`, `warnings`, and `diagnostics`. An error makes
the check fail. Warnings describe problems that do not block the command;
inspect them rather than treating a successful exit as a clean report.

By default, `check` transpiles Python, validates project data and references, and
writes transpiled modules and generated declarations under the game's `build/`.
Use `--no-write` to check without keeping generated output. `build` also checks
transpiled module links and can pack asset bundles. Neither command proves that
gameplay behaves correctly; use [playtests](testing.md) for that.

The [CLI reference](../cli.md) explains the check options, including checks when
asset files are unavailable. Look up individual codes in the
[error catalog](../errors/README.md); its
[JSON catalog](../errors/catalog.json) is available for tools.
