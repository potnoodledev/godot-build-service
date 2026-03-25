# Build Game

Build the current Godot project into a playable .pck file.

## Usage

```bash
bash .pi/skills/build-game/scripts/build.sh
```

## What it does

- Copies your `main.gd` into the Godot project template
- Runs Godot headless import + export for HTML5
- Produces `index.pck` in `output/`
- Prints build result with any errors

## After building

- If you see `BUILD SUCCESS`, the game is ready
- If you see `BUILD FAILED` or `SCRIPT ERROR`, read the errors carefully and fix `main.gd`
- Common errors:
  - `Cannot infer the type` — add explicit type annotations (e.g., `var x: Vector2 = event.position`)
  - `Parse Error` — syntax error in GDScript, check the line number
- After fixing, run the build again
