from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dollhouse: the prefab spawns and its model's controls work")
async def test_dollhouse(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dollhouse, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("front_wall", 57.5)
    assert abs(model.joint("front_wall") - 57.5) < 1e-3
    model.set_option("siding", "pink")
    assert model.option("siding") == "pink"
    assert model.socket_position("room_kitchen").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
