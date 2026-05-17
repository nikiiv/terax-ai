//! Language-agnostic LSP process manager. The webview never touches the
//! server process directly — it speaks JSON-RPC strings over `invoke()` +
//! a Tauri `Channel`, and the Rust side owns spawn / framing / shutdown.
//! v1 callers are Elixir (`elixir-ls`) but nothing here is Elixir-specific.

mod discovery;
mod server;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;

use tauri::ipc::Channel;

pub use discovery::ElixirLsLocation;
pub use server::LspEvent;
use server::LspServer;

pub struct LspState {
    servers: RwLock<HashMap<u32, Arc<LspServer>>>,
    // Starts at 1 — the frontend treats 0 as "unset". Monotonic, never reused.
    next_id: AtomicU32,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            servers: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[tauri::command]
pub fn lsp_start(
    state: tauri::State<LspState>,
    command: String,
    args: Vec<String>,
    root_uri: String,
    on_event: Channel<LspEvent>,
) -> Result<u32, String> {
    let server = server::spawn(command.clone(), args, root_uri, on_event).map_err(|e| {
        log::error!("lsp_start failed: {e}");
        e
    })?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.servers.write().unwrap().insert(id, server);
    log::info!("lsp server started id={id} command={command}");
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(state: tauri::State<LspState>, id: u32, message: String) -> Result<(), String> {
    let server = state
        .servers
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("lsp_send: unknown id={id}");
            "no language server".to_string()
        })?;
    server.send(&message)
}

#[tauri::command]
pub fn lsp_stop(state: tauri::State<LspState>, id: u32) -> Result<(), String> {
    let server = state.servers.write().unwrap().remove(&id);
    if let Some(s) = server {
        s.kill();
        log::info!("lsp server stopped id={id}");
        // Drop the Arc off-thread: the Drop impl joins on process death and on
        // Windows closing the Job HANDLE can block — same rationale as
        // pty_close. Don't stall the Tauri worker handling this command.
        thread::Builder::new()
            .name(format!("terax-lsp-drop-{id}"))
            .spawn(move || drop(s))
            .expect("spawn lsp drop thread");
    } else {
        log::debug!("lsp_stop: unknown id={id}");
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_resolve_elixir_ls(
    configured_path: Option<String>,
) -> Result<Option<ElixirLsLocation>, String> {
    discovery::resolve_elixir_ls(configured_path)
}

#[tauri::command]
pub async fn lsp_find_project_root(
    path: String,
    markers: Vec<String>,
) -> Result<Option<String>, String> {
    Ok(discovery::find_project_root(&path, &markers))
}
