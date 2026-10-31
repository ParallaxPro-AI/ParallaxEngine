from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sewing_machine: the prefab spawns and its model's controls work")
async def test_sewing_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sewing_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("needle_bar", 0.0125)
    assert abs(model.joint("needle_bar") - 0.0125) < 1e-3
    model.set_option("cloth", "off")
    assert model.option("cloth") == "off"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
