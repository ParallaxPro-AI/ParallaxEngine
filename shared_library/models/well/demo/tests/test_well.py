from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("well: the prefab spawns and its model's controls work")
async def test_well(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.well, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("crank", 30.0)
    assert abs(model.joint("crank") - 30.0) < 1e-3
    assert model.socket_position("socket_rim").distance_to(thing.transform.position) < 4.34
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
