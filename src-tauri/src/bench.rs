// SPDX-License-Identifier: GPL-3.0-or-later
//! Runs aria-burn-core's WebGL2 bench in the real app webview (WKWebView on
//! macOS, WebView2 on Windows) instead of a browser. With
//! `ARIA_BURN_BENCH_URL=http://localhost:<port>/` set, the main window opens
//! that page instead of the app. Serve it with `pnpm bench` in aria-burn-core.
//! Only local URLs are accepted, so the switch can't point the app at a remote page.

use tauri::{Manager, Url};

const ENV: &str = "ARIA_BURN_BENCH_URL";

/// The bench page to open, if the env var is set to a local http URL.
pub fn url_from_env() -> Option<Url> {
    let value = std::env::var(ENV).ok()?;
    match parse_local(&value) {
        Some(url) => Some(url),
        None => {
            eprintln!("{ENV}: ignoring {value:?}: expected http://localhost:<port>/ or http://127.0.0.1:<port>/");
            None
        }
    }
}

fn parse_local(value: &str) -> Option<Url> {
    let url = Url::parse(value.trim()).ok()?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    (url.scheme() == "http" && local).then_some(url)
}

/// Points the main window at the bench page.
pub fn open(app: &tauri::App, url: Url) -> tauri::Result<()> {
    let window = app.get_webview_window("main").expect("main window is configured in tauri.conf.json");
    window.set_title(&format!("Aria Burn — bench {url}"))?;
    window.navigate(url)
}

#[cfg(test)]
mod tests {
    use super::parse_local;

    #[test]
    fn accepts_local_http_only() {
        assert!(parse_local("http://localhost:5199/").is_some());
        assert!(parse_local(" http://127.0.0.1:5299/ ").is_some());
        assert!(parse_local("http://[::1]:5199/").is_some());
        assert!(parse_local("https://localhost:5199/").is_none());
        assert!(parse_local("http://example.com/").is_none());
        assert!(parse_local("http://localhost.example.com/").is_none());
        assert!(parse_local("not a url").is_none());
    }
}
