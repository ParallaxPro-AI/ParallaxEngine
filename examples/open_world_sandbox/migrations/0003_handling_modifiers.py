"""Save version 3: crash damage is a stat modifier on `Vehicle`, not a rewrite of its fields.

Version 2 overwrote a damaged car's `Vehicle.grip` and `max_speed` (so its entity diff holds the degraded
numbers) and kept the authored values in `CarCondition.base_grip` / `base_max_speed`. Dropping both lets
the prefab's handling be the base again; `CarDamage` re-derives the modifiers from `damage` on its first
frame. The job's `risky` flag became the `cargo_rushed` fact, but a running job is never saved.
"""

from parallax import SaveData, migration


@migration(from_version=2, to_version=3)
def handling_modifiers(save: SaveData) -> None:
    for entity in save.entities.values():
        condition = entity.get("car_condition")
        if condition is None:
            continue
        condition.pop("base_grip", None)
        condition.pop("base_max_speed", None)
        vehicle = entity.get("vehicle", {})
        vehicle.pop("grip", None)
        vehicle.pop("max_speed", None)
    save.resources.get("job", {}).pop("risky", None)
