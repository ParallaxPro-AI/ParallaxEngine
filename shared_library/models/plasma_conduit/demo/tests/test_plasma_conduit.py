from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("plasma_conduit: the prefab spawns and its model's controls work")
async def test_plasma_conduit(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.plasma_conduit, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("plasma", "green")
    assert model.option("plasma") == "green"
    assert model.socket_position("end_neg").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
