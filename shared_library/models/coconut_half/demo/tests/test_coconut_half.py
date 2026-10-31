from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("coconut_half: the prefab spawns and its model's controls work")
async def test_coconut_half(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.coconut_half, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("rim_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
