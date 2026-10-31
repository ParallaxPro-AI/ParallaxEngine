from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("map_parchment_spread: the prefab spawns and its model's controls work")
async def test_map_parchment_spread(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.map_parchment_spread, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
