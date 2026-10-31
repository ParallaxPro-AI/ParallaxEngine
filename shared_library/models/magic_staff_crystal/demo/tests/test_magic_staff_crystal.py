from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("magic_staff_crystal: the prefab spawns and its model's controls work")
async def test_magic_staff_crystal(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.magic_staff_crystal, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("focus", "frost")
    assert model.option("focus") == "frost"
    assert model.socket_position("socket_head").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
