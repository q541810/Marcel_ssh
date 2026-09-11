//! Shared search result types for `web_search` providers.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Why a search produced no results even though the request "succeeded".
///
/// An empty result list has two very different meanings, and conflating them was
/// why a blocked search used to read as "No results found".
#[derive(Debug, Clone)]
pub enum Interception {
    /// The engine answered with a bot-verification interstitial.
    Challenge { vendor: &'static str },
    /// A document came back, but it was not a search results page (an error
    /// page, an unrelated redirect, or a layout that no longer matches).
    NotAResultsPage { detail: String },
}

impl Interception {
    /// One-line explanation for the model and the user.
    pub fn describe(&self) -> String {
        match self {
            Self::Challenge { vendor } => format!(
                "the engine returned a bot-verification page ({}) instead of results",
                vendor
            ),
            Self::NotAResultsPage { detail } => {
                format!("the returned document was not a results page ({})", detail)
            }
        }
    }

    /// Machine-readable tag for metadata.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Challenge { .. } => "challenge",
            Self::NotAResultsPage { .. } => "not-a-results-page",
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Challenge { vendor } => serde_json::json!({
                "kind": self.kind(),
                "vendor": vendor,
            }),
            Self::NotAResultsPage { detail } => serde_json::json!({
                "kind": self.kind(),
                "detail": detail,
            }),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchOutcome {
    /// Label of the backend that actually served the request.
    pub provider: &'static str,
    pub results: Vec<SearchResult>,
    /// Set when the request did not reach a results page.
    pub interception: Option<Interception>,
}
