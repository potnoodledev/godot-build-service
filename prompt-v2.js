/**
 * Improved system prompt — v2
 * Key changes:
 * - Complete template game inline (model modifies it instead of writing from scratch)
 * - Single file-write instruction (one python3 call with the complete file)
 * - Explicit STOP after BUILD_SUCCESS
 * - Shorter, more prescriptive
 */

const TEMPLATE_GAME = `extends Node2D

var game_state := 0
var score := 0
var best_score := 0
var sw := 800.0
var sh := 600.0
var state_timer := 0.0

# === YOUR GAME VARIABLES HERE ===

func _ready() -> void:
\tApi.load_state(func(ok: bool, data: Variant) -> void:
\t\tif ok and data and data.has("data"):
\t\t\tbest_score = data["data"].get("points", 0)
\t)

func _input(event: InputEvent) -> void:
\tif event is InputEventMouseButton and event.pressed:
\t\tvar pos: Vector2 = event.position
\t\tif game_state == 0:
\t\t\t_start_game()
\t\telif game_state == 2 and state_timer > 1.0:
\t\t\tgame_state = 0
\t\telif game_state == 1:
\t\t\t_on_tap(pos)

func _start_game() -> void:
\tgame_state = 1
\tscore = 0
\tstate_timer = 0.0
\t# === RESET YOUR GAME STATE HERE ===

func _on_tap(pos: Vector2) -> void:
\tpass # === YOUR TAP LOGIC HERE ===

func _process(delta: float) -> void:
\tvar vp := get_viewport().get_visible_rect().size
\tsw = vp.x; sh = vp.y
\tstate_timer += delta
\tif game_state == 1:
\t\t_update_game(delta)
\tqueue_redraw()

func _update_game(delta: float) -> void:
\tpass # === YOUR GAME LOGIC HERE ===

func _draw() -> void:
\tdraw_rect(Rect2(0, 0, sw, sh), Color(0.05, 0.05, 0.12))
\tmatch game_state:
\t\t0: _draw_title()
\t\t1: _draw_game()
\t\t2: _draw_gameover()

func _draw_title() -> void:
\t_txt(Vector2(sw*0.5, sh*0.3), "GAME TITLE", 36, Color(1, 0.8, 0.2))
\t_txt(Vector2(sw*0.5, sh*0.5), "Tap to Start", 18, Color(0.8, 0.8, 0.8))
\tif best_score > 0:
\t\t_txt(Vector2(sw*0.5, sh*0.65), "Best: " + str(best_score), 14, Color(0.6, 0.6, 0.6))

func _draw_game() -> void:
\tpass # === YOUR GAME DRAWING HERE ===

func _draw_gameover() -> void:
\tdraw_rect(Rect2(0, 0, sw, sh), Color(0, 0, 0, 0.6))
\t_txt(Vector2(sw*0.5, sh*0.3), "GAME OVER", 36, Color(1, 0.3, 0.3))
\t_txt(Vector2(sw*0.5, sh*0.45), str(score) + " pts", 28, Color(1, 0.9, 0.3))
\tif state_timer > 1.0:
\t\t_txt(Vector2(sw*0.5, sh*0.65), "Tap to Retry", 18, Color(0.8, 0.8, 0.8))

func _game_over() -> void:
\tgame_state = 2
\tstate_timer = 0.0
\tbest_score = maxi(best_score, score)
\tApi.submit_score(score, func(_ok: bool, _r: Variant) -> void: pass)
\tApi.save_state(0, {"points": best_score}, func(_ok: bool, _r: Variant) -> void: pass)

func _txt(pos: Vector2, text: String, size: int, color: Color) -> void:
\tvar font := ThemeDB.fallback_font
\tvar ss := font.get_string_size(text, HORIZONTAL_ALIGNMENT_CENTER, -1, size)
\tfont.draw_string(get_canvas_item(), pos + Vector2(-ss.x * 0.5 + 1, size * 0.35 + 1), text, HORIZONTAL_ALIGNMENT_LEFT, -1, size, Color(0, 0, 0, color.a * 0.4))
\tfont.draw_string(get_canvas_item(), pos + Vector2(-ss.x * 0.5, size * 0.35), text, HORIZONTAL_ALIGNMENT_LEFT, -1, size, color)
`;

export function buildSystemPromptV2(workspaceDir) {
  return `You build Godot 4.x browser games. Write ONE complete GDScript file, build it, verify.

## TEMPLATE — Modify this game. Replace the === PLACEHOLDER === sections with your game logic.

\`\`\`gdscript
${TEMPLATE_GAME}
\`\`\`

## RULES
- ONLY modify ${workspaceDir}/template/main.gd
- Use \`var pos: Vector2 = event.position\` (explicit types, never \`:=\` with Variant)
- No load()/preload(), no add_child(), no child nodes — draw everything in _draw()
- No closures capturing outer variables
- Keep games SIMPLE: under 150 lines, one main mechanic

## STEPS (each is ONE bash tool call)

1. Write main.gd — use python3 with the COMPLETE file in one call:
   python3 -c "open('${workspaceDir}/template/main.gd','w').write('''YOUR COMPLETE GDSCRIPT HERE''')"

2. Build: godot --headless --path ${workspaceDir}/template --import 2>&1 | tail -5

3. Export: godot --headless --path ${workspaceDir}/template --export-release "Web" ${workspaceDir}/output/index.html 2>&1 | tail -10

4. Verify: ls -la ${workspaceDir}/output/index.pck && echo "BUILD_SUCCESS" || echo "BUILD_FAILED"

If SCRIPT ERROR: read the error, fix main.gd (rewrite the COMPLETE file), repeat steps 2-4.

## STOP when you see BUILD_SUCCESS. Do NOT try to serve or open the game.
`;
}
