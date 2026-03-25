"""Godot Cloud Build Service — accepts GDScript, returns .pck"""

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

API_KEY = os.environ.get("API_KEY", "")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "potnoodledev/game-a-day-godot-games")
GHPAGES_BRANCH = "gh-pages"
GODOT_BIN = os.environ.get("GODOT_BIN", "/usr/local/bin/godot")
TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "template")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/build", methods=["POST"])
def build():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "error": "JSON body required"}), 400

    # Auth
    provided_key = data.get("api_key") or ""
    if API_KEY and provided_key != API_KEY:
        return jsonify({"success": False, "error": "Invalid api_key"}), 403

    main_gd = data.get("main_gd")
    if not main_gd:
        return jsonify({"success": False, "error": "main_gd is required"}), 400

    day = data.get("day", 0)
    project_name = data.get("project_name", "GameADay")
    push_to_ghpages = data.get("push_to_ghpages", False)

    start = time.time()
    build_id = str(uuid.uuid4())[:8]
    build_dir = os.path.join(tempfile.gettempdir(), f"build-{build_id}")
    output_dir = os.path.join(build_dir, "output")

    try:
        # 1. Copy template
        shutil.copytree(TEMPLATE_DIR, build_dir)
        os.makedirs(output_dir, exist_ok=True)

        # 2. Write main.gd
        with open(os.path.join(build_dir, "main.gd"), "w") as f:
            f.write(main_gd)

        # 3. Update project name
        proj_path = os.path.join(build_dir, "project.godot")
        with open(proj_path, "r") as f:
            proj = f.read()
        proj = proj.replace('config/name="GameADay"', f'config/name="{project_name}"')
        with open(proj_path, "w") as f:
            f.write(proj)

        # 4. Import
        result = subprocess.run(
            [GODOT_BIN, "--headless", "--path", build_dir, "--import"],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            return jsonify({
                "success": False,
                "error": "Import failed",
                "stdout": result.stdout[-2000:],
                "stderr": result.stderr[-2000:],
            }), 500

        # 5. Export
        export_path = os.path.join(output_dir, "index.html")
        result = subprocess.run(
            [GODOT_BIN, "--headless", "--path", build_dir, "--export-release", "Web", export_path],
            capture_output=True, text=True, timeout=120,
        )

        # Check for .pck
        pck_path = os.path.join(output_dir, "index.pck")
        if not os.path.exists(pck_path):
            return jsonify({
                "success": False,
                "error": "Export produced no .pck",
                "stdout": result.stdout[-2000:],
                "stderr": result.stderr[-2000:],
            }), 500

        # 6. Read and encode .pck
        with open(pck_path, "rb") as f:
            pck_bytes = f.read()
        pck_base64 = base64.b64encode(pck_bytes).decode("ascii")
        pck_size = len(pck_bytes)

        build_time_ms = int((time.time() - start) * 1000)

        response = {
            "success": True,
            "day": day,
            "pck_base64": pck_base64,
            "pck_size": pck_size,
            "build_time_ms": build_time_ms,
        }

        # 7. Push to GitHub Pages
        if push_to_ghpages and day > 0 and GITHUB_TOKEN:
            ghpages_url = push_pck_to_ghpages(day, pck_bytes)
            if ghpages_url:
                response["ghpages_url"] = ghpages_url

        return jsonify(response)

    except subprocess.TimeoutExpired:
        return jsonify({"success": False, "error": "Build timed out"}), 504
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        shutil.rmtree(build_dir, ignore_errors=True)


def push_pck_to_ghpages(day: int, pck_bytes: bytes) -> str | None:
    """Push index.pck to gh-pages branch via GitHub Contents API."""
    day_padded = str(day).zfill(5)
    file_path = f"builds/day-{day_padded}/index.pck"
    api_url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{file_path}"
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # Check if file exists (get SHA for update)
    sha = None
    resp = requests.get(api_url, headers=headers, params={"ref": GHPAGES_BRANCH})
    if resp.status_code == 200:
        sha = resp.json().get("sha")

    # PUT the file
    payload = {
        "message": f"Build day {day}",
        "content": base64.b64encode(pck_bytes).decode("ascii"),
        "branch": GHPAGES_BRANCH,
    }
    if sha:
        payload["sha"] = sha

    resp = requests.put(api_url, headers=headers, json=payload)
    if resp.status_code in (200, 201):
        return f"https://potnoodledev.github.io/game-a-day-godot-games/{file_path}"
    else:
        print(f"[ghpages] Push failed: {resp.status_code} {resp.text[:500]}")
        return None


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=True)
