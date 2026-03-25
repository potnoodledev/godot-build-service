extends Node2D

# Game settings
const GAME_DURATION := 90.0  # seconds
const CIRCLE_LIFETIME := 2.0  # seconds
const SPAWN_INTERVAL := 0.5  # seconds
const CIRCLE_RADIUS_MIN := 30.0
const CIRCLE_RADIUS_MAX := 50.0
const POINTS_PER_CIRCLE := 10

# Colors for circles
const CIRCLE_COLORS := [
	Color(1.0, 0.3, 0.3),    # Red
	Color(0.3, 1.0, 0.3),    # Green
	Color(0.3, 0.3, 1.0),    # Blue
	Color(1.0, 1.0, 0.3),    # Yellow
	Color(1.0, 0.3, 1.0),    # Magenta
	Color(0.3, 1.0, 1.0),    # Cyan
]

# Game state
var score: int = 0
var time_remaining: float = GAME_DURATION
var is_playing: bool = false

# Spawning
var spawn_timer: float = 0.0

# Active circles array
var circles: Array[Circle] = []

# UI elements
var score_label: Label
var time_label: Label
var game_over_label: Label
var start_button: Button

# Circle data class
class Circle:
	var position: Vector2
	var radius: float
	var color: Color
	var time_alive: float
	
	func _init(pos: Vector2, rad: float, col: Color):
		position = pos
		radius = rad
		color = col
		time_alive = 0.0

func _ready() -> void:
	create_ui()
	start_menu()

func create_ui() -> void:
	# Create canvas layer for UI
	var canvas = CanvasLayer.new()
	add_child(canvas)
	
	# Score label (top-left)
	score_label = Label.new()
	score_label.position = Vector2(10, 10)
	score_label.add_theme_font_size_override("font_size", 24)
	add_child_to_canvas(canvas, score_label)
	
	# Time label (top-right)
	time_label = Label.new()
	time_label.position = Vector2(650, 10)
	time_label.add_theme_font_size_override("font_size", 24)
	add_child_to_canvas(canvas, time_label)
	
	# Game over label (center)
	game_over_label = Label.new()
	game_over_label.position = Vector2(400, 250)
	game_over_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	game_over_label.add_theme_font_size_override("font_size", 36)
	game_over_label.modulate = Color.TRANSPARENT
	add_child_to_canvas(canvas, game_over_label)
	
	# Start button (center)
	start_button = Button.new()
	start_button.text = "Start Game"
	start_button.position = Vector2(350, 280)
	start_button.size = Vector2(100, 40)
	start_button.pressed.connect(start_game)
	add_child_to_canvas(canvas, start_button)
	
	update_ui()

func add_child_to_canvas(canvas: CanvasLayer, node: Control) -> void:
	node.anchor_left = 0
	node.anchor_right = 0
	node.anchor_top = 0
	node.anchor_bottom = 0
	canvas.add_child(node)

func start_menu() -> void:
	is_playing = false
	score = 0
	time_remaining = GAME_DURATION
	circles.clear()
	game_over_label.modulate = Color.TRANSPARENT
	start_button.visible = true
	update_ui()

func start_game() -> void:
	is_playing = true
	score = 0
	time_remaining = GAME_DURATION
	circles.clear()
	spawn_timer = 0.0
	start_button.visible = false
	game_over_label.modulate = Color.TRANSPARENT
	update_ui()

func game_over() -> void:
	is_playing = false
	circles.clear()
	
	# Show game over screen
	game_over_label.text = "Game Over!\nFinal Score: %d" % score
	game_over_label.modulate = Color.WHITE
	
	# Submit score to leaderboard
	Api.submit_score(score, func(ok: bool, _result: Variant) -> void:
		if ok:
			print("Score submitted successfully!")
	)
	
	# Show start button for restart
	start_button.text = "Play Again"
	start_button.visible = true

func _process(delta: float) -> void:
	if not is_playing:
		return
	
	# Update timer
	time_remaining -= delta
	if time_remaining <= 0.0:
		time_remaining = 0.0
		game_over()
		return
	
	# Update spawn timer
	spawn_timer += delta
	if spawn_timer >= SPAWN_INTERVAL:
		spawn_timer -= SPAWN_INTERVAL
		spawn_circle()
	
	# Update circles
	var circles_to_remove: Array[Circle] = []
	for circle in circles:
		circle.time_alive += delta
		if circle.time_alive >= CIRCLE_LIFETIME:
			circles_to_remove.append(circle)
	
	for circle in circles_to_remove:
		circles.erase(circle)
	
	# Redraw circles
	queue_redraw()
	update_ui()

func spawn_circle() -> void:
	# Get viewport size
	var viewport_size: Vector2
	if get_viewport():
		viewport_size = get_viewport().get_visible_rect().size
	else:
		viewport_size = Vector2(800, 600)
	
	# Random position with padding
	var padding := CIRCLE_RADIUS_MAX + 20
	var x := randf_range(padding, viewport_size.x - padding)
	var y := randf_range(padding + 60, viewport_size.y - padding)  # Extra top padding for UI
	
	var radius := randf_range(CIRCLE_RADIUS_MIN, CIRCLE_RADIUS_MAX)
	var color := CIRCLE_COLORS[randi() % CIRCLE_COLORS.size()]
	
	var circle := Circle.new(Vector2(x, y), radius, color)
	circles.append(circle)

func _input(event: InputEvent) -> void:
	if not is_playing:
		return
	
	if event is InputEventMouseButton and event.pressed:
		var mouse_pos := get_global_mouse_position()
		check_circle_click(mouse_pos)

func check_circle_click(click_pos: Vector2) -> void:
	# Check circles in reverse order (topmost first)
	for i in range(circles.size() - 1, -1, -1):
		var circle = circles[i]
		var dist := click_pos.distance_to(circle.position)
		if dist <= circle.radius:
			# Circle clicked!
			score += POINTS_PER_CIRCLE
			circles.remove_at(i)
			queue_redraw()
			update_ui()
			return

func update_ui() -> void:
	score_label.text = "Score: %d" % score
	time_label.text = "Time: %.1f" % time_remaining
	
	# Center the game over label
	if game_over_label.modulate != Color.TRANSPARENT:
		game_over_label.position = Vector2(400 - game_over_label.size.x / 2, 250)

func _draw() -> void:
	# Draw all circles
	for circle in circles:
		# Draw filled circle
		draw_circle(circle.position, circle.radius, circle.color)
		
		# Draw darker border
		draw_arc(circle.position, circle.radius, 0.0, TAU, 32, circle.color.darkened(0.3), 3.0)
		
		# Draw shine/highlight
		var shine_offset := Vector2(-circle.radius * 0.3, -circle.radius * 0.3)
		draw_circle(circle.position + shine_offset, circle.radius * 0.2, Color(1, 1, 1, 0.5))
