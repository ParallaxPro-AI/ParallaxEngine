from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flute: the prefab spawns and its model's controls work")
async def test_flute(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flute, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head_joint", 0.006)
    assert abs(model.joint("head_joint") - 0.006) < 1e-3
    model.set_option("plating", "silver")
    assert model.option("plating") == "silver"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
