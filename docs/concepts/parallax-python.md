# Parallax Python

Parallax Python transpiles a checked subset of Python to JavaScript. Games run in the
engine, not CPython, and cannot access the host filesystem or install Python packages.
Unsupported syntax and disallowed imports produce diagnostics with suggested rewrites.

## Writing logic

The subset includes functions, closures, classes with single inheritance, properties,
loops, exceptions, comprehensions, unpacking, slices, f-strings, and async functions.
Lists, dictionaries, tuples, sets, and strings provide Python-style operations.
Use `async def` with the engine's tasks or playtest harness for sequences over time.

Some familiar Python features need a different approach:

| Instead of | Use |
|---|---|
| `with` | `try` / `finally` |
| `match` | `if` / `elif` |
| Generator functions (`yield`) | A list, or an async task for timed sequences |
| `async for` | A plain loop |
| Multiple inheritance or metaclasses | A single base class and composition |
| Byte strings | Strings or lists of integers |
| `%` string formatting or `str.format()` | F-strings |
| `getattr(obj, computed_name)` | Direct access, or a literal attribute name |
| `open()`, `eval()`, `exec()` | Engine APIs and declared data |

Regular classes may have methods. Engine schema classes have their own rules:
custom components are data only, and nested field values use `@record`.
See [data](data.md) and [logic](logic.md).

## Imports

Import SDK names and project references explicitly:

```python
from parallax import Behavior, behavior, param
from parallax.physics import Rigidbody
from project import Prefabs
from game.rules import winning_line
```

Imports may use the SDK, generated `project` module, the game's own modules, or the
supported standard-library members below. `import math` and `import random` work;
for SDK and local modules, use `from ... import ...`. Star imports are rejected.

| Module | Available support |
|---|---|
| `math` | Common constants, arithmetic, trigonometry, and numeric helpers |
| `random` | Engine-seeded random numbers, sampling, and shuffling |
| `enum` | `Enum`, with string or integer literal values |
| `typing`, `collections.abc` | Supported type annotations |
| `collections` | `deque`, `Counter`, `defaultdict` |
| `dataclasses` | `dataclass`, `field`, `replace`; use `parallax.record` for engine schemas |

This is a limited library, not the full Python standard library. Imports such as
`os`, `time`, `json`, `itertools`, and `functools` are rejected. Use `ctx.time` for
game time, config/content files for authored data, and resources for saved state.
The [transpiler's supported-name tables](https://github.com/ParallaxPro-AI/ParallaxEngine/blob/main/packages/transpiler/parallax_transpiler/names.py)
list individual builtins and standard-library members.

## Differences from CPython

- **Numbers share JavaScript's number representation.** Integer literals beyond
  ±2**53 are rejected; arithmetic outside the exact integer range can lose precision.
  The runtime cannot distinguish an integral float from an integer:
  `isinstance(3.0, float)` is false, and `isinstance(3.0, int)` is true.
- **Some integral floats print as integers.** When the transpiler cannot infer the float
  type, a value such as `3.0` may display as `3`. Use an explicit format such as
  `f"{value:.1f}"` when the decimal place matters.
- **Sets iterate in insertion order.** Do not rely on CPython's set iteration order.
- **Randomness is engine-seeded.** It is reproducible within the engine; do not assume
  the same sequence as CPython for the same seed.

Engine values such as `Vec2`, `Vec3`, and `Color` are immutable. Replace a vector
rather than changing one coordinate in place:
`entity.transform.position = entity.transform.position.with_x(1)`.
See [value types](../reference/parallax.values.md) and the
[core API](../reference/parallax.md).

Run `parallax check <dir>` after edits and use [tests](testing.md) to verify behavior.
The [diagnostics guide](diagnostics.md) explains how to read transpiler errors.
