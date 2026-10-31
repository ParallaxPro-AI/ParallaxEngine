from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("water_butt: the prefab spawns and its model's controls work")
async def test_water_butt(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.water_butt, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 52.5)
    assert abs(model.joint("lid") - 52.5) < 1e-3
    model.set_option("fill", "half")
    assert model.option("fill") == "half"
    assert model.socket_position("tap").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
