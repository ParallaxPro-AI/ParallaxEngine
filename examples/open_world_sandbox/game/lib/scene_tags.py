"""Scene tags shared by library pieces (library piece `scene_tags`).

A scene opts in with `"tags": ["playable"]` in its scene.json. Pieces scope their panels,
action sets and systems with `scenes=[Playable]`, so a pause key or a run timer simply
doesn't exist on the title screen — nothing checks the current scene by hand."""

from parallax import tag

Playable = tag("playable")
"""Scenes the player plays in: levels, arenas, the open world. Not title or menu scenes."""
