from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mahjong_table: the prefab spawns and its model's controls work")
async def test_mahjong_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mahjong_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_s", 0.07)
    assert abs(model.joint("drawer_s") - 0.07) < 1e-3
    model.set_option("felt", "blue")
    assert model.option("felt") == "blue"
    assert model.socket_position("chair_s").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
