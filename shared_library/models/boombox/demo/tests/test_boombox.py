from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("boombox: the prefab spawns and its model's controls work")
async def test_boombox(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.boombox, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("deck_door", 19.0)
    assert abs(model.joint("deck_door") - 19.0) < 1e-3
    model.set_option("body_finish", "black")
    assert model.option("body_finish") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
