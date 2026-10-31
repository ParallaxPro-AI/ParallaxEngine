from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scifi_stairs_metal: the prefab spawns and its model's controls work")
async def test_scifi_stairs_metal(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scifi_stairs_metal, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    assert model.socket_position("socket_foot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
