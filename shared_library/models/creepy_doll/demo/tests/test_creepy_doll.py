from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("creepy_doll: the prefab spawns and its model's controls work")
async def test_creepy_doll(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.creepy_doll, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head", 0.0)
    assert abs(model.joint("head") - 0.0) < 1e-3
    model.set_option("dress_colour", "ash")
    assert model.option("dress_colour") == "ash"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
