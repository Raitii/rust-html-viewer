mod diff;
mod doc;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use std::{env, fs, process, thread};

use serde_json::json;
use tiny_http::{Header, Request, Response, Server};

const INDEX_HTML: &str = include_str!("../assets/index.html");
const APP_JS: &str = include_str!("../assets/app.js");
const APP_CSS: &str = include_str!("../assets/app.css");

const USAGE: &str = "\
使い方: rust-html-viewer <旧.html> <新.html> [オプション]

オプション:
  -p, --port <N>   待ち受けポート（既定: 7878、使用中なら空きポート）
      --no-open    ブラウザを自動で開かない
  -h, --help       このヘルプを表示";

/// 比較対象の片側（旧 or 新）。
struct Side {
    path: PathBuf,
    dir: PathBuf,
    name: String,
}

impl Side {
    fn new(path: &str) -> Result<Self, String> {
        let path = fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
        if !path.is_file() {
            return Err(format!("{}: ファイルではありません", path.display()));
        }
        let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        Ok(Side { path, dir, name })
    }

    fn read(&self) -> Result<String, String> {
        fs::read(&self.path)
            .map(|b| doc::decode(&b))
            .map_err(|e| format!("{}: {e}", self.path.display()))
    }

    fn stamp(&self) -> Option<(SystemTime, u64)> {
        let m = fs::metadata(&self.path).ok()?;
        Some((m.modified().ok()?, m.len()))
    }

    fn display_path(&self) -> String {
        let s = self.path.display().to_string();
        s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
    }
}

type Stamp = Option<(SystemTime, u64)>;

struct App {
    old: Side,
    new: Side,
    watch: Mutex<((Stamp, Stamp), u64)>,
}

impl App {
    /// どちらかのファイルが更新されるたびに増える番号。
    fn version(&self) -> u64 {
        let now = (self.old.stamp(), self.new.stamp());
        let mut w = self.watch.lock().unwrap();
        if w.0 != now {
            w.0 = now;
            w.1 += 1;
        }
        w.1
    }

    fn side(&self, name: &str) -> Option<&Side> {
        match name {
            "old" => Some(&self.old),
            "new" => Some(&self.new),
            _ => None,
        }
    }
}

