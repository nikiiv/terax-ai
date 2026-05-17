//! A single language-server child process: spawn, LSP Content-Length framing
//! over stdio, and a reader thread that streams complete JSON-RPC messages to
//! the webview over a Tauri `Channel`. Mirrors the process-management
//! discipline in `shell::background` and `pty::session` (dedicated reader /
//! stderr-drain threads, `Drop` kills the child as an HMR/crash backstop).

use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use shared_child::SharedChild;
use tauri::ipc::Channel;

/// Server → client. JSON-RPC strings only (no LSP headers) — this is exactly
/// the shape `@codemirror/lsp-client`'s `Transport` consumes.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LspEvent {
    Message { data: String },
    Exited { code: i32 },
}

pub struct LspServer {
    child: Arc<SharedChild>,
    stdin: Mutex<ChildStdin>,
    // On Windows the launcher (`language_server.bat`) spawns a BEAM VM + epmd
    // subtree that `TerminateProcess` won't reap — the exact orphan problem
    // documented in TERAX.md. The Job Object kills the whole tree when its
    // HANDLE drops. Reused from `pty::job`.
    #[cfg(windows)]
    _job: Option<crate::modules::pty::job::PtyJob>,
    exited: AtomicBool,
}

impl LspServer {
    /// Frame and write one JSON-RPC message to the server's stdin.
    pub fn send(&self, message: &str) -> Result<(), String> {
        if self.exited.load(Ordering::Acquire) {
            return Err("language server has exited".into());
        }
        let mut stdin = self.stdin.lock().map_err(|_| "stdin poisoned".to_string())?;
        // `message.len()` is the UTF-8 byte length, which is what LSP's
        // Content-Length must count.
        let header = format!("Content-Length: {}\r\n\r\n", message.len());
        stdin
            .write_all(header.as_bytes())
            .and_then(|_| stdin.write_all(message.as_bytes()))
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self) {
        let _ = self.child.kill();
    }
}

impl Drop for LspServer {
    fn drop(&mut self) {
        // Backstop: if the Arc is dropped without an explicit lsp_stop
        // (frontend disconnect, window crash, dev HMR) the child must die so
        // the reader thread hits EOF and unwinds.
        self.kill();
    }
}

fn build_command(command: &str, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        let lower = command.to_ascii_lowercase();
        if lower.ends_with(".bat") || lower.ends_with(".cmd") {
            // Rust's Command does not run batch files directly.
            let mut c = Command::new("cmd");
            c.arg("/C").arg(command).args(args);
            return c;
        }
    }
    let mut c = Command::new(command);
    c.args(args);
    c
}

/// Spawn the server with `cwd` as its working directory — a *filesystem*
/// path, NOT a `file://` URI (ElixirLS finds `mix.exs` via cwd; the LSP
/// `rootUri` is a separate concern handled by the client's initialize).
/// `on_event` receives every complete server→client message, then a single
/// `Exited` when the process ends.
pub fn spawn(
    command: String,
    args: Vec<String>,
    cwd: String,
    on_event: Channel<LspEvent>,
) -> Result<Arc<LspServer>, String> {
    if command.trim().is_empty() {
        return Err("empty language server command".into());
    }

    let mut cmd = build_command(&command, &args);
    if !cwd.is_empty() {
        // A bad cwd makes Command::spawn fail with a confusing ENOENT that
        // blames the program — validate up front for a clear error.
        if !std::path::Path::new(&cwd).is_dir() {
            return Err(format!("workspace cwd is not a directory: {cwd}"));
        }
        cmd.current_dir(&cwd);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let shared = SharedChild::spawn(&mut cmd)
        .map_err(|e| format!("failed to spawn language server '{command}': {e}"))?;
    let stdin = shared.take_stdin().ok_or("no stdin pipe")?;
    let stdout = shared.take_stdout().ok_or("no stdout pipe")?;
    let stderr = shared.take_stderr().ok_or("no stderr pipe")?;
    let child = Arc::new(shared);

    #[cfg(windows)]
    let job = match crate::modules::pty::job::PtyJob::create_for(child.id()) {
        Ok(j) => Some(j),
        Err(e) => {
            log::warn!("lsp job-object setup failed for pid={}: {e}", child.id());
            None
        }
    };

    let server = Arc::new(LspServer {
        child: child.clone(),
        stdin: Mutex::new(stdin),
        #[cfg(windows)]
        _job: job,
        exited: AtomicBool::new(false),
    });

    // stderr drain — ElixirLS logs build progress/errors here; an undrained
    // pipe will eventually deadlock the child (same rule as shell::drain).
    {
        let mut pipe = stderr;
        thread::Builder::new()
            .name("terax-lsp-stderr".into())
            .spawn(move || {
                let mut reader = BufReader::new(&mut pipe);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => log::debug!("[elixir-ls] {}", line.trim_end()),
                    }
                }
            })
            .expect("spawn lsp stderr thread");
    }

    // stdout reader — parse LSP frames, emit each complete JSON message, then
    // wait for the exit code and emit a final Exited.
    {
        let server_ref = server.clone();
        let child_for_wait = child.clone();
        thread::Builder::new()
            .name("terax-lsp-reader".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                // Exits on EOF or malformed framing (read_message != Ok(Some)).
                while let Ok(Some(msg)) = read_message(&mut reader) {
                    if on_event.send(LspEvent::Message { data: msg }).is_err() {
                        break;
                    }
                }
                server_ref.exited.store(true, Ordering::Release);
                let code = match child_for_wait.wait() {
                    Ok(status) => status.code().unwrap_or(-1),
                    Err(_) => -1,
                };
                let _ = on_event.send(LspEvent::Exited { code });
            })
            .expect("spawn lsp reader thread");
    }

    Ok(server)
}

/// Read one LSP message: headers terminated by a blank line, then exactly
/// `Content-Length` bytes of body. `Ok(None)` on clean EOF.
fn read_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None); // EOF
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break; // end of headers
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let len = match content_length {
        Some(l) => l,
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "LSP message missing Content-Length",
            ))
        }
    };
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}
