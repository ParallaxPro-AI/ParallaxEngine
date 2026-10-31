from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("carved_tablet: the prefab spawns and its model's controls work")
async def test_carved_tablet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.carved_tablet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("inscription", "carved")
    assert model.option("inscription") == "carved"
    assert model.socket_position("socket_offering").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
