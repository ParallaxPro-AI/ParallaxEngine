from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("kids_cubby_shelf: the prefab spawns and its model's controls work")
async def test_kids_cubby_shelf(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.kids_cubby_shelf, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tray_0_0", 0.13)
    assert abs(model.joint("tray_0_0") - 0.13) < 1e-3
    model.set_option("finish", "birch")
    assert model.option("finish") == "birch"
    assert model.socket_position("top_surface").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
