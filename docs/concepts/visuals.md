# Making a game look good

Most of a game's look is engine data, not code. Ground, trees, sky, weather,
water, buildings, lights and effects are blocks on a scene or components on a
prefab. Use them instead of building scenery from primitive boxes and cones. This
guide maps what a game needs to the feature that provides it, gives a minimal
working snippet for each, and ends with a [catalog](#capability-catalog) of every
engine capability.

Each snippet passes `parallax check`. Full field lists are in the linked
reference pages. The [cheatsheet](../cheatsheet.md) covers the code side.

Making a 2D game? Read the [quality bar for a 2D game](#quality-bar-for-a-2d-game)
and [2D games](#2d-games) instead. Most of the 3D sections below (terrain,
foliage, sky, weather, water, models) don't draw in 2D.

## Quality bar for a 3D game

Check the game against this list before calling it finished:

- [ ] **Props and characters come from the library.** Trees, rocks, crates, fences,
  furniture, vehicles and people are library models (`library search`), not
  stacked `shape` primitives. When nothing fits, author a `.model.json` document.
  Use shapes only for gameplay blockers, triggers and abstract pieces.
- [ ] **Characters are animated.** A rigged model has an `animator` and clips, and
  never stands in a T-pose.
- [ ] **Outdoor ground fits the setting.** Use `terrain` with material layers and
  paths rather than one flat, untextured box when the play space is outdoors.
- [ ] **Nature is scattered, not hand-placed.** Grass, trees, bushes and rocks come
  from a `foliage` block.
- [ ] **Outdoor scenes have sky, sun and air.** Set a `sky` (`atmosphere` for most),
  a `time_of_day`, light fog or haze and clouds. Add `weather` and `wind` where they fit.
- [ ] **The scene is lit on purpose.** One shadow-casting sun, an `ambient` color,
  and point or spot lights on lamps, fires and windows.
- [ ] **Actions have feedback that fits them.** Impacts, landings, pickups and
  footsteps play an effect (`ctx.vfx.play`) and a sound, sized to what caused them.
  Moving things kick up dust or leave trails. Only things that blow up explode;
  scores and celebrations show in the UI and sound.
- [ ] **The image is graded.** A light `post` block sets bloom, vignette, contrast
  and saturation.
- [ ] **Buildings and tracks are generated.** Houses, shops and lodges are
  `structure` floor plans. Roads, rails, slopes and circuits are a `spline` with a
  `sweep` or `track`.
- [ ] **The world sounds alive.** Music plays, one-shots use `Synth` or recordings,
  and loops use `audio_source`. Weather, water and wind sound by themselves.

## Quality bar for a 2D game

A 2D game is drawn with sprites, shapes, tilemaps and particles. Check it
against this list before calling it finished:

- [ ] **Things are drawn, not just boxes.** The player, enemies, pickups and
  props are `sprite`s with an image. When you have no image, write a small SVG
  in `assets/images/` (see [art for a 2D game](#art-for-a-2d-game)). Keep plain
  colored `shape`s for things meant to be abstract: a paddle, a board cell, a
  number tile.
- [ ] **Things that move are animated.** A character has sprite `animations`
  (idle, run, jump, hit) and plays the right one. It faces where it's going
  with `flip_x`.
- [ ] **The background is chosen.** The camera sets a `background` color, and a
  large backdrop sprite or scrolling layers at a low `z` fill the play area.
  A side-scroller gets [parallax layers](#background-and-parallax-layers).
- [ ] **Draw order is set on purpose.** Every prefab that overlaps others has a
  top-level `"z"`: backdrop lowest, then the level, pickups, characters and
  effects on top.
- [ ] **Actions have feedback that fits them.** Hits, pickups, merges and deaths
  play a `.vfx.json` effect (`ctx.vfx.play(Assets.vfx.<name>, at=...)`) and a
  sound. Big moments add `camera.shake`, a short `ctx.time.hitstop` or a
  tween. The built-in `Effect.*` set is 3D only.
- [ ] **The level is a tilemap when it's a grid of blocks.** Platforms, walls
  and floors come from one `tilemap` with `collide`, not dozens of placed boxes.
- [ ] **The camera frames the play.** A fixed screen uses `fit`; a level wider
  than the screen uses `"rig": "follow"` with `smoothing` and `bounds`.
- [ ] **The image has a mood.** Glowing things use `"blend": "additive"`, and a
  light `"post"` adds bloom and a vignette. Night or dungeon scenes use 2D
  `light`s over a dark `ambient`.
- [ ] **The game sounds alive.** Music plays, and every action has a sound.

## Feature map

| The game needs | Engine feature | Where it goes | Example game |
|---|---|---|---|
| Trees, rocks, props, furniture, vehicles, people | [Library models](#library-models) | `pnpm parallax library add` | `open_world_rpg` (`assets/models/`) |
| A prop the library lacks | [Model documents](#authoring-a-model-the-library-lacks) | `assets/models/<name>.model.json` | `open_world_rpg` (`assets/models/`) |
| Hills, valleys, roads, beaches | [Terrain](#terrain) | Scene `"terrain"`, `terrain()` | `open_world_rpg`, `racing`, `tank_battle` |
| Forests, grass, bushes, scattered rocks | [Foliage](#foliage-and-nature-scatter) | Scene `"foliage"`, `foliage()` | `open_world_rpg`, `racing`, `moba` |
| Blue sky, sunsets, night, clouds | [Sky and time of day](#sky-atmosphere-and-time-of-day) | Scene `"environment"` | `open_world_rpg`, `cargo_plane` |
| Day and night cycle | [Sky and time of day](#sky-atmosphere-and-time-of-day) | `"day_length"` | `voxel_survival` |
| Rain, snow, storms, fog, lightning | [Weather](#weather-and-wind) | `"environment": {"weather": ...}`, `weather()` | `pirate_sailing`, `racing`, `voxel_survival` |
| Swaying trees, blowing debris, sails | [Wind](#weather-and-wind) | Scene `"wind"`, `wind()` | `racing`, `pirate_sailing` |
| Oceans, lakes, pools, rivers, floating boats | [Water](#water) | `water_body` component, `water()` | `pirate_sailing`, `cargo_plane` |
| Sun, shadows, lamps, fires | [Lighting](#lighting-and-shadows) | `light` component, `"sun"` | `horde_survival` |
| Impacts, sparks, dust, splashes, fire, smoke | [Particles and effects](#particles-and-effects) | `ctx.vfx.play`, `particles`, `.vfx.json` | `fps_shooter`, `pirate_sailing`, `platformer` |
| Bloom, color grade, stylized looks | [Post-processing](#post-processing) | `"environment": {"post": ...}` | `racing`, `tank_battle` |
| Hit flashes, dissolves, glow, heat shimmer | [Surface effects](#surface-and-screen-effects) | `surface_fx`, `heat_haze`, `outline` | `horde_survival`, `racing` |
| Houses, shops, lodges, multi-storey buildings | [Structures](#buildings-tracks-and-generated-geometry) | `structure` component, `.plan` file | `open_world_rpg`, `fps_shooter`, `coop_cooking` |
| Race circuits, roads, rails, coasters, pipes, slopes | [Splines, sweeps and tracks](#buildings-tracks-and-generated-geometry) | `spline` with `sweep` or `track` | `racing` |
| Dungeons with keys and locks | [Dungeons](#buildings-tracks-and-generated-geometry) | `dungeon` component | none yet |
| A whole city with traffic | [City](#capability-catalog) | Scene `"city"`, `city()` | `open_world_sandbox` |
| Walking, running and jumping animation | [Character animation](#character-animation) | `animator`, clip pieces | `platformer`, `open_world_rpg` |
| Sound effects, ambience and music | [Sound](#sound) | `Synth`, `.synth.json`, `audio_source` | `fighting_game`, `moba`, `lane_defense` |

## Library models

The shared library holds about 2,300 ready-made pieces: models with fitted
colliders, clip sets for humanoids and quadrupeds, and small gameplay and UI
kits. Search it by words, then copy pieces into the project:

```sh
pnpm parallax library search pine tree
pnpm parallax library search boulder --limit 5
pnpm parallax library add tree_pine rock_boulder_large knight humanoid_locomotion ../my_game
```

`search` ranks pieces by words in their id, category and summary. `--category models` (or `clips`,
`props`, `gameplay`, `ui`) narrows it, and `--json` gives a machine-readable
list. `pnpm parallax library list` prints everything. `add` copies each piece's
prefab, model and dependencies, adds the plugins it needs to `game/main.py`, and
prints setup steps.

A copied model is placed like any prefab:

```json
{ "id": "big_pine", "prefab": "tree_pine", "at": [-8, 0, 6] }
```

Many models declare options, colors and joints (`"options": {"paint": "red"}`,
`Model.set_color`, `Model.open("door")`). The `model_variety` piece gives each
copy different options and colors. The `model_ambient` piece spins fans and
opens doors from data. Use library models for hero props and landmarks. Use
[foliage](#foliage-and-nature-scatter) for large numbers of trees and rocks.
See [assets](assets.md) and the [`Model` reference](../reference/parallax.md#model).

## Authoring a model the library lacks

When `library search` finds nothing close, write a model document instead of
scattering `shape` primitives through prefabs and scenes. A document groups the
parts, materials, hinges, attachment points and color options into one asset that
every prefab reuses. Start by copying the closest library model's `.model.json`
(`pnpm parallax library add <id> <project>`, then edit the file under
`assets/models/`). Library and example models are exported, so they may include
`meshes` buffers; hand-written parts use `shape` instead.

This mailbox in `assets/models/mailbox.model.json` has a door that opens and a
color option:

```json
{
  "format": "parallax.model",
  "version": 1,
  "materials": {
    "paint": {"color": "#2f5fa8", "roughness": 0.45, "metallic": 0.3},
    "post": {"color": "#5a4632", "roughness": 0.9},
    "flag": {"color": "#d8342c", "roughness": 0.5}
  },
  "parts": [
    {"name": "post", "shape": "box", "position": [0, 0.5, 0], "size": [0.1, 1, 0.1], "material": "post"},
    {"name": "body", "shape": "box", "position": [0, 1.1, 0], "size": [0.3, 0.25, 0.5], "material": "paint"},
    {"name": "roof", "parent": "body", "shape": "cylinder", "position": [0, 0.125, 0],
     "rotation": [90, 0, 0], "size": [0.3, 0.5, 0.3], "material": "paint"},
    {"name": "door_hinge", "parent": "body", "position": [0, -0.125, 0.25]},
    {"name": "door", "parent": "door_hinge", "shape": "box", "position": [0, 0.14, 0.01],
     "size": [0.3, 0.28, 0.02], "material": "paint"},
    {"name": "flag", "parent": "body", "shape": "box", "position": [0.17, 0.1, -0.1],
     "size": [0.02, 0.2, 0.06], "material": "flag"}
  ],
  "joints": [
    {"name": "door", "part": "door_hinge", "type": "hinge", "kind": "aperture",
     "axis": [1, 0, 0], "limits": [0, 100], "duration": 0.4}
  ],
  "sockets": [
    {"name": "slot", "parent": "body", "position": [0, 0, 0.2]}
  ],
  "options": [
    {"name": "color", "default": "blue", "materials": ["paint"],
     "choices": {"blue": {"color": "#2f5fa8"}, "green": {"color": "#2e7d4f"}}}
  ]
}
```

A prefab uses it with a separate collider:

```json
{
  "components": {
    "model": {"model": "models/mailbox", "options": {"color": "green"}},
    "collider": {"shape": "box", "size": [0.3, 1.3, 0.5], "offset": [0, 0.65, 0]}
  }
}
```

Parts list parents before children; positions are relative to the parent, in
meters, with +z forward. Shapes are `box`, `sphere`, `cylinder`, `cone`,
`capsule` and `plane`, and `size` is the full extent. Materials take the `shape`
component's keys (`color`, `roughness`, `metallic`, `emissive`,
`emissive_strength`, `texture`, `normal_map`). A hinge turns about its part's
origin, so hinge a door with an empty pivot part on the hinge line and the
visible panel as its child. Code calls `entity.get(Model).open("door")`,
`set_option("color", "blue")` and `socket_position("slot")`. The full format is
in [the model specification](https://github.com/ParallaxPro-AI/ParallaxEngine/blob/main/packages/runtime/src/resource/models/format.ts);
`examples/open_world_rpg/assets/models/` has more examples.

## Terrain

Use terrain for any outdoor play space larger than a room. It provides relief,
blended ground materials, painted roads and grading, and works with physics,
navigation, foliage and water. Add `plugins.terrain()`, then a scene block:

```json
"terrain": {
  "size": [400, 400],
  "max_height": 20, "seed": 4,
  "hills": [{"center": [120, 80], "radius": 60, "height": 25, "feather": 40}],
  "flats": [{"center": [0, 0], "size": [60, 60], "height": 2, "feather": 10}],
  "layers": ["grass", "rock", "sand", "road"],
  "default_layer": "grass",
  "rules": [{"layer": "rock", "slope": [28, 38]}],
  "paths": [{"paint": "road", "points": [[0, 0], [100, 40], [160, 120]], "width": 6, "flatten": true}]
}
```

Untextured layers are shaded procedurally by name. For example, `grass`, `rock`,
`sand`, `road` and `snow` each get a matching pattern. Give a layer `"texture"`
and `"normal"` images for more detail. `water_level` floods low ground; see
[water](#water). In code, `ctx.terrain.height_at(p)`, `ground(p)` and
`surface_at(p)` place things and read the ground. `crater`, `trench` and
`flatten` deform it at runtime. Keep every placement inside `size`, because a
query outside the terrain is an error.

See `open_world_rpg/scenes/sundermere/scene.json` (textured layers),
`racing/scenes/terrain_sprint/scene.json`, and the
[terrain reference](../reference/parallax.terrain.md).

## Foliage and nature scatter

Do not build trees from cylinders and cones. Foliage grows procedural trees
(`broadleaf`, `pine`, `birch`, `willow`, `acacia`, `palm`, `dead`), bushes
(`round`, `sprawl`), plants (`fern`, `reed`), rocks (`boulder`, `slab`) and grass.
They sway in the wind, fade to impostors at a distance, and are deterministic.
Add `plugins.foliage()`; with terrain, layers grow `on` and `avoid` terrain
layers:

```json
"foliage": {"layers": [
  {"id": "grass", "kind": "grass", "density": 30, "on": "grass", "avoid": ["road"]},
  {"id": "pines", "kind": "tree", "species": "pine", "density": 0.01, "max": 3000,
   "on": "grass", "avoid": ["road"], "scale": [0.8, 1.3],
   "exclude": [{"center": [0, 0], "radius": 30}], "collide": true},
  {"id": "rocks", "kind": "rock", "density": 0.002, "on": ["grass", "rock"], "scale": [0.6, 1.4]}
]}
```

To scatter a library model instead (snowy pines, a boulder, crop rows), add it
with `library add` and give the layer `"kind": "model"` and its handle:
`{"id": "snowy_pines", "kind": "model", "model": "models/tree_snowy_pine", "density": 0.004, "on": "snow"}`.

`density` is instances per square meter (grass: blades per square meter). Keep
trees around 0.002 to 0.02. Without terrain, give each layer an `"area"`
footprint; instances then sit at y = 0. `ctx.foliage.near(p, r)` and
`ctx.foliage.remove(instance)` support chopping and harvesting. See `racing`
(grass, trees, bushes and rocks avoiding the road), `open_world_rpg`, and the
[foliage reference](../reference/parallax.foliage.md).

## Sky, atmosphere and time of day

The scene's `"environment"` block sets the sky, sun, fog, clouds and color
grade. It needs no plugin:

```json
"environment": {
  "sky": "atmosphere",
  "time_of_day": 16.5,
  "sun": {"intensity": 2.2},
  "ambient": "#adbac8",
  "fog": {"density": 0.002, "color": "#c8d4e0", "height_falloff": 0.03},
  "clouds": {"coverage": 0.35},
  "atmosphere": {"haze": 1.1}
}
```

- **`sky`** is `clear_day`, `atmosphere`, `sunset`, `dusk` or `night`.
  `atmosphere` is physically based: blue noon, red sunsets, starry nights and
  hazy distant hills. Grey and stormy skies come from [weather](#weather-and-wind),
  not from a sky preset.
- **`time_of_day`** (hours) places the sun. **`day_length`** (real seconds per
  game day) runs a day and night cycle. `Light` components with `"when": "night"`
  then switch on at dusk, and `DayChanged` fires at dawn.
- **`fog`** takes exponential `density` or linear `near`/`far`. `height_falloff`
  adds valley mist; `volumetric` (0 to 1) adds light shafts.
- **`skybox`** takes an equirectangular image in place of the sky preset.

At runtime, use `ctx.environment.sky("sunset", seconds=5)`,
`ctx.environment.fog(...)`, `ctx.environment.clouds(...)`, and set
`ctx.environment.time_of_day`. An `environment_zone` component overrides fog,
ambient light and sky tint inside a trigger, such as a cave. See
`cargo_plane/scenes/archipelago/scene.json`, `voxel_survival` (`day_length`), and
[`EnvironmentApi`](../reference/parallax.md#environmentapi).

## Weather and wind

Add `plugins.weather()` and name a preset in the environment block. Presets are
`clear`, `cloudy`, `overcast`, `foggy`, `drizzle`, `rain`, `storm`, `snow`,
`blizzard` and `hail`. Weather greys the sky, dims the sun, wets and snows
surfaces, draws rain only where the sky is open, strikes lightning, and
synthesizes rain, wind and thunder sounds:

```json
"environment": {
  "sky": "atmosphere",
  "weather": {"preset": "clear", "clouds": 0.3, "fog": 0.002, "wind": 4,
              "cycle": {"clear": 3, "cloudy": 2, "rain": 1}, "hold": [90, 240], "blend": 30}
}
```

A plain `"weather": "storm"` also works. While weather is active, it controls fog
density, cloud cover and wind speed. Set those in the weather block, not in
`"fog"`, `"clouds"` or `"wind"`; otherwise `check` warns with PP3382. Change it
from code with `ctx.weather.set("storm", seconds=20)`. Read `ctx.weather.rain`,
`visibility` or `friction` for gameplay.

Wind (`plugins.wind()` and a scene `"wind"` block) sways foliage and cloth and
pushes sails; `ctx.wind.at(p)` reads it. With weather active, give only a
direction:

```json
"wind": {"direction": 90}
```

Without weather, also give `"speed"` and `"gusts"`, plus `"streaks": true` or
`"debris": 24` for visible gusts. See `pirate_sailing/scenes/storm_reef`,
`racing` (per-round weather), `open_world_rpg` (`ctx.weather.set` in quests), and
the [weather](../reference/parallax.weather.md) and
[wind](../reference/parallax.wind.md) references.

## Water

Add `plugins.water()`, listed after `physics3d()`. A `water_body` component is
an ocean, lake, pool or river, with Gerstner waves, reflections, foam and shore
surf:

```json
{"components": {"water_body": {"kind": "lake", "area": {"center": [0, 0], "radius": 20}, "depth": 4}}}
```

The entity's height is the still surface. `pirate_sailing/prefabs/ocean.prefab.json`
is an ocean (`"kind": "ocean", "waves": "calm"`, custom `color` and
`shallow_color`). A terrain `water_level` also counts as water. Boats float with
`"buoyancy": {}` on a rigidbody, and characters swim with `"swim": {}`. Use
`ctx.water.height_at(p)` to place things and `ctx.water.splash(p)` for splashes.
The water's own sound plays automatically. See the
[water reference](../reference/parallax.water.md).

## Lighting and shadows

The brightest directional light with shadows is the sun. Without one, the
environment's sun lights the scene; tune it with `"sun": {"intensity": 2.2,
"color": "#fff9ed"}`. Put point and spot lights on anything that glows. This
brazier from `horde_survival` combines a light and a flame:

```json
{
  "components": {"particles": {"effect": "effect/fire", "emitting": true}},
  "children": [
    {"at": [0, 0.8, 0], "components": {"light": {"kind": "point", "color": "#ffc47c", "intensity": 10, "range": 18, "shadows": true}}}
  ]
}
```

A street lamp that switches on at night uses
`{"light": {"kind": "point", "color": "#ffd08a", "intensity": 2, "range": 12, "when": "night"}}`.
For glowing materials, give a shape or model material `emissive` and an
`emissive_strength` above 1, which blooms. See
[`Light`](../reference/parallax.md#light).

## Particles and effects

Give the moments that matter an effect, matched to what physically happens and
at its real size. Built-in 3D effects need no file: `Effect.impact`, `dust`,
`sparks`, `sparkle`, `smoke`, `fire`, `embers`, `magic`, `muzzle_flash` and
`explosion`.

| What happens | Effect |
|---|---|
| A ball hits pins, a bat hits a ball, a body lands | `impact` or `dust`, small (`scale` below 1) |
| Wheels, boards, skis, feet on dirt, sand or snow | `dust` or a tuned spray, continuous while moving |
| A pickup, a coin, a goal reached | `sparkle` |
| Metal on metal, a grinding rail | `sparks` |
| A bomb, shell, rocket, fuel tank or wreck | `explosion` |
| A strike, a record, a level cleared | UI and sound: a banner, a counter, a fanfare |

Restraint reads as quality. `explosion` brings a flash of light, camera shake and
heat haze, so use it only for things that blow up, never to celebrate a score.
Keep an effect to the size of what caused it, and play it once per event, not
every frame.

```python
from parallax import Effect

ctx.vfx.play(Effect.impact, at=hit.point, direction=hit.normal)   # bullet or sword hit
ctx.vfx.play(Effect.dust, at=self.entity, scale=0.6)              # footsteps, landings, wheels
ctx.vfx.play(Effect.sparkle, at=coin)                             # pickups
ctx.vfx.play(Effect.explosion, at=pos, scale=2)                   # only for things that blow up: light, shake, haze
ctx.vfx.trail(sword, color=Color.hex("#9fd8ff"), seconds=0.3, glow=True)  # swings, dashes, projectiles
ctx.vfx.beam(muzzle, target, color=Color.RED)                    # lasers and tracers
ctx.vfx.lightning(tower_top, enemy_pos)                           # electric arcs
ctx.water.splash(p)                                               # needs water()
```

`play` accepts `color=`, `color_end=`, `scale=`, `direction=` and `count=`.
Continuous emitters, such as torches, chimneys, exhaust and waterfalls, are a
prefab component: `"particles": {"effect": "effect/smoke", "emitting": true}`.

To tune an effect, extend a built-in one in `assets/vfx/<name>.vfx.json` and use
it as `Assets.vfx.<name>` or `"vfx/<name>"`. `pirate_sailing/assets/vfx/splash.vfx.json`
turns smoke into spray:

```json
{"extends": "effect/smoke", "burst": 16, "max": 24, "lifetime": [0.3, 0.8], "speed": [1, 4],
 "direction": 90, "spread": 90, "color": "#cce6ffcc", "color_end": "#cce6ff00", "rate": 0}
```

A `.vfx.json` can also set `"blend": "additive"`, a `"flipbook"`, `"light"`,
`"sound"`, `"shake"`, `"haze"` and child effects. Nearly every example has an
`assets/vfx/` folder to copy from. `fps_shooter` and `tank_battle` have
explosions and muzzle flashes, and `racing` has tire smoke and verge dust. See
[assets](assets.md#sound-and-effects), [`VfxApi`](../reference/parallax.md#vfxapi) and
[`Effect`](../reference/parallax.md#effect).

## Post-processing

The environment `"post"` block grades the final image. Start from a light touch
or a preset:

```json
"post": {"exposure": 1.05, "contrast": 1.08, "saturation": 1.12, "temperature": 0.12,
         "vignette": 0.22, "bloom": 0.14, "god_rays": 0.5}
```

The presets are `cinematic`, `warm`, `cool`, `vivid`, `noir`, `vintage`, `dreamy`,
`retro`, `comic`, `toon`, `horror`, `cyberpunk_neon`, `underwater` and
`night_vision`, as in `"post": {"preset": "cinematic", "bloom": 0.15}`.
`"stylize": {"pixelate": 4, "posterize": 6, "toon": 3, "edges": 1.5}` gives
pixel-art or cel-shaded looks. Other keys include `ambient_occlusion`,
`reflections`, `grain` and `chromatic_aberration`. Switch looks at runtime with
`ctx.environment.post("night_vision", seconds=0.3)`. A `depth_of_field`
component on a camera blurs by distance. The values above come from
`racing/scenes/terrain_sprint`. See
[`EnvironmentApi`](../reference/parallax.md#environmentapi).

## Surface and screen effects

| Effect | Component or call | Use for |
|---|---|---|
| Hit flash, dissolve, rim glow, hologram, scrolling texture | `surface_fx` (`SurfaceFx.flash()`, `dissolve_to()`) | Damage feedback, deaths and spawns, pickups, conveyors (`horde_survival`) |
| Selection outline or x-ray | `outline` | Targets, interactables, teammates |
| Heat shimmer and shockwaves | `heat_haze` (`pulse()`) | Fires, exhausts, explosions (`racing`) |
| Projected images | `decal` | Scorch marks, blood, road paint, posters |
| Glowing material | `emissive` and `emissive_strength` on a shape or model material | Lava, neon, engines |
| Cloth | `cloth` (`plugins.softbody()`) | Flags, capes, banners, sails (`racing`, `horde_survival`) |
| Camera shake and recoil | `ctx.camera.main.shake()`, `kick()` | Impacts, shots |
| Hit-stop and slow motion | `ctx.time.hitstop()`, `ctx.time.ramp()` | Heavy hits, finishers |

All of these are in the [core reference](../reference/parallax.md#surfacefx).

## Buildings, tracks and generated geometry

Add `plugins.procgen()`. These generators build solid, walkable, textured
geometry from a few fields. They cost nothing per frame and replace hundreds of
hand-placed boxes. See the [procgen reference](../reference/parallax.procgen.md).

### Structures from floor plans

Draw a building as text. In a `.plan` file, each storey's rows follow a
`--- <height>` line, and a `--- legend` names the rooms. The characters are `#`
wall, `|` glass wall, `+` door (a run of `+` is one wide door), `_` arch, `=`
window, `>` `<` `^` `v` stairs climbing toward +x, -x, +z and -z, and `.` or a
space for empty ground. A letter or digit is a room. This is
`buildings/lodge.plan`:

```text
--- 3
###########
#LLLLLLLLL#
=LLLLLLLLL=
#LLLLLLLLL#
####+++####
--- legend
L lodge boards
```

The prefab chooses the roof, facade and materials:

```json
{"components": {"structure": {
  "plan": "buildings/lodge.plan", "cell": 1,
  "roof": {"kind": "gable", "pitch": 40},
  "facade": {"shutters": {}},
  "materials": {"wall": {"color": "#b89976", "roughness": 0.95},
                "roof": {"color": "#617e79"},
                "boards": {"color": "#a68661"}}
}}}
```

A legend entry is `<char> <room name> [<floor material>] [<height>]`. Here `L`
is the `lodge` room floored with the `boards` material. The roof `kind` is
`flat`, `gable`, `hip`, `shed` or `none`. A flat roof with `"access": true` can
be climbed. Facades add `plinth`, `shutters`, `mullions`, `awnings` and
`balconies`. `door_prefab` is placed in every door, and a `prop_kit` content
entry (`kit`) furnishes the rooms. Stairs need a room cell at their foot, room
cells above them, and a landing. Code can ask `rooms()`, `doors()`, `stairs()`
and `room_at(p)`.

Use a structure for any enterable building, such as a bowling alley, ski lodge,
shop, house or barracks. See `open_world_rpg/buildings/*.plan` (cottages, an
inn, a blacksmith), `fps_shooter/buildings/*.plan` (two-storey shops and flats
with roof access), and `coop_cooking` (kitchens).

### Splines, sweeps and race tracks

A `spline` is a curve through points. A `sweep` extrudes profiles along it:
`road`, `ribbon`, `kerb`, `wall`, `rail` (a pair), `tube`, `pipe` (ride inside)
and `channel` (a half-pipe). Use it for roads, bridges, coaster rails
(`"frame": "transport"` follows loops), pipes, halfpipes and snowboard or
luge runs. A `track` turns a closed spline into a full race circuit with tarmac,
kerbs, run-off, barriers, crowd stands, a start gantry and signs:

```json
{"components": {
  "spline": {"points": [[0, 0, 60], [60, 0, 0], [0, 0, -60], [-60, 0, 0]], "closed": true,
             "ground": "terrain", "auto_bank": 4},
  "track": {"width": 14, "signs": {"every": 120}}
}}
```

With `"ground": "terrain"`, the terrain under the track is graded to it. Keep
the whole circuit, including its stands, inside the terrain's `size`.
`racing/scenes/terrain_sprint` places its circuit entity at the origin with
points in world coordinates. AI and lap logic call
`entity.get(Spline).nearest(p)`, `progress(p)` and `Track.racing_line()`.

### Dungeons

A `dungeon` component builds a seeded dungeon: rooms, corridors, locked
regions with keys, treasure, enemies and prop-kit dressing.

```json
{"components": {"dungeon": {"seed": 3, "rooms": 8, "tile": 2, "ceiling": true}}}
```

With `locks` above 0, it also needs `key_prefab` and `gate_prefab`.

## Character animation

A rigged model without an animator stands in a T-pose (`check` warns with
PP2130). Library characters use a shared humanoid rig. Add a clip set such as
`humanoid_locomotion`, `humanoid_combat`, `humanoid_leisure`, `humanoid_sports`,
`humanoid_boardsports` (a rider's stance, carves, tuck and grab for snowboards,
skateboards and surfboards) or `quadruped_basics`; clips retarget onto any matching
rig. A rider stands on a board as its child, turned to face the toe edge. On a `Character`, an
empty animator plays idle, walk, run, jump and fall by itself:

```json
{"components": {
  "model": {"model": "models/knight", "cast_shadows": true},
  "character": {"walk_speed": 4, "run_speed": 7, "jump_height": 1.2},
  "animator": {}
}}
```

Without a character, play clips from code: `animator.play(Assets.clips.walk_cycle)`
or `animator.play_once(Assets.clips.cleave_swing)` (from `humanoid_combat`). An animation
graph (states, blends and transitions in prefab data) gives full control;
`platformer/prefabs/player.prefab.json` blends idle and run by speed. See
[assets](assets.md#models-and-animation),
[`Animator`](../reference/parallax.md#animator) and the
[characters reference](../reference/parallax.characters.md).

## Sound

| Need | Use |
|---|---|
| A sound with no file | `ctx.audio.play(Synth.hit_metal, at=p)`. Built-ins include `ui_click`, `hit_wood`, `boom`, `whoosh`, `footstep_soft`, `splash`, `pickup`, `level_up` and `zap` |
| A custom synthesized sound | `assets/sfx/<name>.synth.json`, such as `{"preset": "bell", "gain": 0.6}`, then `Assets.sfx.<name>` (`fighting_game`, `moba`) |
| A loop on an entity | `"audio_source": {"sound": "synth/river", "playing": true, "loop": true, "spatial": true}` |
| Engine noise | `Synth.motor_car`, `motor_boat`, `motor_propeller` or `motor_rotor` in an `audio_source`; change its `pitch` with speed |
| Ambience | `Synth.bed_air`, `bed_deep` and `bed_thicket` loops. Weather, wind and water sound by themselves (`ctx.audio.ambience`) |
| Music | `"music": "music/theme"` in the scene, `ctx.audio.music(...)`, and layered stems with `MusicLayer` |
| Reverb | A `reverb_zone` component (`cave`, `hall`, `forest`, ...) |

See [assets](assets.md#sound-and-effects) and
[`Synth`](../reference/parallax.md#synth).

## 2D games

A game with `Game(mode="2d")` draws with a 2D renderer. The play plane is x/y
in meters, with **y up**. `z` is only draw order (higher draws on top), and a
rotation is an angle in degrees. Start from `pnpm parallax new <dir> --template
blank-2d` or `arcade-2d`, or from a 2D example (`auto_runner`, `bullet_hell`,
`maze_chase`, `match_three`, `chess` and others in [examples](../examples.md)).

| The game needs | Engine feature | Where it goes | Example game |
|---|---|---|---|
| Characters, enemies, pickups, props | [Sprites](#sprites-and-animation) | `sprite` component | `auto_runner`, `bullet_hell` |
| Art you don't have | [SVG images](#art-for-a-2d-game) | `assets/images/<name>.svg` | `maze_chase`, `chess` |
| Running, jumping, chomping | [Sprite animation](#sprites-and-animation) | `sprite.animations`, `Sprite.play` | `maze_chase`, `auto_runner` |
| Abstract pieces: cells, tiles, paddles | [Shapes](#shapes-and-text) | `shape` with `rect`, `circle`, `ring`, `polygon` | `number_merge`, `tic_tac_toe` |
| Platforms, walls, levels made of blocks | [Tilemaps](#tilemaps-and-grids) | `tilemap` component | none yet |
| Boards and grid movement | [Grid](#tilemaps-and-grids) | `grid()`, `Grid`, `GridMover` | `chess`, `match_three`, `maze_chase` |
| Sky color, backdrops, scrolling scenery | [Background](#background-and-parallax-layers) | camera `background`, low-`z` sprites | `auto_runner`, `chess` |
| Following the player, framing a board | [2D camera](#2d-camera) | `camera` component | `bullet_hell`, `match_three` |
| Bursts, sparks, petals, dust, trails | [2D effects](#2d-effects-and-juice) | `.vfx.json`, `ctx.vfx`, `particles` | `tic_tac_toe`, `number_merge`, `bullet_hell` |
| Screen shake, hit-stop, tweens | [Juice](#2d-effects-and-juice) | `camera.shake`, `ctx.time.hitstop`, `move_to` | `bullet_hell`, `number_merge` |
| Torches, night, glow | [2D light and post](#2d-light-and-post) | `light` component, scene `"post"` | none yet |
| Falling, bouncing, colliding | 2D physics | `physics2d()`, `rigidbody`, `collider` ([ref](../reference/parallax.physics.md)) | `auto_runner` |

### Art for a 2D game

There is no sprite library yet, so 2D art comes from image files you add to
`assets/images/`. PNG and SVG both work. When you have no image, write an SVG:
it's small, sharp at any size, and easy to edit. Draw it **white** and tint it
with the sprite's `color`, so one file serves every color. `maze_chase` draws its
hero from three SVGs like this one:

```xml
<!-- assets/images/gobbler_open.svg -->
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <path d="M64 64 L115.40 29.33 A62 62 0 1 0 115.40 98.67 Z" fill="#fff"/>
</svg>
```

Give a character more than a flat silhouette: an outline (`stroke`), an eye, a
lighter top edge or a shadow underneath. Keep the art in one style across the
game: the same outline width, the same palette and the same light direction.

The 2D renderer always smooths images, so very small pixel-art images look soft
when scaled up. Draw pixel art at its final size or use SVG `<rect>`s.

### Sprites and animation

A `sprite` draws an image (or a plain rect of `color` when it has none). `size`
is in meters. A prefab's top-level `"z"` sets its draw order; there is no
other sorting knob.

```json
{
  "z": 2,
  "components": {
    "sprite": {
      "image": "images/dot",
      "size": [0.58, 0.58],
      "color": "#ffe633",
      "animations": {
        "idle": { "frames": ["images/dot"], "fps": 1, "loop": true },
        "chomp": { "frames": ["images/dot", "images/gobbler_half", "images/gobbler_open", "images/gobbler_half"], "fps": 14.3, "loop": true }
      }
    }
  }
}
```

Each frame is its own image; there is no sprite-sheet slicing. In code, switch
with `entity.get(Sprite).play("chomp")` and face the way you move with
`sprite.flip_x = velocity.x < 0`. Change `sprite.color` for a hit flash or a
glow, and use `"blend": "additive"` on glows, lasers and magic so overlaps
brighten. See [`Sprite`](../reference/parallax.md#sprite).

### Shapes and text

`shape` draws `rect` (with `corner_radius`), `circle` (`size` is the diameter),
`ring` (`thickness`) and `polygon` (`points`). Any of them takes `stroke_width`
and `stroke_color`, and `rect`, `circle` and `ring` take a `texture` image. The
3D kinds (`box`, `sphere` and others) are an error in 2D.

`text_mesh` writes text in the world, at the entity's `z`, with `[color=#hex]`
and `[b]` markup. `number_merge` puts one on a rounded rect for its tiles, and
its `tile_face` behavior sets the color and number:

```json
{
  "z": 3,
  "components": {
    "shape": { "kind": "rect", "size": [0.956, 0.956], "corner_radius": 0.096 },
    "text_mesh": { "size": 0.494 }
  },
  "behaviors": { "tile_face": {} }
}
```

`ctx.ui.float_text` pops a number at a world point (`maze_chase` scores this way).

### Tilemaps and grids

A `tilemap` draws a level from rows of characters, and with `"collide": true`
the `physics2d()` plugin gives its solid cells colliders. Edit `rows` at run
time to dig or build.

```json
"tilemap": {
  "tile_size": [1, 1], "collide": true,
  "tiles": { "G": { "image": "images/grass" }, "d": { "image": "images/dirt" },
             "~": { "color": "#3a7bd5", "solid": false } },
  "rows": ["......GG", "GGGGG.dd", "dddddddd"]
}
```

Rows go top first, and the entity's position is the map's bottom-left corner.
`" "` and `"."` are empty. For boards and step-by-step movement, use the `grid()`
plugin: `Grid.center(cell)`, `Grid.cell_at(point)` and a `grid_mover` that walks
cell to cell ([ref](../reference/parallax.grid.md)).

### Background and parallax layers

Set the camera's `background` color in every 2D game. Then fill the screen
with a large sprite at a low `z`. `chess` uses one backdrop image:

```json
{ "z": -3, "components": { "sprite": { "image": "images/backdrop", "size": [42.8, 24.0] } } }
```

The engine has no parallax-layer component. A side-scroller makes depth with a
few sprite bands at different `z` that scroll at different speeds.
`auto_runner` gives each band a small component of its own (`scrolls`, with a
`factor` below 1 for far layers) and a system that moves and wraps them. Copy
that pattern from `examples/auto_runner` (`game/components.py`,
`prefabs/band_*.prefab.json`).

### 2D camera

A 2D camera must be `"mode": "orthographic"`. `size` is half the view height in
meters. Use the `fixed` rig (the default) or `follow`; `orbit` and
`first_person` are 3D only.

```json
{ "components": { "camera": { "mode": "orthographic", "fit": [[-4.8, -8], [4.8, 8]], "background": "#040805" } } }
```

`fit` keeps a rectangle (or `"grid"`) in view at any screen shape. For a level
bigger than the screen, use `"rig": "follow"` with `"follow": "player"`,
`smoothing`, `look_ahead` (x only) and `bounds` (which clamps the view's
center). In code: `ctx.camera.main.shake(0.3, 0.25)` and
`ctx.camera.main.zoom_to(4, seconds=0.5)`. `kick()` is 3D only.

### 2D effects and juice

The built-in `Effect.*` set is 3D only, so a 2D game writes its own effects as
`assets/vfx/<name>.vfx.json`. `tic_tac_toe`'s burst when a mark lands:

```json
{"rate": 80, "duration": 0.45, "max": 28, "lifetime": 0.4, "speed": [1.4, 3.8], "direction": 90, "spread": 360, "drag": 3, "size": 0.14, "size_end": 0, "color": "#fff0b8e6", "color_end": "#99b8e600", "blend": "additive"}
```

2D keys: `burst`, `rate`, `duration`, `lifetime`, `speed`, `direction`,
`spread`, `radius`, `gravity` (a number along y, or `[x, y]`), `drag`, `size`,
`size_end`, `color`, `color_end`, `spin`, `shape` (`circle` or `square`),
`image`, `blend` (`alpha` or `additive`), `haze` (a shockwave ripple), `max` and
`extends`. 3D-only keys are ignored.

```python
ctx.vfx.play(Assets.vfx.fuse_burst, at=pos, color=light, color_end=tile)  # tinted per call
ctx.vfx.beam(start, end, color=red, width=0.05)    # lasers and tracers
ctx.vfx.trail(entity, color=gold, width=0.1)       # 2D trails take only color and width
```

For a continuous effect (pollen, rain, embers) put `"particles": {"effect":
"vfx/pollen_far", "emitting": true}` on a prefab, as `bullet_hell` does.

Juice that works in 2D: `camera.shake`, `ctx.time.hitstop(0.05)`,
`ctx.time.ramp` for slow motion, the `move_to`, `rotate_to` and `scale_to`
tweens on a transform, and changing `sprite.color`. `bullet_hell` sizes its
shake to the moment (`game/systems/feedback.py`): small for a broken shield,
big for a boss.

`SurfaceFx`, `Outline`, `Decal`, `HeatHaze` shimmer, `Effect.*`,
`ctx.vfx.lightning` and sky, fog, clouds and weather don't draw in 2D.

### 2D light and post

With no `light` in the scene, everything is drawn as authored. Add a point or
spot `light` and the rest of the scene drops to the environment's `ambient`,
so torches, lamps and glowing pickups light up a dark level. A 2D spot points
along the entity's +x; a directional light raises the ambient.

```json
{
  "environment": { "ambient": "#1a1c2c", "post": { "bloom": 0.8, "bloom_threshold": 0.7, "vignette": 0.4 } },
  "entities": [
    { "prefab": "torch", "at": [3, 1], "components": { "light": { "kind": "point", "color": "#ffb060", "intensity": 2, "range": 4 } } }
  ]
}
```

2D `post` draws `bloom` and `vignette` only. `bloom_threshold` is a drawn color
from 0 to 1, so set it below 1 for bright things to glow.

## Performance with large scenes

Mark scenery that never moves with `"static_mesh": {}` so its meshes merge into
a few draws. A `lod` component swaps in coarser models with distance and draws a
baked impostor beyond `impostor` meters. Foliage, terrain, structures and cities
manage their own levels of detail.

## Capability catalog

Before writing a system by hand, check whether the engine already provides it.
Each plugin is added to `Game(plugins=[...])` from `parallax.plugins`; see the
[plugin reference](../reference/parallax.plugins.md).

Example games are under `examples/`; copy from the one listed.

### World and visuals

| Capability | What it provides | Reach for it when | API | Example |
|---|---|---|---|---|
| Terrain | Heightfield ground with material layers, roads, grading, holes and runtime craters | Any outdoor level | `terrain()`, scene `"terrain"`, `ctx.terrain` ([ref](../reference/parallax.terrain.md)) | `open_world_rpg`, `racing`, `tank_battle` |
| Foliage | Procedural trees, bushes, plants, rocks and grass, scattered by rules | Forests, meadows, any nature | `foliage()`, scene `"foliage"`, `ctx.foliage` ([ref](../reference/parallax.foliage.md)) | `racing`, `open_world_rpg`, `moba` |
| Weather | Rain, snow, hail, fog, storms and lightning, blended by a director | Outdoor mood and weather gameplay | `weather()`, `"weather"`, `ctx.weather` ([ref](../reference/parallax.weather.md)) | `pirate_sailing`, `voxel_survival`, `open_world_rpg` |
| Wind | One wind field for foliage, cloth, sails and projectiles | Sailing, outdoor scenes | `wind()`, scene `"wind"`, `ctx.wind` ([ref](../reference/parallax.wind.md)) | `pirate_sailing`, `racing` |
| Water | Oceans, lakes, pools and rivers, buoyancy, currents and swimming | Coasts, boats, pools | `water()`, `WaterBody`, `Buoyancy`, `ctx.water` ([ref](../reference/parallax.water.md)) | `pirate_sailing`, `cargo_plane` |
| Environment | Sky presets, physical atmosphere, sun, fog, clouds, skybox, day cycle and post-processing | Every 3D scene | Scene `"environment"`, `ctx.environment` (core) | `cargo_plane`, `racing` |
| Procgen | Structures from floor plans, splines and sweeps, race tracks, dungeons and prop kits | Buildings, roads, circuits, coasters, dungeons | `procgen()`, `Structure`, `Spline`, `Sweep`, `Track`, `Dungeon` ([ref](../reference/parallax.procgen.md)) | `fps_shooter`, `open_world_rpg`, `racing`, `coop_cooking` |
| City | Streets, districts, buildings, parks, landmarks, traffic and pedestrians from one block | Urban open worlds, driving games | `city()`, scene `"city"`, `ctx.city` ([ref](../reference/parallax.city.md)) | `open_world_sandbox` |
| Voxels | Block worlds and smooth dig-anywhere terrain, saved as edits | Minecraft-style building and mining | `voxels()`, `content/block/*.json`, `ctx.voxels` ([ref](../reference/parallax.voxels.md)) | `voxel_survival` |
| Soft bodies | Cloth (flags, capes, sails) and jelly bodies | Anything that should flutter or wobble | `softbody()`, `Cloth`, `SoftBody` ([ref](../reference/parallax.softbody.md)) | `pirate_sailing`, `racing` |
| Destruction | Breakables that take impact damage and break into piece prefabs | Crates, walls, glass | `destruction()`, `Breakable`, `ctx.destruction.blast` ([ref](../reference/parallax.destruction.md)) | none yet |
| Render components | Lights, particles, decals, outlines, surface effects, heat haze, mirrors, render textures, LOD, static meshes, 3D text | Feedback and polish | Core components ([ref](../reference/parallax.md)) | `horde_survival`, `racing` |

### Movement, bodies and animation

| Capability | What it provides | Reach for it when | API | Example |
|---|---|---|---|---|
| Physics | Rapier rigid bodies, colliders, joints, force fields, ragdolls, raycasts and materials | Anything that collides or falls | `physics3d()` / `physics2d()`, `Rigidbody`, `Collider`, `ctx.physics` ([ref](../reference/parallax.physics.md)) | `basketball`, `darts` |
| Characters | A walking controller with slopes, steps, jumps, coyote time, stances, vaulting, climbing, swimming, parachuting, carrying, seats and automatic locomotion animation | Every player or NPC that walks | `characters()`, `Character`, `Seat` ([ref](../reference/parallax.characters.md)) | `platformer`, `open_world_rpg`, `fps_shooter` |
| Vehicles | Arcade or simulated cars, tanks, boats and planes, with drivetrain, damage, effects and rig posing | Driving, flying, sailing | `vehicles()`, `Vehicle`, `Drivetrain`, `VehicleEffects` ([ref](../reference/parallax.vehicles.md)) | `racing`, `tank_battle`, `cargo_plane`, `pirate_sailing` |
| Viewmodel | First-person arms and held items with bob, sway, recoil, aiming and reload poses | Shooters, first-person tools | `viewmodel()`, `Viewmodel`, `ViewmodelItem` ([ref](../reference/parallax.viewmodel.md)) | `fps_shooter`, `voxel_survival` |
| Animation | Clips, blend graphs, layers and masks, IK, look-at, root motion and morph targets | Any rigged model | Core `Animator`, library clip pieces | `platformer`, `open_world_rpg` |
| Cinematics | Data-authored cutscenes with camera, transform, visibility, property and event tracks | Intros, boss reveals, endings | `cinematics()`, `content/cinematic/*.json` ([ref](../reference/parallax.cinematics.md)) | `racing`, `twin_stick_roguelite` |

### Gameplay systems

| Capability | What it provides | Reach for it when | API | Example |
|---|---|---|---|---|
| Combat | Health, an armor and shield damage pipeline, sides, status effects, melee strikes, hurtboxes, lock-on and pooled projectiles | Anything that takes damage | `combat()`, `Health`, `Damaged`, `Died`, `ctx.combat.fire` ([ref](../reference/parallax.combat.md)) | `fps_shooter`, `horde_survival`, `tank_battle` |
| AI | Behavior trees, perception, squads, cover, RTS orders, flocks, a combat director and fog of war | Enemies, companions, RTS units, herds | `ai()`, `Brain`, `Perception`, `Flock` ([ref](../reference/parallax.ai.md)) | none yet |
| Navigation | Pathfinding over multi-level walkable surfaces, links, dynamic obstacles and avoidance | NPCs that walk to places | `nav()`, `NavAgent`, `ctx.nav` ([ref](../reference/parallax.nav.md)) | `open_world_rpg`, `twin_stick_roguelite`, `open_world_sandbox` |
| Spawning | Wave spawners with counts, budgets and `max_alive` caps | Horde, tower defense, arena waves | `spawning()`, `Spawner`, `WaveCleared` ([ref](../reference/parallax.spawning.md)) | none yet |
| Economy | Wallets and pools, inventories and hotbars, equipment, shops, loot tables, upgrade drafts and pickups | Currency, items, shops, roguelite upgrades | `economy()`, `Wallet`, `Inventory`, `Pickup` ([ref](../reference/parallax.economy.md)) | none yet |
| Interaction | "[E] Open" focus and prompts, hold-to-use and doors | Chests, doors, NPC talk, levers | `interaction(action=...)`, `Interactable`, `Door` ([ref](../reference/parallax.interaction.md)) | `fps_shooter` |
| Story | Facts, quests with step verbs, and Yarn dialogue with a built-in panel | RPG quests and dialogue | `story()`, `story/*.yarn`, `content/quest/*.json` ([ref](../reference/parallax.story.md)) | `open_world_rpg`, `open_world_sandbox` |
| Grid | Boards and tile maps with cell lookup and movers | Board, puzzle and tactics games | `grid()`, `Grid`, `GridCell` ([ref](../reference/parallax.grid.md)) | `chess`, `match_three` |
| Save | Save slots and checkpoints | Long games | `save()`, `ctx.save` ([ref](../reference/parallax.save.md)) | `open_world_rpg`, `voxel_survival` |

### Interface and players

| Capability | What it provides | Reach for it when | API | Example |
|---|---|---|---|---|
| HUD kit | Minimap, compass, crosshair, nameplates, health bars, markers, pings, stat bars, ability bar, combo, key hints and damage feedback, all from components | Any action game HUD | `hud()`, `Minimap`, `Crosshair`, `StatBars`, `HealthBar` ([ref](../reference/parallax.hud.md)) | `fps_shooter`, `open_world_rpg`, `racing` |
| Panels | HTML/CSS panels bound to Python state, toasts, announcements and floating text | Menus and custom HUD | Core `@ui`, `Panel`, `ctx.ui` ([UI](ui.md)) | Every example |
| In-world screens | Panels on monitors, terminals and arcade cabinets | Diegetic UI | `screens()`, `Screen` ([ref](../reference/parallax.screens.md)) | `basketball` |
| Local multiplayer | Seats, per-seat controls and split screen | Couch co-op and versus | `local_players(...)` ([ref](../reference/parallax.plugins.md#local_players)) | `coop_cooking` |
| Online multiplayer | Server-authoritative netcode with prediction, lobbies and lag compensation | Online play | `net(...)` ([ref](../reference/parallax.net.md)) | `pirate_sailing`, `moba` |
| Voice and chat | Proximity voice and filtered text chat | Online social play | `voice()`, `chat()` ([voice](../reference/parallax.voice.md), [chat](../reference/parallax.chat.md)) | `moba` |
| Payments | Host-run in-game purchases | Monetized releases | `payments()` ([ref](../reference/parallax.payments.md)) | none yet |

### Library gameplay pieces

`pnpm parallax library add <id> <project>` also copies these code pieces:
`time_trial` (run timer with medals), `ghost_racer` (race your best run),
`map_screen` (corner minimap and full map), `radial_menu` (hold-to-open wheel),
`save_slots` (save and load menu), `barks` (NPC one-liners), `model_variety` and
`model_ambient`.

