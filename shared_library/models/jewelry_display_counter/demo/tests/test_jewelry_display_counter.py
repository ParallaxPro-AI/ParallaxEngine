from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("jewelry_display_counter: the prefab spawns and its model's controls work")
async def test_jewelry_display_counter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.jewelry_display_counter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("slide_door_l", 0.341)
    assert abs(model.joint("slide_door_l") - 0.341) < 1e-3
    model.set_option("velvet", "burgundy")
    assert model.option("velvet") == "burgundy"
    assert model.socket_position("socket_deck").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
