from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("alchemy_cauldron_large: the prefab spawns and its model's controls work")
async def test_alchemy_cauldron_large(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.alchemy_cauldron_large, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fire_door", 57.5)
    assert abs(model.joint("fire_door") - 57.5) < 1e-3
    model.set_option("brew", "violet")
    assert model.option("brew") == "violet"
    assert model.socket_position("ladle").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
