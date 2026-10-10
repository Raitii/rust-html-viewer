mod diff;
mod doc;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use std::{env, fs, process, thread};

use serde::Deserialize;
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, Server};

const INDEX_HTML: &str = include_str!("../assets/index.html");
const APP_JS: &str = include_str!("../assets/app.js");
const APP_CSS: &str = include_str!("../assets/app.css");

const USAGE: &str = "\
使い方: rust-html-viewer [<旧.html> <新.html>] [オプション]
  ファイルを省略すると、ブラウザの画面で選べます。

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

/// 比較している旧・新のペア。
struct Pair {
    old: Side,
    new: Side,
}

impl Pair {
    fn side(&self, name: &str) -> Option<&Side> {
        match name {
            "old" => Some(&self.old),
            "new" => Some(&self.new),
            _ => None,
        }
    }
}

struct State {
    pair: Option<Arc<Pair>>,
    stamp: (Stamp, Stamp),
    version: u64,
    stylesheets: HashMap<PathBuf, Stamp>,
}

struct App {
    state: Mutex<State>,
}

impl App {
    fn new(pair: Option<Pair>) -> Self {
        let stamp = pair
            .as_ref()
            .map_or((None, None), |p| (p.old.stamp(), p.new.stamp()));
        App {
            state: Mutex::new(State {
                pair: pair.map(Arc::new),
                stamp,
                version: 0,
                stylesheets: HashMap::new(),
            }),
        }
    }

    fn pair(&self) -> Option<Arc<Pair>> {
        self.state.lock().unwrap().pair.clone()
    }

    /// 比較対象を差し替える、またはどちらかのファイルが更新されるたびに増える番号。
    fn version(&self) -> u64 {
        let mut st = self.state.lock().unwrap();
        if let Some(p) = &st.pair {
            let now = (p.old.stamp(), p.new.stamp());
            if st.stamp != now {
                st.stamp = now;
                st.version += 1;
            }
        }
        let mut css_changed = false;
        for (path, stamp) in &mut st.stylesheets {
            let now = file_stamp(path);
            if *stamp != now {
                *stamp = now;
                css_changed = true;
            }
        }
        if css_changed {
            st.version += 1;
        }
        st.version
    }

    fn watch_stylesheet(&self, path: &Path) {
        let mut st = self.state.lock().unwrap();
        // 初回に読んだ時点を基準にし、更新の検出前に上書きしない。
        st.stylesheets
            .entry(path.to_owned())
            .or_insert_with(|| file_stamp(path));
    }

    fn set_pair(&self, pair: Pair) {
        let mut st = self.state.lock().unwrap();
        st.stamp = (pair.old.stamp(), pair.new.stamp());
        st.pair = Some(Arc::new(pair));
        st.stylesheets.clear();
        st.version += 1;
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
    let pair = match files.len() {
        0 => None,
        2 => match (Side::new(&files[0]), Side::new(&files[1])) {
            (Ok(old), Ok(new)) => Some(Pair { old, new }),
            (Err(e), _) | (_, Err(e)) => fail(&e),
        },
        _ => fail(USAGE),
    };

    let server = match port {
        Some(p) => Server::http(("127.0.0.1", p)),
        None => Server::http("127.0.0.1:7878").or_else(|_| Server::http("127.0.0.1:0")),
    }
    .unwrap_or_else(|e| fail(&format!("サーバーを起動できません: {e}")));
    let addr = server.server_addr().to_ip().expect("TCP address");
    let url = format!("http://{addr}/");

    if let Some(p) = &pair {
        println!("旧: {}", p.old.display_path());
        println!("新: {}", p.new.display_path());
    } else {
        println!("ブラウザの画面で比較するファイルを選びます。");
    }
    println!("\n  {url}\n\nファイルを保存すると自動で更新されます。Ctrl+C で終了。");

    let app = Arc::new(App::new(pair));

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
        process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn()
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
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
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

/// DNS リバインディング対策: Host がローカルのものでなければ API を使わせない。
fn host_is_local(req: &Request) -> bool {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("Host"))
        .is_some_and(|h| {
            let v = h.value.as_str();
            let host = v.rsplit_once(':').map_or(v, |(h, _)| h);
            matches!(host, "127.0.0.1" | "localhost")
        })
}

fn api_request_allowed(headers: &[Header]) -> bool {
    let value = |name: &'static str| {
        headers
            .iter()
            .find(|h| h.field.equiv(name))
            .map(|h| h.value.as_str())
    };
    let Some(host) = value("Host") else {
        return false;
    };
    if let Some(origin) = value("Origin")
        && origin != format!("http://{host}")
    {
        return false;
    }
    if let Some(site) = value("Sec-Fetch-Site")
        && site != "same-origin"
    {
        return false;
    }
    if let Some(dest) = value("Sec-Fetch-Dest")
        && dest != "empty"
    {
        return false;
    }
    true
}

