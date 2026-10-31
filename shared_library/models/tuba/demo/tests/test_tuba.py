from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tuba: the prefab spawns and its model's controls work")
async def test_tuba(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tuba, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("main_slide", 0.025)
    assert abs(model.joint("main_slide") - 0.025) < 1e-3
    model.set_option("finish", "silver")
    assert model.option("finish") == "silver"
    assert model.socket_position("mouthpiece").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
