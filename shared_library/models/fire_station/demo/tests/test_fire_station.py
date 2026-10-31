from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fire_station: the prefab spawns and its model's controls work")
async def test_fire_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fire_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hut_door", 0.0)
    assert abs(model.joint("hut_door") - 0.0) < 1e-3
    model.set_option("brickwork", "brown_brick")
    assert model.option("brickwork") == "brown_brick"
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
