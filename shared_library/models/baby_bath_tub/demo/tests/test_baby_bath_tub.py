from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("baby_bath_tub: the prefab spawns and its model's controls work")
async def test_baby_bath_tub(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.baby_bath_tub, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drain", 0.015)
    assert abs(model.joint("drain") - 0.015) < 1e-3
    model.set_option("color", "white")
    assert model.option("color") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
