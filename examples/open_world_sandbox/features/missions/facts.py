"""Story facts. The contacts' dialogue reads `$contracts_completed` and `$permit_owned`; the courier quest
branches on `cargo_rushed` (written at every pickup)."""

from parallax.story import fact

ContractsCompleted = fact("contracts_completed", 0)
PermitOwned = fact("permit_owned", False)
CargoRushed = fact("cargo_rushed", False)