fn file_stamp(path: &Path) -> Stamp {
    let m = fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

fn preview_policy(allow_js: bool) -> &'static str {
    if allow_js {
        "sandbox allow-scripts; object-src 'none'; form-action 'none'"
    } else {
        "sandbox allow-same-origin; script-src 'none'; object-src 'none'; form-action 'none'"
    }
}

fn clean_path(s: &str) -> &str {
    // エクスプローラの「パスのコピー」は前後に " が付く
    s.trim().trim_matches('"').trim()
}

#[derive(Deserialize)]
struct OpenBody {
    old: String,
    new: String,
}

fn handle(app: &App, mut req: Request) {
    let raw = req.url().to_owned();
    let (path, query) = raw.split_once('?').unwrap_or((&raw, ""));
    let param = |k: &str| {
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .find(|(key, _)| *key == k)
            .map(|(_, v)| v.to_owned())
    };

    if path.starts_with("/api/") && (!host_is_local(&req) || !api_request_allowed(req.headers())) {
        return respond_json(req, 403, json!({ "error": "forbidden" }));
    }

    match path {
        "/" => respond(
            req,
            200,
            "text/html; charset=utf-8",
            INDEX_HTML.into(),
            vec![header("Content-Security-Policy", "frame-ancestors 'none'")],
        ),
        "/app.js" => respond(
            req,
            200,
            "text/javascript; charset=utf-8",
            APP_JS.into(),
            vec![],
        ),
        "/app.css" => respond(req, 200, "text/css; charset=utf-8", APP_CSS.into(), vec![]),
        "/api/version" => respond_json(req, 200, json!({ "version": app.version() })),
        "/api/diff" => {
            let version = app.version();
            let Some(pair) = app.pair() else {
                return respond_json(req, 200, json!({ "version": version, "empty": true }));
            };
            let ignore_ws = param("ws").as_deref() == Some("1");
            let meta = |s: &Side| json!({ "name": s.name, "path": s.display_path() });
            match (pair.old.read(), pair.new.read()) {
                (Ok(o), Ok(n)) => {
                    let d = diff::diff_sources(&o, &n, ignore_ws);
                    respond_json(
                        req,
                        200,
                        json!({
                            "version": version,
                            "old": meta(&pair.old),
                            "new": meta(&pair.new),
                            "diff": d,
                        }),
                    );
                }
                (Err(e), _) | (_, Err(e)) => respond_json(req, 500, json!({ "error": e })),
            }
        }
        "/api/open" => {
            if req.method() != &Method::Post {
                return respond_json(req, 405, json!({ "error": "POST only" }));
            }
            if !req.headers().iter().any(|h| {
                h.field.equiv("Content-Type")
                    && h.value
                        .as_str()
                        .split(';')
                        .next()
                        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
            }) {
                return respond_json(req, 415, json!({ "error": "application/json required" }));
            }
            let body: Result<OpenBody, _> = serde_json::from_reader(req.as_reader());
            let result = body.map_err(|e| e.to_string()).and_then(|b| {
                Ok(Pair {
                    old: Side::new(clean_path(&b.old))?,
                    new: Side::new(clean_path(&b.new))?,
                })
            });
            match result {
                Ok(pair) => {
                    app.set_pair(pair);
                    respond_json(req, 200, json!({ "ok": true }));
                }
                Err(e) => respond_json(req, 400, json!({ "error": e })),
            }
        }
        "/api/ls" => {
            let dir = param("dir").map(|d| percent_decode(&d)).unwrap_or_default();
            match list_dir(clean_path(&dir)) {
                Ok(v) => respond_json(req, 200, v),
                Err(e) => respond_json(req, 400, json!({ "error": e })),
            }
        }
        _ => {
            if let Some(rest) = path.strip_prefix("/doc/")
                && let Some((side, rel)) = rest.split_once('/')
                && let Some(pair) = app.pair()
                && let Some(side) = pair.side(side)
            {
                serve_doc(
                    app,
                    side,
                    &percent_decode(rel),
                    param("js").as_deref() == Some("1"),
                    req,
                );
            } else {
                respond(
                    req,
                    404,
                    "text/plain; charset=utf-8",
                    b"not found".to_vec(),
                    vec![],
                );
            }
        }
    }
}

