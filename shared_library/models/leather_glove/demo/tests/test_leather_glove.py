from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("leather_glove: the prefab spawns and its model's controls work")
async def test_leather_glove(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.leather_glove, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("cuff_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
