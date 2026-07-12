//! Shared search result types for `web_search` providers.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone)]
pub struct SearchOutcome {
    pub provider: &'static str,
    pub results: Vec<SearchResult>,
}
