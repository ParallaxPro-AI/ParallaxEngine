from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flame_jet: the prefab spawns and its model's controls work")
async def test_flame_jet(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flame_jet, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("state", "off")
    assert model.option("state") == "off"
    assert model.socket_position("flame_mouth").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
