use crate::{SearchResult, TextMatch};
use std::path::Path;
use walkdir::WalkDir;

/// 文件名搜索
pub fn file_search(dir: &str, pattern: &str, max_results: u32) -> Vec<SearchResult> {
    let pattern_lower = pattern.to_lowercase();
    let mut results = Vec::new();

    for entry in WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
                && name != "node_modules"
                && name != "target"
                && name != "__pycache__"
                && name != ".git"
        })
        .flatten()
    {
        if results.len() >= max_results as usize {
            break;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if name.to_lowercase().contains(&pattern_lower) {
            results.push(SearchResult {
                path: entry.path().to_string_lossy().to_string(),
                name,
                is_dir: entry.file_type().is_dir(),
            });
        }
    }

    results
}

/// 文本内容搜索
pub fn text_search(dir: &str, query: &str, max_results: u32) -> Vec<TextMatch> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    let text_exts = [
        "rs", "py", "js", "ts", "jsx", "tsx", "java", "c", "cpp", "h", "hpp",
        "go", "html", "css", "json", "toml", "yaml", "yml", "md", "sql", "sh",
        "vue", "xml", "txt", "cfg", "ini",
    ];

    for entry in WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
                && name != "node_modules"
                && name != "target"
                && name != "__pycache__"
                && name != ".git"
                && name != "dist"
                && name != "build"
        })
        .flatten()
    {
        if results.len() >= max_results as usize {
            break;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !text_exts.contains(&ext.as_str()) {
            continue;
        }

        if let Ok(content) = std::fs::read_to_string(path) {
            for (i, line) in content.lines().enumerate() {
                if results.len() >= max_results as usize {
                    break;
                }
                if line.to_lowercase().contains(&query_lower) {
                    results.push(TextMatch {
                        path: path.to_string_lossy().to_string(),
                        line_number: (i + 1) as u32,
                        line_content: line.to_string(),
                    });
                }
            }
        }
    }

    results
}
