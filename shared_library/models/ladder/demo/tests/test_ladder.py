from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ladder: the prefab spawns and its model's controls work")
async def test_ladder(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ladder, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("extends", 0.75)
    assert abs(model.joint("extends") - 0.75) < 1e-3
    model.set_option("config", "step")
    assert model.option("config") == "step"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
