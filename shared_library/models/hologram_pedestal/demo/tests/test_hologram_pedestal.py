from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hologram_pedestal: the prefab spawns and its model's controls work")
async def test_hologram_pedestal(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hologram_pedestal, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("subject", "crystal")
    assert model.option("subject") == "crystal"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
