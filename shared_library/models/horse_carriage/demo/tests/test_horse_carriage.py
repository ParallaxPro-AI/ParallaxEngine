from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("horse_carriage: the prefab spawns and its model's controls work")
async def test_horse_carriage(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.horse_carriage, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("brake", 11.0)
    assert abs(model.joint("brake") - 11.0) < 1e-3
    model.set_option("cover", "plain")
    assert model.option("cover") == "plain"
    assert model.socket_position("socket_hitch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
