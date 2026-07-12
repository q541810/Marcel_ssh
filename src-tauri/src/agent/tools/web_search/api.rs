//! Independent search-engine HTTP APIs (not OpenAI chat format).

use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

use crate::config::settings::WebSearchApiProvider;
use crate::error::AppError;

use super::types::{SearchOutcome, SearchResult};

const TIMEOUT_SECS: u64 = 20;

pub async fn search(
    provider: WebSearchApiProvider,
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, AppError> {
    if api_key.trim().is_empty() {
        return Err(AppError::Agent(
            "search API key is not configured; set it in Settings → Agent tools".into(),
        ));
    }

    match provider {
        WebSearchApiProvider::Brave => search_brave(api_key, query, max_results).await,
        WebSearchApiProvider::Tavily => search_tavily(api_key, query, max_results).await,
    }
}

async fn search_brave(
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, AppError> {
    #[derive(Debug, Deserialize)]
    struct BraveResponse {
        #[serde(default)]
        web: Option<BraveWeb>,
    }
    #[derive(Debug, Deserialize)]
    struct BraveWeb {
        #[serde(default)]
        results: Vec<BraveItem>,
    }
    #[derive(Debug, Deserialize)]
    struct BraveItem {
        title: Option<String>,
        url: Option<String>,
        description: Option<String>,
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Agent(format!("failed to create HTTP client: {}", e)))?;

    let count = max_results.clamp(1, 20);
    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .query(&[("q", query), ("count", &count.to_string())])
        .send()
        .await
        .map_err(|e| AppError::Agent(format!("Brave search request failed: {}", e)))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Agent(format!("failed to read Brave response: {}", e)))?;

    if !status.is_success() {
        return Err(AppError::Agent(format!(
            "Brave search HTTP {}: {}",
            status,
            truncate_err(&body)
        )));
    }

    let parsed: BraveResponse = serde_json::from_str(&body)
        .map_err(|e| AppError::Agent(format!("invalid Brave response: {}", e)))?;

    let results = map_brave_items(
        parsed
            .web
            .map(|w| w.results)
            .unwrap_or_default()
            .into_iter()
            .map(|item| (item.title, item.url, item.description)),
        max_results,
    );

    Ok(SearchOutcome {
        provider: "api:brave",
        results,
    })
}


async fn search_tavily(
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, AppError> {
    #[derive(Debug, Deserialize)]
    struct TavilyResponse {
        #[serde(default)]
        results: Vec<TavilyItem>,
    }
    #[derive(Debug, Deserialize)]
    struct TavilyItem {
        title: Option<String>,
        url: Option<String>,
        content: Option<String>,
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Agent(format!("failed to create HTTP client: {}", e)))?;

    let payload = serde_json::json!({
        "api_key": api_key,
        "query": query,
        "max_results": max_results.clamp(1, 20),
        "include_answer": false,
        "search_depth": "basic",
    });

    let resp = client
        .post("https://api.tavily.com/search")
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::Agent(format!("Tavily search request failed: {}", e)))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Agent(format!("failed to read Tavily response: {}", e)))?;

    if !status.is_success() {
        return Err(AppError::Agent(format!(
            "Tavily search HTTP {}: {}",
            status,
            truncate_err(&body)
        )));
    }

    let parsed: TavilyResponse = serde_json::from_str(&body)
        .map_err(|e| AppError::Agent(format!("invalid Tavily response: {}", e)))?;

    let results = map_tavily_items(
        parsed
            .results
            .into_iter()
            .map(|item| (item.title, item.url, item.content)),
        max_results,
    );

    Ok(SearchOutcome {
        provider: "api:tavily",
        results,
    })
}

fn map_brave_items<I>(items: I, max_results: usize) -> Vec<SearchResult>
where
    I: IntoIterator<Item = (Option<String>, Option<String>, Option<String>)>,
{
    items
        .into_iter()
        .filter_map(|(title, url, description)| {
            let title = title.unwrap_or_default().trim().to_string();
            let url = url.unwrap_or_default().trim().to_string();
            if title.is_empty() || url.is_empty() {
                return None;
            }
            Some(SearchResult {
                title,
                url,
                snippet: description.unwrap_or_default(),
            })
        })
        .take(max_results)
        .collect()
}

