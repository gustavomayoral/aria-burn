# Test fixtures

- `workshop-diode.lbdev` — a LightBurn device file written by hand for BURN-31's
  importer test, describing a fictional machine. It follows the shape LightBurn
  exports (`DeviceList` of devices with `DisplayName`, `Width`, `Height` and a
  `Settings` object) and deliberately mixes fields the importer maps, fields with
  no simulator equivalent, and unknown ones. It is not copied from LightBurn or
  any other product.
- `picked-machines.json` — the profiles the machine picker builds for two catalog
  machines, written by `machine-pick.test.ts` and read by the Rust planner test
  in `src-tauri/src/job.rs`, so picking a machine is checked from the picker
  through the planner to the sim.
