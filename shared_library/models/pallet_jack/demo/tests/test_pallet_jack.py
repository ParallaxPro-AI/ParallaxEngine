from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pallet_jack: the prefab spawns and its model's controls work")
async def test_pallet_jack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pallet_jack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lift", 0.0575)
    assert abs(model.joint("lift") - 0.0575) < 1e-3
    model.set_option("paint", "orange")
    assert model.option("paint") == "orange"
    assert model.socket_position("pallet").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
