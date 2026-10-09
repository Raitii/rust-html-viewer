//! ソースの行単位差分と、行内の差分（強調表示用）の計算。

use serde::Serialize;
use similar::{Algorithm, DiffOp, capture_diff_slices};

#[derive(Serialize)]
pub struct SourceDiff {
    pub lines: Vec<Line>,
    pub hunks: Vec<Hunk>,
    pub ins: usize,
    pub del: usize,
}

#[derive(Serialize)]
pub struct Line {
    /// 'e' = 変更なし, 'd' = 削除, 'i' = 追加
    pub k: char,
    /// 旧ファイルでの行番号（1始まり）
    pub o: Option<usize>,
    /// 新ファイルでの行番号（1始まり）
    pub n: Option<usize>,
    /// 所属する変更ブロックの番号
    pub h: Option<usize>,
    /// (強調するか, テキスト) の列
    pub s: Vec<(bool, String)>,
}

/// 連続した変更行のまとまり。
#[derive(Serialize)]
pub struct Hunk {
    /// 旧ファイル側の [開始行, 行数]
    pub o: [usize; 2],
    /// 新ファイル側の [開始行, 行数]
    pub n: [usize; 2],
    /// `lines` 内の最初の行のインデックス
    pub first: usize,
}

pub fn diff_sources(old: &str, new: &str, ignore_ws: bool) -> SourceDiff {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let key = |l: &&str| -> String {
        if ignore_ws {
            l.split_whitespace().collect::<Vec<_>>().join(" ")
        } else {
            (*l).to_owned()
        }
    };
    let old_keys: Vec<String> = old_lines.iter().map(key).collect();
    let new_keys: Vec<String> = new_lines.iter().map(key).collect();
    let ops = capture_diff_slices(Algorithm::Histogram, &old_keys, &new_keys);

    let mut out = SourceDiff {
        lines: Vec::new(),
        hunks: Vec::new(),
        ins: 0,
        del: 0,
    };
    let mut in_hunk = false;

    for op in ops {
        if let DiffOp::Equal {
            old_index,
            new_index,
            len,
        } = op
        {
            in_hunk = false;
            for i in 0..len {
                out.lines.push(Line {
                    k: 'e',
                    o: Some(old_index + i + 1),
                    n: Some(new_index + i + 1),
                    h: None,
                    s: vec![(false, new_lines[new_index + i].to_owned())],
                });
            }
            continue;
        }

        let (o_range, n_range) = (op.old_range(), op.new_range());
        if !in_hunk {
            out.hunks.push(Hunk {
                o: [o_range.start + 1, 0],
                n: [n_range.start + 1, 0],
                first: out.lines.len(),
            });
            in_hunk = true;
        }
        let h = out.hunks.len() - 1;
        let hunk = &mut out.hunks[h];
        hunk.o[1] += o_range.len();
        hunk.n[1] += n_range.len();

        // 削除行と追加行を上から順にペアにして行内差分を取る
        let mut old_segs = Vec::new();
        let mut new_segs = Vec::new();
        for (oi, ni) in o_range.clone().zip(n_range.clone()) {
            let (a, b) = inline_diff(old_lines[oi], new_lines[ni]);
            old_segs.push(a);
            new_segs.push(b);
        }
        for (pos, oi) in o_range.enumerate() {
            let s = old_segs
                .get(pos)
                .cloned()
                .unwrap_or_else(|| vec![(false, old_lines[oi].to_owned())]);
            out.lines.push(Line {
                k: 'd',
                o: Some(oi + 1),
                n: None,
                h: Some(h),
                s,
            });
            out.del += 1;
        }
        for (pos, ni) in n_range.enumerate() {
            let s = new_segs
                .get(pos)
                .cloned()
                .unwrap_or_else(|| vec![(false, new_lines[ni].to_owned())]);
            out.lines.push(Line {
                k: 'i',
                o: None,
                n: Some(ni + 1),
                h: Some(h),
                s,
            });
            out.ins += 1;
        }
    }
    out
}

type Segments = Vec<(bool, String)>;

/// 2行の行内差分。英数字の連続・空白の連続・それ以外の1文字（日本語など）を単位とする。
fn inline_diff(old: &str, new: &str) -> (Segments, Segments) {
    let a = tokenize(old);
    let b = tokenize(new);
    let ops = capture_diff_slices(Algorithm::Myers, &a, &b);

    let mut old_segs: Segments = Vec::new();
    let mut new_segs: Segments = Vec::new();
    for op in ops {
        let changed = !matches!(op, DiffOp::Equal { .. });
        push_seg(&mut old_segs, changed, a[op.old_range()].concat());
        push_seg(&mut new_segs, changed, b[op.new_range()].concat());
    }

    // ほぼ全体が変わっているなら強調はかえって読みにくいのでやめる
    let mostly_changed = |segs: &Segments| {
        let total: usize = segs.iter().map(|(_, t)| t.chars().count()).sum();
        let changed: usize = segs
            .iter()
            .filter(|(c, _)| *c)
            .map(|(_, t)| t.chars().count())
            .sum();
        total > 0 && changed * 10 > total * 7
    };
    if mostly_changed(&old_segs) || mostly_changed(&new_segs) {
        return (
            vec![(false, old.to_owned())],
            vec![(false, new.to_owned())],
        );
    }
    (old_segs, new_segs)
}

fn push_seg(segs: &mut Segments, changed: bool, text: String) {
    if text.is_empty() {
        return;
    }
    match segs.last_mut() {
        Some((c, t)) if *c == changed => t.push_str(&text),
        _ => segs.push((changed, text)),
    }
}

fn tokenize(s: &str) -> Vec<&str> {
    #[derive(PartialEq, Clone, Copy)]
    enum Class {
        Word,
        Space,
        Other,
    }
    let class = |c: char| {
        if c.is_ascii_alphanumeric() || c == '_' {
            Class::Word
        } else if c.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        }
    };
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut prev: Option<Class> = None;
    for (i, c) in s.char_indices() {
        let cl = class(c);
        if let Some(p) = prev
            && (p != cl || cl == Class::Other)
        {
            tokens.push(&s[start..i]);
            start = i;
        }
        prev = Some(cl);
    }
    if start < s.len() {
        tokens.push(&s[start..]);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_hunks() {
        let d = diff_sources("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n", false);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.hunks[0].o, [2, 1]);
        assert_eq!(d.hunks[0].n, [2, 1]);
        assert_eq!(d.hunks[1].n, [5, 1]);
        assert_eq!((d.ins, d.del), (2, 1));
    }

    #[test]
    fn ignore_whitespace() {
        let d = diff_sources("<p>  hi</p>\n", "<p> hi</p>\n", true);
        assert!(d.hunks.is_empty());
    }

    #[test]
    fn inline_emphasis() {
        let (a, b) = inline_diff("<p class=\"title\">こんにちは</p>", "<p class=\"title\">こんばんは</p>");
        assert!(a.iter().any(|(c, t)| *c && t == "にち"));
        assert!(b.iter().any(|(c, t)| *c && t == "ばん"));
    }
}
