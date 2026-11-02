# Parser corpus

**Synthetic.** These files are hand-written in the shape of LightBurn and
LaserGRBL GRBL exports (header comments, compact words, G91 rasters, per-pass
`; Cut @` comments). They are not real exports. COD-263 asks for real LightBurn
and LaserGRBL files (raster, vector, mixed, multi-pass); add them here with their
expectations in `../corpus.rs` when they are available.

`square-10mm.gcode` is the source of the contract fixture `job-model.json` in
aria-burn-core, parsed with a 1 mm arc tolerance so the arc is two chords.
