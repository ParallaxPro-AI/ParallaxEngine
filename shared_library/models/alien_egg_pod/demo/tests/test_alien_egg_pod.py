from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("alien_egg_pod: the prefab spawns and its model's controls work")
async def test_alien_egg_pod(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.alien_egg_pod, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("petal_0", 31.0)
    assert abs(model.joint("petal_0") - 31.0) < 1e-3
    model.set_option("glow", "violet")
    assert model.option("glow") == "violet"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
