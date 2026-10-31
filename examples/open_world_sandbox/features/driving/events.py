"""Things that happen to cars."""

from parallax import Entity, event


@event("vehicle_wrecked", target="vehicle")
class VehicleWrecked:
    vehicle: Entity
    driver: Entity | None
