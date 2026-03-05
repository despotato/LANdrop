use serde::Serialize;
use std::{
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::{Mutex, OnceLock},
  time::Duration,
};

#[derive(Debug, Serialize)]
pub struct SavedFile {
  pub path: String,
}

#[derive(Debug, Serialize)]
pub struct DiscoveredServer {
  pub ws_url: String,
  pub http_url: String,
  pub auth_required: bool,
}

fn sanitize_filename(name: &str) -> String {
  let mut out = String::with_capacity(name.len());
  for ch in name.chars() {
    match ch {
      '/' | '\\' | '\0' | ':' => out.push('_'),
      _ => out.push(ch),
    }
  }
  if out.trim().is_empty() {
    "download".to_string()
  } else {
    out
  }
}

fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
  let base = dir.join(file_name);
  if !base.exists() {
    return base;
  }

  let (stem, ext) = match file_name.rsplit_once('.') {
    Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), Some(e.to_string())),
    _ => (file_name.to_string(), None),
  };

  for i in 1..1000 {
    let candidate = match &ext {
      Some(e) => dir.join(format!("{stem} ({i}).{e}")),
      None => dir.join(format!("{stem} ({i})")),
    };
    if !candidate.exists() {
      return candidate;
    }
  }

  dir.join(format!("{}-{}", stem, millis()))
}

fn millis() -> u128 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0)
}

#[tauri::command]
pub fn save_to_downloads(name: String, bytes: Vec<u8>) -> Result<SavedFile, String> {
  let downloads = dirs::download_dir().ok_or_else(|| "Could not find a downloads directory".to_string())?;
  let safe = sanitize_filename(&name);
  let path = unique_path(&downloads, &safe);
  std::fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {e}"))?;
  Ok(SavedFile {
    path: path.display().to_string(),
  })
}

#[tauri::command]
pub fn discover_signaling(timeout_ms: u64, discovery_port: u16) -> Result<Vec<DiscoveredServer>, String> {
  use std::net::{SocketAddrV4, UdpSocket};
  use std::time::{Duration, Instant};

  let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("bind failed: {e}"))?;
  sock
    .set_broadcast(true)
    .map_err(|e| format!("set_broadcast failed: {e}"))?;
  sock
    .set_read_timeout(Some(Duration::from_millis(100)))
    .map_err(|e| format!("set_read_timeout failed: {e}"))?;

  let broadcast = SocketAddrV4::new(std::net::Ipv4Addr::BROADCAST, discovery_port);
  sock
    .send_to(b"LANDROP_DISCOVER_V1", broadcast)
    .map_err(|e| format!("send failed: {e}"))?;

  let start = Instant::now();
  let mut buf = [0u8; 2048];
  let mut out: Vec<DiscoveredServer> = Vec::new();

  while start.elapsed() < Duration::from_millis(timeout_ms) {
    match sock.recv_from(&mut buf) {
      Ok((n, from)) => {
        let text = String::from_utf8_lossy(&buf[..n]);
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
          if v.get("type").and_then(|t| t.as_str()) != Some("LANDROP_DISCOVERY_V1") {
            continue;
          }
          let ws_port = v.get("wsPort").and_then(|p| p.as_u64()).unwrap_or(8787) as u16;
          let ws_path = v.get("wsPath").and_then(|p| p.as_str()).unwrap_or("/");
          let http_port = v.get("httpPort").and_then(|p| p.as_u64()).unwrap_or(ws_port as u64) as u16;
          let http_path = v.get("httpPath").and_then(|p| p.as_str()).unwrap_or("/");
          let auth_required = v.get("authRequired").and_then(|a| a.as_bool()).unwrap_or(false);

          let ip = match from {
            std::net::SocketAddr::V4(a) => a.ip().to_string(),
            std::net::SocketAddr::V6(a) => a.ip().to_string(),
          };

          let ws_url = format!("ws://{}:{}{}", ip, ws_port, ws_path);
          let http_url = format!("http://{}:{}{}", ip, http_port, http_path);

          if !out.iter().any(|x| x.ws_url == ws_url) {
            out.push(DiscoveredServer {
              ws_url,
              http_url,
              auth_required,
            });
          }
        }
      }
      Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
        continue;
      }
      Err(e) => return Err(format!("recv failed: {e}")),
    }
  }

  Ok(out)
}

#[derive(Debug, Serialize)]
pub struct EnsureResult {
  pub ws_url: String,
  pub http_url: String,
  pub started: bool,
  pub auth_required: bool,
}

static SERVER_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn start_external_server_if_needed() -> Result<bool, String> {
  let lock = SERVER_CHILD.get_or_init(|| Mutex::new(None));
  let mut child = lock.lock().map_err(|_| "lock poisoned".to_string())?;
  if child.is_some() {
    return Ok(false);
  }

  // Dev-only: run the Node server from the repo. Packaged apps should ship a native server or use a hosted one.
  let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
  let repo_root = manifest_dir
    .parent()
    .and_then(|p| p.parent())
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let mut cmd = Command::new("npm");
  cmd.current_dir(repo_root)
    .arg("run")
    .arg("dev")
    .arg("-w")
    .arg("@landrop/server")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  let spawned = cmd.spawn().map_err(|e| format!("Failed to spawn server: {e}"))?;
  *child = Some(spawned);
  Ok(true)
}

#[tauri::command]
pub async fn ensure_signaling(
  timeout_ms: u64,
  discovery_port: u16,
  port: u16,
) -> Result<EnsureResult, String> {
  // 1) Try discovery first (fast path)
  if let Ok(found) = discover_signaling(timeout_ms, discovery_port) {
    if let Some(first) = found.first() {
      return Ok(EnsureResult {
        ws_url: first.ws_url.clone(),
        http_url: first.http_url.clone(),
        started: false,
        auth_required: first.auth_required,
      });
    }
  }

  // 2) Start server locally (dev-only) if nothing is found.
  let started = start_external_server_if_needed().unwrap_or(false);
  std::thread::sleep(Duration::from_millis(350));

  // 3) Try discovery again (prefer LAN IP, not localhost)
  if let Ok(found) = discover_signaling(timeout_ms, discovery_port) {
    if let Some(first) = found.first() {
      return Ok(EnsureResult {
        ws_url: first.ws_url.clone(),
        http_url: first.http_url.clone(),
        started,
        auth_required: first.auth_required,
      });
    }
  }

  Ok(EnsureResult {
    ws_url: format!("ws://127.0.0.1:{port}"),
    http_url: format!("http://127.0.0.1:{port}"),
    started,
    auth_required: true,
  })
}
