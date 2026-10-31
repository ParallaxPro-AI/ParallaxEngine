from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("foil_wad: the prefab spawns and its model's controls work")
async def test_foil_wad(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.foil_wad, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("crush_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
