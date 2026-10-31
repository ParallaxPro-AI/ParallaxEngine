from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ship_wheel_helm: the prefab spawns and its model's controls work")
async def test_ship_wheel_helm(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ship_wheel_helm, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("wood", "oak")
    assert model.option("wood") == "oak"
    assert model.socket_position("stand_helmsman").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
