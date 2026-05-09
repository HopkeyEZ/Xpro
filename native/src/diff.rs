use crate::DiffChunk;

/// 简单行级 diff（Myers-like）
pub fn compute_diff(old_text: &str, new_text: &str) -> Vec<DiffChunk> {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();

    let mut chunks = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);

    while i < old_lines.len() && j < new_lines.len() {
        if old_lines[i] == new_lines[j] {
            chunks.push(DiffChunk {
                tag: "equal".to_string(),
                content: old_lines[i].to_string(),
            });
            i += 1;
            j += 1;
        } else {
            // 尝试向前查找匹配
            let mut found_old = None;
            let mut found_new = None;
            let lookahead = 5.min(old_lines.len() - i).min(new_lines.len() - j);

            for k in 1..=lookahead {
                if i + k < old_lines.len() && old_lines[i + k] == new_lines[j] {
                    found_old = Some(k);
                    break;
                }
                if j + k < new_lines.len() && old_lines[i] == new_lines[j + k] {
                    found_new = Some(k);
                    break;
                }
            }

            match (found_old, found_new) {
                (Some(k), _) => {
                    for di in 0..k {
                        chunks.push(DiffChunk {
                            tag: "delete".to_string(),
                            content: old_lines[i + di].to_string(),
                        });
                    }
                    i += k;
                }
                (_, Some(k)) => {
                    for dj in 0..k {
                        chunks.push(DiffChunk {
                            tag: "insert".to_string(),
                            content: new_lines[j + dj].to_string(),
                        });
                    }
                    j += k;
                }
                _ => {
                    chunks.push(DiffChunk {
                        tag: "delete".to_string(),
                        content: old_lines[i].to_string(),
                    });
                    chunks.push(DiffChunk {
                        tag: "insert".to_string(),
                        content: new_lines[j].to_string(),
                    });
                    i += 1;
                    j += 1;
                }
            }
        }
    }

    while i < old_lines.len() {
        chunks.push(DiffChunk {
            tag: "delete".to_string(),
            content: old_lines[i].to_string(),
        });
        i += 1;
    }

    while j < new_lines.len() {
        chunks.push(DiffChunk {
            tag: "insert".to_string(),
            content: new_lines[j].to_string(),
        });
        j += 1;
    }

    chunks
}