fn map_tavily_items<I>(items: I, max_results: usize) -> Vec<SearchResult>
where
    I: IntoIterator<Item = (Option<String>, Option<String>, Option<String>)>,
{
    items
        .into_iter()
        .filter_map(|(title, url, content)| {
            let title = title.unwrap_or_default().trim().to_string();
            let url = url.unwrap_or_default().trim().to_string();
            if title.is_empty() || url.is_empty() {
                return None;
            }
            Some(SearchResult {
                title,
                url,
                snippet: content.unwrap_or_default(),
            })
        })
        .take(max_results)
        .collect()
}

fn truncate_err(s: &str) -> String {
    let t = s.trim();
    if t.len() > 240 {
        format!("{}…", &t[..240])
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::WebSearchApiProvider;

    #[tokio::test]
    async fn api_brave_mode_requires_key() {
        let err = search(WebSearchApiProvider::Brave, "  ", "q", 5)
            .await
            .expect_err("empty key");
        let msg = err.to_string();
        assert!(
            msg.to_ascii_lowercase().contains("key"),
            "expected key error, got {msg}"
        );
    }

    #[tokio::test]
    async fn api_tavily_mode_requires_key() {
        let err = search(WebSearchApiProvider::Tavily, "", "q", 5)
            .await
            .expect_err("empty key");
        let msg = err.to_string();
        assert!(
            msg.to_ascii_lowercase().contains("key"),
            "expected key error, got {msg}"
        );
    }

    #[test]
    fn map_brave_items_skips_incomplete_and_respects_max() {
        let items = vec![
            (
                Some("A".into()),
                Some("https://a.example".into()),
                Some("sa".into()),
            ),
            (Some("B".into()), None, Some("sb".into())),
            (
                Some("C".into()),
                Some("https://c.example".into()),
                Some("sc".into()),
            ),
            (
                Some("D".into()),
                Some("https://d.example".into()),
                Some("sd".into()),
            ),
        ];
        let results = map_brave_items(items, 2);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "A");
        assert_eq!(results[1].title, "C");
        assert_eq!(results[0].snippet, "sa");
    }

    #[test]
    fn map_tavily_items_maps_content_to_snippet() {
        let items = vec![(
            Some("Tok".into()),
            Some("https://tokio.rs".into()),
            Some("async runtime".into()),
        )];
        let results = map_tavily_items(items, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://tokio.rs");
        assert_eq!(results[0].snippet, "async runtime");
    }

    #[test]
    fn api_brave_mode_outcome_provider_label() {
        let results = map_brave_items(
            vec![(
                Some("X".into()),
                Some("https://x.example".into()),
                Some("sx".into()),
            )],
            5,
        );
        let outcome = SearchOutcome {
            provider: "api:brave",
            results,
        };
        assert_eq!(outcome.provider, "api:brave");
        assert_eq!(outcome.results[0].title, "X");
    }

    #[test]
    fn api_tavily_mode_outcome_provider_label() {
        let results = map_tavily_items(
            vec![(
                Some("Y".into()),
                Some("https://y.example".into()),
                Some("sy".into()),
            )],
            5,
        );
        let outcome = SearchOutcome {
            provider: "api:tavily",
            results,
        };
        assert_eq!(outcome.provider, "api:tavily");
        assert_eq!(outcome.results[0].snippet, "sy");
    }

    #[test]
    fn map_brave_and_tavily_empty_input() {
        assert!(map_brave_items(Vec::<(
            Option<String>,
            Option<String>,
            Option<String>
        )>::new(), 5)
        .is_empty());
        assert!(map_tavily_items(Vec::<(
            Option<String>,
            Option<String>,
            Option<String>
        )>::new(), 5)
        .is_empty());
    }
}


