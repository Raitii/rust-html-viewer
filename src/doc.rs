//! HTML ファイルの読み込み（文字コード判定）と、プレビュー用の行番号埋め込み。

use encoding_rs::{Encoding, SHIFT_JIS};
use std::fmt::Write as _;

/// バイト列を文字列にデコードする。
/// BOM → UTF-8 として妥当か → `charset=` 指定 → Shift_JIS の順に判定する。
pub fn decode(bytes: &[u8]) -> String {
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        return enc
            .decode_without_bom_handling(&bytes[bom_len..])
            .0
            .into_owned();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let enc = head
        .find("charset=")
        .and_then(|p| {
            let label: String = head[p + 8..]
                .trim_start_matches(['"', '\''])
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            Encoding::for_label(label.as_bytes())
        })
        .unwrap_or(SHIFT_JIS);
    enc.decode_without_bom_handling(bytes).0.into_owned()
}

/// 中身をタグとして解釈しない要素（終了タグまで読み飛ばす）。
const RAW_TEXT: &[&str] = &[
    "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes",
];

/// すべての開始タグに `data-hv-line="N"`（ソース上の行番号）を埋め込む。
/// ブラウザ側でレンダリング結果の要素とソース行を対応付けるために使う。
pub fn inject_line_attrs(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len() + src.len() / 6);
    let mut line = 1usize;
    let mut copied = 0usize;
    let mut i = 0usize;

    while i < b.len() {
        match b[i] {
            b'\n' => {
                line += 1;
                i += 1;
            }
            b'<' if b[i..].starts_with(b"<!--") => {
                let end = find(b, i + 4, b"-->").map_or(b.len(), |p| p + 3);
                line += count_newlines(&b[i..end]);
                i = end;
            }
            b'<' if b.get(i + 1).is_some_and(u8::is_ascii_alphabetic) => {
                let name_start = i + 1;
                let mut j = name_start;
                while j < b.len() && !matches!(b[j], b' ' | b'\t' | b'\n' | b'\r' | 0x0c | b'/' | b'>')
                {
                    j += 1;
                }
                let name = src[name_start..j].to_ascii_lowercase();
                out.push_str(&src[copied..j]);
                let _ = write!(out, " data-hv-line=\"{line}\"");
                copied = j;

                // 引用符を考慮してタグの終わり `>` まで進む
                let mut quote = 0u8;
                while j < b.len() {
                    let c = b[j];
                    if c == b'\n' {
                        line += 1;
                    }
                    if quote != 0 {
                        if c == quote {
                            quote = 0;
                        }
                    } else if c == b'"' || c == b'\'' {
                        quote = c;
                    } else if c == b'>' {
                        break;
                    }
                    j += 1;
                }
                i = (j + 1).min(b.len());

                if RAW_TEXT.contains(&name.as_str()) {
                    let end = find_close_tag(b, i, name.as_bytes()).unwrap_or(b.len());
                    line += count_newlines(&b[i..end]);
                    i = end;
                }
            }
            _ => i += 1,
        }
    }
    out.push_str(&src[copied..]);
    out
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

fn find_close_tag(hay: &[u8], from: usize, name: &[u8]) -> Option<usize> {
    let mut i = from;
    while let Some(p) = find(hay, i, b"</") {
        let rest = &hay[p + 2..];
        if rest.len() >= name.len() && rest[..name.len()].eq_ignore_ascii_case(name) {
            return Some(p);
        }
        i = p + 2;
    }
    None
}

fn count_newlines(b: &[u8]) -> usize {
    b.iter().filter(|&&c| c == b'\n').count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_line_numbers() {
        let src = "<html>\n<body>\n  <p class=\"a>b\">x</p>\n<!-- <div> -->\n<br/>\n</body>";
        let out = inject_line_attrs(src);
        assert!(out.contains("<html data-hv-line=\"1\">"));
        assert!(out.contains("<body data-hv-line=\"2\">"));
        assert!(out.contains("<p data-hv-line=\"3\" class=\"a>b\">x</p>"));
        assert!(out.contains("<!-- <div> -->"));
        assert!(out.contains("<br data-hv-line=\"5\"/>"));
    }

    #[test]
    fn skips_raw_text_elements() {
        let src = "<script>\nif (a<b) { x = '<div>'; }\n</script>\n<div></div>";
        let out = inject_line_attrs(src);
        assert!(out.contains("x = '<div>'"));
        assert!(out.contains("<div data-hv-line=\"4\">"));
    }

    #[test]
    fn decodes_shift_jis() {
        let (bytes, _, _) = SHIFT_JIS.encode("<meta charset=\"shift_jis\">こんにちは");
        assert_eq!(decode(&bytes), "<meta charset=\"shift_jis\">こんにちは");
    }
}
