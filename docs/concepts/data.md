# Data and state

Declare data with annotated classes. The declaration gives the checker a schema for
Python and JSON; the runtime uses it to construct and save values.

| Data | Declaration | Access |
|---|---|---|
| Per-entity state | `@component("id")` | `entity.get(Type)` |
| Shared runtime state | `@resource("id")` | `ctx.get(Type)` |
| Read-only tunables | `@config("id")` | `ctx.config(Type)` |
| Read-only content entries | `@content("kind")` | `ctx.content(Type)` |
| Behavior settings | `param()` fields | `self.field` |
| Behavior runtime state | `state()` fields | `self.field` |

Custom components contain data, not methods. Put logic in
[behaviors and systems](logic.md). Use `tag("enemy")` for a marker with no fields.

## Runtime state

```python
from parallax import component, field, resource


@component("cargo")
class Cargo:
    amount: int = field(0, min=0)


@resource("run")
class Run:
    score: int = field(0)


@resource("best", keep="profile")
class Best:
    score: int = field(0)
```

A prefab supplies component values under its `components` object:
`{"components": {"cargo": {"amount": 3}}}`. During play,
`ctx.get(Run).score += 10` changes shared state.

Resources have a lifetime, set by `keep=` on the class or an individual `field()`:

| Lifetime | Reset and persistence |
|---|---|
| `"scene"` | Resets on every scene load. |
| `"run"` (default) | Survives scene changes; resets when a scene loads with `new_run=True`. Included in slot saves. |
| `"session"` | Survives scene changes and new runs; never written to disk. |
| `"profile"` | Saved on the device, for values such as best scores and unlocks. |

`ctx.reset(Run)` restores that resource's defaults. Scene loads recreate entities,
so components and behavior state do not carry across them. A behavior's `state()`
fields are included in saves and snapshots of its entity.

## Config and content

Config stores one document of tunables. This definition reads `config/rules.json`:

```python
from parallax import config, field


@config("rules")
class Rules:
    win_score: int = field(5, min=1)
```

```json
{"win_score": 5}
```

Read it with `ctx.config(Rules).win_score`. Content uses one file per entry instead:

```python
from parallax import Localized, content, field


@content("enemy", order="rank")
class EnemyDef:
    rank: int = field(0)
    name: Localized = field()
    health: int = field(10, min=1)
```

`content/enemy/scout.json`:

```json
{"rank": 1, "name": "Scout", "health": 20}
```

`ctx.content(EnemyDef)` returns entries ordered by `rank` (by id without `order=`).
Each entry is a typed reference; its fields are under `.data`.
`Content.enemy.scout.data.health` reads this entry directly.

Use `Localized` for player-facing text in content or config. Write the source text
in JSON and display it with `ctx.text(entry.data.name)`. Interface locale keys and
panel text are covered in [UI](ui.md).

## Fields and nested values

`field()` declares defaults and metadata such as `min`, `max`, `unit`, and `doc`.
Bounds validate defaults and authored data; ordinary assignments during play are
not automatically checked or clamped. List and dict defaults are copied per instance.

Use `@record` for nested data rather than `@dataclass`:

```python
from parallax import field, record


@record
class Reward:
    coins: int = field(0, min=0)
```

A schema can then declare `reward: Reward = field(Reward(coins=10))`.
Fields support value types, typed references, records, string-valued enums, and
containers. See [the core API](../reference/parallax.md) for `field`, `param`,
`state`, and the supported field types; [save](../reference/parallax.save.md)
for save slots and migrations.
