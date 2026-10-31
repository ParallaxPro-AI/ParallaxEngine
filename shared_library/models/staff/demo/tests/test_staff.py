from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("staff: the prefab spawns and its model's controls work")
async def test_staff(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.staff, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("focus", "life")
    assert model.option("focus") == "life"
    assert model.socket_position("socket_head").distance_to(thing.transform.position) < 2.59
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