fn main() {
    let mut files = Vec::new();
    let mut port: Option<u16> = None;
    let mut open = true;
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            "--no-open" => open = false,
            "-p" | "--port" => {
                port = args.next().and_then(|p| p.parse().ok());
                if port.is_none() {
                    fail("--port には数値を指定してください");
                }
            }
            _ => files.push(a),
        }
    }
    if files.len() != 2 {
        fail(USAGE);
    }
    let (old, new) = match (Side::new(&files[0]), Side::new(&files[1])) {
        (Ok(o), Ok(n)) => (o, n),
        (Err(e), _) | (_, Err(e)) => fail(&e),
    };

    let server = match port {
        Some(p) => Server::http(("127.0.0.1", p)),
        None => Server::http("127.0.0.1:7878").or_else(|_| Server::http("127.0.0.1:0")),
    }
    .unwrap_or_else(|e| fail(&format!("サーバーを起動できません: {e}")));
    let addr = server.server_addr().to_ip().expect("TCP address");
    let url = format!("http://{addr}/");

    println!("旧: {}", old.display_path());
    println!("新: {}", new.display_path());
    println!("\n  {url}\n\nファイルを保存すると自動で更新されます。Ctrl+C で終了。");

    let app = Arc::new(App {
        old,
        new,
        watch: Mutex::new(((None, None), 0)),
    });
    app.version();

    if open {
        open_browser(&url);
    }

    let server = Arc::new(server);
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let (server, app) = (server.clone(), app.clone());
            thread::spawn(move || {
                for req in server.incoming_requests() {
                    handle(&app, req);
                }
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    process::exit(2);
}

fn open_browser(url: &str) {
    let result = if cfg!(windows) {
        process::Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else if cfg!(target_os = "macos") {
        process::Command::new("open").arg(url).spawn()
    } else {
        process::Command::new("xdg-open").arg(url).spawn()
    };
    if result.is_err() {
        eprintln!("ブラウザを開けませんでした。上の URL を開いてください。");
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).unwrap()
}

fn respond(req: Request, status: u16, content_type: &str, body: Vec<u8>, extra: Vec<Header>) {
    let mut res = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"));
    for h in extra {
        res = res.with_header(h);
    }
    let _ = req.respond(res);
}

fn respond_json(req: Request, status: u16, value: serde_json::Value) {
    respond(
        req,
        status,
        "application/json; charset=utf-8",
        value.to_string().into_bytes(),
        vec![],
    );
}

fn handle(app: &App, req: Request) {
    let raw = req.url().to_owned();
    let (path, query) = raw.split_once('?').unwrap_or((&raw, ""));
    let param = |k: &str| {
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.to_owned())
    };

    match path {
        "/" => respond(req, 200, "text/html; charset=utf-8", INDEX_HTML.into(), vec![]),
        "/app.js" => respond(req, 200, "text/javascript; charset=utf-8", APP_JS.into(), vec![]),
        "/app.css" => respond(req, 200, "text/css; charset=utf-8", APP_CSS.into(), vec![]),
        "/api/version" => respond_json(req, 200, json!({ "version": app.version() })),
        "/api/diff" => {
            let version = app.version();
            let ignore_ws = param("ws").as_deref() == Some("1");
            let meta = |s: &Side| json!({ "name": s.name, "path": s.display_path() });
            match (app.old.read(), app.new.read()) {
                (Ok(o), Ok(n)) => {
                    let d = diff::diff_sources(&o, &n, ignore_ws);
                    respond_json(
                        req,
                        200,
                        json!({
                            "version": version,
                            "old": meta(&app.old),
                            "new": meta(&app.new),
                            "diff": d,
                        }),
                    );
                }
                (Err(e), _) | (_, Err(e)) => respond_json(req, 500, json!({ "error": e })),
            }
        }
        _ => {
            if let Some(rest) = path.strip_prefix("/doc/")
                && let Some((side, rel)) = rest.split_once('/')
                && let Some(side) = app.side(side)
            {
                serve_doc(side, &percent_decode(rel), param("js").as_deref() == Some("1"), req);
            } else {
                respond(req, 404, "text/plain; charset=utf-8", b"not found".to_vec(), vec![]);
            }
        }
    }
}

/// 比較対象の HTML 本体（行番号を埋め込む）と、同じフォルダにある CSS・画像などを返す。
fn serve_doc(side: &Side, rel: &str, allow_js: bool, req: Request) {
    let not_found = |req: Request| {
        respond(req, 404, "text/plain; charset=utf-8", b"not found".to_vec(), vec![]);
    };
    // ページ自身のスクリプトは既定で止める（差分を安定させるため）
    let csp = || {
        if allow_js {
            vec![]
        } else {
            vec![header("Content-Security-Policy", "script-src 'none'; object-src 'none'")]
        }
    };

    if rel == side.name {
        match side.read() {
            Ok(src) => respond(
                req,
                200,
                "text/html; charset=utf-8",
                doc::inject_line_attrs(&src).into_bytes(),
                csp(),
            ),
            Err(e) => respond(req, 500, "text/plain; charset=utf-8", e.into_bytes(), vec![]),
        }
        return;
    }

    let Ok(full) = fs::canonicalize(side.dir.join(rel)) else {
        return not_found(req);
    };
    if !full.starts_with(&side.dir) || !full.is_file() {
        return not_found(req);
    }
    match fs::read(&full) {
        Ok(bytes) => {
            let ext = full
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(ext.as_str(), "html" | "htm") {
                // 別の HTML（リンク先など）は行番号なしでそのまま返す
                let body = doc::decode(&bytes).into_bytes();
                respond(req, 200, "text/html; charset=utf-8", body, csp());
            } else {
                respond(req, 200, mime(&ext), bytes, vec![]);
            }
        }
        Err(_) => not_found(req),
    }
}

fn mime(ext: &str) -> &'static str {
    match ext {
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
