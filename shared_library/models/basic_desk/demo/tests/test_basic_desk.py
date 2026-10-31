from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("basic_desk: the prefab spawns and its model's controls work")
async def test_basic_desk(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.basic_desk, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer", 0.15)
    assert abs(model.joint("drawer") - 0.15) < 1e-3
    model.set_option("dressing", "bare")
    assert model.option("dressing") == "bare"
    assert model.socket_position("socket_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
