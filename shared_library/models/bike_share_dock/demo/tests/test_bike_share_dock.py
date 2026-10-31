from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bike_share_dock: the prefab spawns and its model's controls work")
async def test_bike_share_dock(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bike_share_dock, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("brand", "red")
    assert model.option("brand") == "red"
    assert model.socket_position("dock_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
