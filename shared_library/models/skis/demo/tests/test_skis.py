from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("skis: the prefab spawns and its model's controls work")
async def test_skis(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.skis, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ski_l_lever", 21.0)
    assert abs(model.joint("ski_l_lever") - 21.0) < 1e-3
    model.set_option("skis", "black")
    assert model.option("skis") == "black"
    assert model.socket_position("boot_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
