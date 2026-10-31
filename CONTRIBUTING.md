# Contributing

Use the prerequisites and installation steps in
[Getting started](docs/getting-started.md). Runtime and tooling are in
`packages/`; Python API declarations are in `sdk/`. Keep changes and checks
focused on the affected package or example.

## Code changes

Use the package's existing conventions and add a regression test for a bug fix.
For example, from the repository root:

```sh
pnpm --filter @parallax/cli exec vitest run src/new.test.ts
pnpm --filter @parallax/cli typecheck
```

Transpiler tests use Python's standard test runner. From `packages/transpiler/`:

```sh
python3 -m unittest tests.test_conformance
```

## Documentation changes

Keep explanations in `docs/` and agent workflow in
`skills/parallax-game/SKILL.md`. Link to the canonical explanation instead of
copying it into the skill or another guide. Run documented examples against a
temporary game, and check that links work on GitHub and the documentation site.

API pages and the error catalog are generated. Change the SDK declarations or
engine sources, then regenerate from the repository root:

```sh
python3 tools/gen_api_docs.py
python3 tools/gen_error_catalog.py
```

Both scripts accept `--check` to verify that their output is current without
writing files.

## Pull requests

Describe the problem, the resulting behavior, and the checks you ran. For bugs,
include the smallest useful reproduction and any diagnostic codes. Include text
evidence for tests; keep screenshots and recordings out of git.
