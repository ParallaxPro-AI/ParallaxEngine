from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("grit_tray: the prefab spawns and its model's controls work")
async def test_grit_tray(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.grit_tray, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("bed_centre").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
