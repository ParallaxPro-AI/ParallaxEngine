from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("casino_chip_rack: the prefab spawns and its model's controls work")
async def test_casino_chip_rack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.casino_chip_rack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 52.5)
    assert abs(model.joint("lid") - 52.5) < 1e-3
    model.set_option("fill", "low")
    assert model.option("fill") == "low"
    assert model.socket_position("top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
