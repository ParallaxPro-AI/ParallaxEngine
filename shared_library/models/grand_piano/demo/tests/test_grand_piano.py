from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("grand_piano: the prefab spawns and its model's controls work")
async def test_grand_piano(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.grand_piano, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("keyboard_lid", 48.0)
    assert abs(model.joint("keyboard_lid") - 48.0) < 1e-3
    model.set_option("finish", "white")
    assert model.option("finish") == "white"
    assert model.socket_position("socket_bench").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
