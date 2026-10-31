from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("clawfoot_tub: the prefab spawns and its model's controls work")
async def test_clawfoot_tub(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.clawfoot_tub, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hot", 45.0)
    assert abs(model.joint("hot") - 45.0) < 1e-3
    model.set_option("paint", "white")
    assert model.option("paint") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
