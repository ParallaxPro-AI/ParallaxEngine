from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cnc_machine: the prefab spawns and its model's controls work")
async def test_cnc_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cnc_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head", 0.11)
    assert abs(model.joint("head") - 0.11) < 1e-3
    model.set_option("accent", "red")
    assert model.option("accent") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
