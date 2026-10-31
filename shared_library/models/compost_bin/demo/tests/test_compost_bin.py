from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("compost_bin: the prefab spawns and its model's controls work")
async def test_compost_bin(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.compost_bin, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch", 0.09)
    assert abs(model.joint("hatch") - 0.09) < 1e-3
    model.set_option("colour", "black")
    assert model.option("colour") == "black"
    assert model.socket_position("socket_lid").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
