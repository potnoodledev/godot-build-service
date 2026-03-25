/**
 * Local BashOperations — runs commands directly on the host.
 * Used when Docker is not available (e.g., Railway deployment).
 * Each session gets its own temp directory for isolation.
 */
import { spawn } from "child_process";
import { mkdirSync, cpSync, rmSync, chmodSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

export class LocalBashOperations {
  workDir = null;
  templateDir = null;

  constructor(templateDir) {
    this.templateDir = templateDir;
  }

  /** Create an isolated workspace. Returns workspace path. */
  createWorkspace() {
    const id = randomUUID().slice(0, 8);
    this.workDir = join("/tmp", `build-${id}`);
    mkdirSync(join(this.workDir, "template"), { recursive: true });
    mkdirSync(join(this.workDir, "output"), { recursive: true });
    if (this.templateDir) {
      cpSync(this.templateDir, join(this.workDir, "template"), { recursive: true });
    }
    // Make template files read-only so agent can't overwrite them
    for (const f of ["project.godot", "main.tscn", "api.gd", "export_presets.cfg"]) {
      try { chmodSync(join(this.workDir, "template", f), 0o444); } catch {}
    }
    return this.workDir;
  }

  /** Clean up workspace. */
  destroyContainer() {
    if (this.workDir) {
      try { rmSync(this.workDir, { recursive: true, force: true }); } catch {}
      this.workDir = null;
    }
  }

  /** BashOperations.exec — run a command locally. */
  exec = (command, cwd, { onData, signal, timeout }) => {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", ["-c", command], {
        cwd: cwd || this.workDir || "/tmp",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle;

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout * 1000);
      }

      if (child.stdout) child.stdout.on("data", onData);
      if (child.stderr) child.stderr.on("data", onData);

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      const onAbort = () => child.kill("SIGKILL");
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (signal?.aborted) { reject(new Error("aborted")); return; }
        if (timedOut) { reject(new Error(`timeout:${timeout}`)); return; }
        resolve({ exitCode: code });
      });
    });
  };
}
