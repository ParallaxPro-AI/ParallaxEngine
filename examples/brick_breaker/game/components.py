"""Tags. Prism Smash needs no per-entity data of its own: bricks carry the combat
plugin's `Health`, and everything else is a `param` on a behavior."""

from parallax import tag

Paddle = tag("paddle")
Brick = tag("brick")
Rail = tag("rail")
Orb = tag("orb")
