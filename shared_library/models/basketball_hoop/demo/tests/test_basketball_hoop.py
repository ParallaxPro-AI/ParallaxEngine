from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("basketball_hoop: the prefab spawns and its model's controls work")
async def test_basketball_hoop(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.basketball_hoop, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("height", 0.375)
    assert abs(model.joint("height") - 0.375) < 1e-3
    assert model.socket_position("socket_rim_center").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
