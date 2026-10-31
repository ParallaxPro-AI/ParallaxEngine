from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("clothes_dryer: the prefab spawns and its model's controls work")
async def test_clothes_dryer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.clothes_dryer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 57.5)
    assert abs(model.joint("door") - 57.5) < 1e-3
    model.set_option("finish", "graphite")
    assert model.option("finish") == "graphite"
    assert model.socket_position("socket_drum").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
