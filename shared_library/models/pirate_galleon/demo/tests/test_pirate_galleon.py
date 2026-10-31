from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pirate_galleon: the prefab spawns and its model's controls work")
async def test_pirate_galleon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pirate_galleon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("rudder", 0.0)
    assert abs(model.joint("rudder") - 0.0) < 1e-3
    model.set_option("hull_paint", "blue")
    assert model.option("hull_paint") == "blue"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
