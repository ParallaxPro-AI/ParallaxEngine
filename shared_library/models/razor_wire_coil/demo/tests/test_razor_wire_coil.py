from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("razor_wire_coil: the prefab spawns and its model's controls work")
async def test_razor_wire_coil(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.razor_wire_coil, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "rusted")
    assert model.option("finish") == "rusted"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
