from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bar_stool: the prefab spawns and its model's controls work")
async def test_bar_stool(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bar_stool, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lift", 0.06)
    assert abs(model.joint("lift") - 0.06) < 1e-3
    assert model.socket_position("socket_seat").distance_to(thing.transform.position) < 2.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
