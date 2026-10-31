from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("basic_sofa: the prefab spawns and its model's controls work")
async def test_basic_sofa(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.basic_sofa, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("fabric", "charcoal")
    assert model.option("fabric") == "charcoal"
    assert model.socket_position("seat_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
