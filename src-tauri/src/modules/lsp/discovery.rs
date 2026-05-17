//! Locating the ElixirLS launcher and a Mix project root.
//!
//! There is no standard auto-detect for ElixirLS — editors normally require a
//! configured path. We try, in order: a user-configured path, the PATH, then a
//! handful of well-known install locations (asdf/mise shims, Homebrew, manual
//! unzip dirs). FS walking lives here (Rust) per the two-process rule and is
//! language-agnostic so other servers can reuse it.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ElixirLsLocation {
    pub path: String,
    /// "script" for language_server.sh/.bat, "bin" for an `elixir-ls` shim.
    pub kind: &'static str,
}

#[cfg(windows)]
const LAUNCHER_NAMES: &[&str] = &["language_server.bat", "elixir-ls.bat", "elixir-ls.cmd"];
#[cfg(not(windows))]
const LAUNCHER_NAMES: &[&str] = &["language_server.sh", "elixir-ls"];

fn is_executable_file(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn kind_for(p: &Path) -> &'static str {
    match p.file_name().and_then(|n| n.to_str()) {
        Some(n) if n.starts_with("language_server") => "script",
        _ => "bin",
    }
}

/// Resolve the ElixirLS launcher. Returns `Ok(None)` when nothing is found
/// (the caller surfaces the install prompt); `Err` only on bad input.
pub fn resolve_elixir_ls(
    configured_path: Option<String>,
) -> Result<Option<ElixirLsLocation>, String> {
    // 1. User-configured path wins — validate it exists and is runnable.
    if let Some(cfg) = configured_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(cfg);
        if is_executable_file(&p) {
            return Ok(Some(ElixirLsLocation {
                path: p.to_string_lossy().into_owned(),
                kind: kind_for(&p),
            }));
        }
        return Err(format!("configured Elixir LS path is not an executable file: {cfg}"));
    }

    // 2. PATH scan.
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in LAUNCHER_NAMES {
                let cand = dir.join(name);
                if is_executable_file(&cand) {
                    return Ok(Some(ElixirLsLocation {
                        path: cand.to_string_lossy().into_owned(),
                        kind: kind_for(&cand),
                    }));
                }
            }
        }
    }

    // 3. Well-known locations (HOME via the `dirs` crate per cross-platform rule).
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".asdf/shims/elixir-ls"));
        candidates.push(home.join(".local/share/mise/shims/elixir-ls"));
        candidates.push(home.join(".elixir-ls/release/language_server.sh"));
        candidates.push(home.join(".local/share/elixir-ls/release/language_server.sh"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/elixir-ls"));
    candidates.push(PathBuf::from("/usr/local/bin/elixir-ls"));
    candidates.push(PathBuf::from("/usr/bin/elixir-ls"));

    for cand in candidates {
        if is_executable_file(&cand) {
            return Ok(Some(ElixirLsLocation {
                path: cand.to_string_lossy().into_owned(),
                kind: kind_for(&cand),
            }));
        }
    }

    Ok(None)
}

/// Walk ancestors of `path` looking for the nearest directory containing one
/// of `markers` (e.g. `mix.exs`). Umbrella-root detection is deferred — v1
/// returns the *nearest* match. Returns the directory path, not the marker.
pub fn find_project_root(path: &str, markers: &[String]) -> Option<String> {
    let start = PathBuf::from(path);
    // If a file was passed, begin from its parent directory.
    let mut dir: &Path = if start.is_dir() {
        start.as_path()
    } else {
        start.parent()?
    };
    loop {
        for m in markers {
            if dir.join(m).is_file() {
                return Some(dir.to_string_lossy().into_owned());
            }
        }
        dir = dir.parent()?;
    }
}
