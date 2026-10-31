# Assets

Assets live under `assets/`. Game code uses generated references from `project`;
JSON uses handles such as `"models/crate"` rather than filenames.

## References and files

| File | Python | JSON handle |
|---|---|---|
| `assets/models/crate.model.json` | `Assets.models.crate` | `"models/crate"` |
| `assets/images/portrait.png` | `Assets.images.portrait` | `"images/portrait"` |
| `assets/sfx/hit.ogg` | `Assets.sfx.hit` | `"sfx/hit"` |
| `assets/music/theme.ogg` | `Assets.music.theme` | `"music/theme"` |
| `assets/vfx/sparks.vfx.json` | `Assets.vfx.sparks` | `"vfx/sparks"` |
| `assets/clips/wave.clip.json` | `Assets.clips.wave` | `"clips/wave"` |

The handle omits `assets/` and everything from the filename's first dot onward.
Use distinct names within each folder. HTML and CSS use file paths for their own
images, styles and fonts; those are not asset-handle fields.

## Reuse the library

From an engine checkout, search for pieces and copy one into a project:

```sh
pnpm parallax library search wooden crate
pnpm parallax library add crate ../my_game
```

`pnpm parallax library list` prints every piece. Pieces may include a model, prefab, clips or gameplay code. Dependencies are copied
too; read the command's setup steps before placing the result. The copied files
belong to the project and can be edited. There is no library dependency at runtime.

## Models and animation

Use a `shape` component for simple geometry, a JSON `.model.json` document for an
editable model assembled from parts, or `.glb` / `.gltf` for imported geometry.
A prefab's model component refers to any of these by handle:

```json
{ "components": { "model": { "model": "models/crate" } } }
```

Model documents describe materials, parts, joints, sockets and customization options.
Their format is defined in
[the model specification](https://github.com/ParallaxPro-AI/ParallaxEngine/blob/main/packages/runtime/src/resource/models/format.ts).
Keep collision geometry in a separate collider component; a rendered model alone
does not make a physical body.

An `animator` plays skeletal clips or an animation graph. Imported models can carry
their own clips (`Assets.models.hero.clips.walk` in Python, `"models/hero#walk"` in
JSON). Authored `.clip.json` files are separate assets. A rig alone supplies no
motion: library characters may need a clips piece such as `humanoid_locomotion`.
The [characters plugin](../reference/parallax.characters.md) can select locomotion
clips automatically; use the [Animator API](../reference/parallax.md#animator) for
explicit playback and graphs.

## Sound and effects

Play a sound with `ctx.audio.play(Assets.sfx.hit)`. Set a scene's `"music"` to
`"music/theme"`, or use `ctx.audio.music(Assets.music.theme)`. Defaults for volume
and pitch belong in `assets/audio.json`, keyed by handle:

```json
{ "sfx/hit": { "volume": 0.4, "pitch": [0.95, 1.05] } }
```

`Synth` provides generated sounds without recordings. `Effect` provides built-in
3D effects; for example, `ctx.vfx.play(Effect.impact, at=position)`. Custom effects
live in `.vfx.json` files; extending `"effect/impact"` lets one reuse a built-in.
Use the [audio and VFX API](../reference/parallax.md) for playback options.

## Missing files and remote assets

`parallax check` normally checks that referenced local assets exist.
`--no-asset-files` permits missing files during development; it still checks handle
spelling and kind. Missing models may draw nothing, missing 2D images use stand-ins,
and missing sounds are silent. Restore normal checking before calling the project
complete.

The engine accepts supported hosted asset URLs in some asset fields, but not
arbitrary remote URLs. Checking validates their form without downloading them;
headless runs do not fetch them. A passing check or playtest therefore cannot
confirm their appearance, sound, clip names or rig. Verify those in the browser;
see [testing](testing.md).
