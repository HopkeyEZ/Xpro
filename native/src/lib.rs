use napi_derive::napi;
use std::path::Path;

mod search;
mod diff;

/// 高速文件搜索（基于 Rust ignore + walkdir）
#[napi]
pub fn file_search(dir: String, pattern: String, max_results: Option<u32>) -> Vec<SearchResult> {
    search::file_search(&dir, &pattern, max_results.unwrap_or(200))
}

/// 高速文本搜索（类 ripgrep）
#[napi]
pub fn text_search(dir: String, query: String, max_results: Option<u32>) -> Vec<TextMatch> {
    search::text_search(&dir, &query, max_results.unwrap_or(500))
}

/// 快速 diff 计算
#[napi]
pub fn compute_diff(old_text: String, new_text: String) -> Vec<DiffChunk> {
    diff::compute_diff(&old_text, &new_text)
}

/// 获取文件统计信息
#[napi]
pub fn file_stats(dir: String) -> FileStatsResult {
    let mut total_files: u32 = 0;
    let mut total_dirs: u32 = 0;
    let mut total_bytes: u64 = 0;

    if let Ok(entries) = std::fs::read_dir(Path::new(&dir)) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total_files += 1;
                    total_bytes += meta.len();
                } else if meta.is_dir() {
                    total_dirs += 1;
                }
            }
        }
    }

    FileStatsResult { total_files, total_dirs, total_bytes }
}

#[napi(object)]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[napi(object)]
pub struct TextMatch {
    pub path: String,
    pub line_number: u32,
    pub line_content: String,
}

#[napi(object)]
pub struct DiffChunk {
    /// "equal", "insert", "delete"
    pub tag: String,
    pub content: String,
}

#[napi(object)]
pub struct FileStatsResult {
    pub total_files: u32,
    pub total_dirs: u32,
    pub total_bytes: u64,
}
