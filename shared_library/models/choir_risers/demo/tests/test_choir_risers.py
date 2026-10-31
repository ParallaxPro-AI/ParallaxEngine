from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("choir_risers: the prefab spawns and its model's controls work")
async def test_choir_risers(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.choir_risers, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("back_rail", 44.0)
    assert abs(model.joint("back_rail") - 44.0) < 1e-3
    model.set_option("carpet", "blue")
    assert model.option("carpet") == "blue"
    assert model.socket_position("stand_0_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
