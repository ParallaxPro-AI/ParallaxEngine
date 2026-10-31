from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("newspaper_kiosk_round: the prefab spawns and its model's controls work")
async def test_newspaper_kiosk_round(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.newspaper_kiosk_round, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shutter_l", 62.5)
    assert abs(model.joint("shutter_l") - 62.5) < 1e-3
    model.set_option("paint", "midnight")
    assert model.option("paint") == "midnight"
    assert model.socket_position("socket_counter").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