/// フォルダの中身（サブフォルダと HTML ファイル）を返す。ファイル選択画面用。
fn list_dir(dir: &str) -> Result<serde_json::Value, String> {
    let base = if dir.is_empty() {
        env::current_dir().map_err(|e| e.to_string())?
    } else {
        PathBuf::from(dir)
    };
    let base = fs::canonicalize(&base).map_err(|e| format!("{}: {e}", base.display()))?;
    if !base.is_dir() {
        return Err(format!("{}: フォルダではありません", base.display()));
    }
    let mut entries: Vec<(bool, String)> = fs::read_dir(&base)
        .map_err(|e| format!("{}: {e}", base.display()))?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let is_dir = e.path().is_dir();
            let lower = name.to_ascii_lowercase();
            (is_dir || lower.ends_with(".html") || lower.ends_with(".htm"))
                .then_some((is_dir, name))
        })
        .collect();
    // フォルダを先に、あとは名前順
    entries.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });
    let show = |p: &Path| {
        let s = p.display().to_string();
        s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
    };
    Ok(json!({
        "dir": show(&base),
        "parent": base.parent().map(show),
        "entries": entries
            .into_iter()
            .map(|(d, n)| json!({ "name": n, "dir": d }))
            .collect::<Vec<_>>(),
    }))
}

/// 比較対象の HTML 本体（行番号を埋め込む）と、同じフォルダにある CSS・画像などを返す。
fn serve_doc(app: &App, side: &Side, rel: &str, allow_js: bool, req: Request) {
    let not_found = |req: Request| {
        respond(
            req,
            404,
            "text/plain; charset=utf-8",
            b"not found".to_vec(),
            vec![],
        );
    };
    // ページ自身のスクリプトは既定で止める（差分を安定させるため）
    let csp = || vec![header("Content-Security-Policy", preview_policy(allow_js))];

    if rel == side.name {
        match side.read() {
            Ok(src) => respond(
                req,
                200,
                "text/html; charset=utf-8",
                doc::inject_line_attrs(&src).into_bytes(),
                csp(),
            ),
            Err(e) => respond(
                req,
                500,
                "text/plain; charset=utf-8",
                e.into_bytes(),
                vec![],
            ),
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
                if ext == "css" {
                    app.watch_stylesheet(&full);
                }
                let extra = if ext == "svg" { csp() } else { vec![] };
                respond(req, 200, mime(&ext), bytes, extra);
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
            && let Some(v) = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_accepts_viewer_and_command_line_requests() {
        let host = header("Host", "127.0.0.1:7878");
        assert!(api_request_allowed(std::slice::from_ref(&host)));
        assert!(api_request_allowed(&[
            host,
            header("Origin", "http://127.0.0.1:7878"),
            header("Sec-Fetch-Site", "same-origin"),
            header("Sec-Fetch-Dest", "empty"),
        ]));
    }

    #[test]
    fn api_rejects_isolated_preview_and_foreign_origins() {
        for origin in [
            "null",
            "http://localhost:7878",
            "http://127.0.0.1:7879",
            "https://example.com",
        ] {
            assert!(!api_request_allowed(&[
                header("Host", "127.0.0.1:7878"),
                header("Origin", origin),
            ]));
        }
        for (name, value) in [
            ("Sec-Fetch-Site", "cross-site"),
            ("Sec-Fetch-Site", "same-site"),
            ("Sec-Fetch-Dest", "iframe"),
            ("Sec-Fetch-Dest", "script"),
        ] {
            assert!(!api_request_allowed(&[
                header("Host", "127.0.0.1:7878"),
                header(name, value)
            ]));
        }
        assert!(!api_request_allowed(&[]));
    }

    #[test]
    fn preview_never_allows_scripts_and_same_origin_together() {
        assert!(preview_policy(true).contains("sandbox allow-scripts;"));
        assert!(!preview_policy(true).contains("allow-same-origin"));
        assert!(preview_policy(false).contains("sandbox allow-same-origin;"));
        assert!(!preview_policy(false).contains("allow-scripts"));
        assert!(preview_policy(false).contains("script-src 'none'"));
    }

    #[test]
    fn stylesheet_changes_advance_version() {
        let path = env::temp_dir().join(format!("html-viewer-css-test-{}.css", process::id()));
        fs::write(&path, "h1 { color: red }").unwrap();
        let app = App::new(None);
        app.watch_stylesheet(&path);
        assert_eq!(app.version(), 0);
        fs::write(&path, "h1 { color: cornflowerblue }").unwrap();
        app.watch_stylesheet(&path);
        assert_eq!(app.version(), 1);
        assert_eq!(app.version(), 1);
        fs::remove_file(&path).unwrap();
        assert_eq!(app.version(), 2);
    }
}
