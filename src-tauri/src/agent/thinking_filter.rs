//! Thinking tag filtering for LLM output.
//!
//! Provides both streaming (chunk-aware) and complete-text filtering.

/// Thinking tag markers used by many LLMs
pub(crate) const THINKING_START_TAGS: &[&str] = &["<thinking>", "<Thought>", "<think>"];
pub(crate) const THINKING_END_TAGS: &[&str] = &["</thinking>", "</Thought>", "</think>"];

/// Streaming filter: handles fragmented thinking tags across chunks.
/// Returns (filtered_text, still_in_thinking).
pub(crate) fn filter_thinking_tags(input: &str, in_thinking: bool) -> (String, bool) {
    if !in_thinking {
        // Look for the earliest start tag
        let mut earliest_start: Option<(usize, usize)> = None;
        for tag in THINKING_START_TAGS {
            if let Some(pos) = input.find(tag) {
                if earliest_start.map_or(true, |(_, epos)| pos < epos) {
                    earliest_start = Some((pos, pos + tag.len()));
                }
            }
        }

        match earliest_start {
            Some((start_pos, end_of_tag)) => {
                // Return text before the tag, enter thinking mode
                let before = &input[..start_pos];
                let after = &input[end_of_tag..];
                // Check if end tag also exists in the same chunk
                let mut earliest_end: Option<(usize, usize)> = None;
                for tag in THINKING_END_TAGS {
                    if let Some(pos) = after.find(tag) {
                        if earliest_end.map_or(true, |(_, epos)| pos < epos) {
                            earliest_end = Some((pos, pos + tag.len()));
                        }
                    }
                }
                match earliest_end {
                    Some((_end_pos, end_of_end_tag)) => {
                        // Both start and end in same chunk: skip thinking content, remain out of thinking
                        let rest = &after[end_of_end_tag..];
                        let (rest_filtered, still) = filter_thinking_tags(rest, false);
                        let mut result = before.to_string();
                        result.push_str(&rest_filtered);
                        (result, still)
                    }
                    None => {
                        // No end tag — everything after start tag is thinking
                        (before.to_string(), true)
                    }
                }
            }
            None => (input.to_string(), false),
        }
    } else {
        // We're inside a thinking block — look for the earliest end tag
        let mut earliest_end: Option<(usize, usize)> = None;
        for tag in THINKING_END_TAGS {
            if let Some(pos) = input.find(tag) {
                if earliest_end.map_or(true, |(_, epos)| pos < epos) {
                    earliest_end = Some((pos, pos + tag.len()));
                }
            }
        }

        match earliest_end {
            Some((_end_pos, end_of_tag)) => {
                // Found end tag — recurse on the rest after it
                let rest = &input[end_of_tag..];
                filter_thinking_tags(rest, false)
            }
            None => {
                // Still inside thinking — discard entire chunk
                (String::new(), true)
            }
        }
    }
}

/// Strip thinking tags from complete text (defense-in-depth).
pub(crate) fn strip_thinking_tags(content: &str) -> String {
    let mut result = String::new();
    let mut remaining = content;

    loop {
        // Find the earliest start tag
        let mut earliest_start: Option<(usize, usize)> = None;
        for tag in THINKING_START_TAGS {
            if let Some(pos) = remaining.find(tag) {
                if earliest_start.map_or(true, |(_, epos)| pos < epos) {
                    earliest_start = Some((pos, pos + tag.len()));
                }
            }
        }

        match earliest_start {
            Some((start_pos, end_of_tag)) => {
                // Append everything before the start tag
                result.push_str(&remaining[..start_pos]);
                // Find the corresponding end tag after the start position
                let after_start = &remaining[end_of_tag..];
                let mut earliest_end = None;
                for tag in THINKING_END_TAGS {
                    if let Some(pos) = after_start.find(tag) {
                        if earliest_end.map_or(true, |(_, epos)| pos < epos) {
                            earliest_end = Some((pos, pos + tag.len()));
                        }
                    }
                }
                match earliest_end {
                    Some((_end_pos, end_of_end_tag)) => {
                        // Skip content between start and end tags, continue AFTER the end tag
                        remaining = &after_start[end_of_end_tag..];
                    }
                    None => {
                        // No end tag found — discard the rest
                        return result;
                    }
                }
            }
            None => {
                // No more start tags, append remaining content
                result.push_str(remaining);
                return result;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ──────────── filter_thinking_tags (streaming) ────────────

    #[test]
    fn filter_no_tags_returns_input() {
        let (out, still) = filter_thinking_tags("hello world", false);
        assert_eq!(out, "hello world");
        assert!(!still);
    }

    #[test]
    fn filter_start_tag_enters_thinking() {
        let (out, still) = filter_thinking_tags("text <thinking> secret", false);
        assert_eq!(out, "text ");
        assert!(still);
    }

    #[test]
    fn filter_end_tag_exits_thinking() {
        let (out, still) = filter_thinking_tags(" secret </thinking> visible", true);
        assert_eq!(out, " visible");
        assert!(!still);
    }

    #[test]
    fn filter_start_and_end_in_same_chunk() {
        let (out, still) = filter_thinking_tags("<thinking>secret</thinking> visible", false);
        assert_eq!(out, " visible");
        assert!(!still);
    }

    #[test]
    fn filter_multiple_tags_in_chunk() {
        let (out, still) = filter_thinking_tags("a <thinking>x</thinking> b <thinking>", false);
        assert_eq!(out, "a  b ");
        assert!(still);
    }

    #[test]
    fn filter_thought_tag_variant() {
        let (out, still) = filter_thinking_tags("pre <Thought> inner </Thought> post", false);
        assert_eq!(out, "pre  post");
        assert!(!still);
    }

    #[test]
    fn filter_think_tag_variant() {
        let (out, still) = filter_thinking_tags("<think> inner </think>", false);
        assert_eq!(out, "");
        assert!(!still);
    }

    #[test]
    fn filter_cross_chunk_start_to_end() {
        let (out1, still1) = filter_thinking_tags("before <thinking> mid", false);
        assert_eq!(out1, "before ");
        assert!(still1);

        let (out2, still2) = filter_thinking_tags("dle </thinking> after", true);
        assert_eq!(out2, " after");
        assert!(!still2);
    }

    #[test]
    fn filter_empty_input() {
        let (out, still) = filter_thinking_tags("", false);
        assert_eq!(out, "");
        assert!(!still);

        let (out, still) = filter_thinking_tags("", true);
        assert_eq!(out, "");
        assert!(still);
    }

    #[test]
    fn filter_still_in_thinking_discards_all() {
        let (out, still) = filter_thinking_tags("more secret stuff", true);
        assert_eq!(out, "");
        assert!(still);
    }

    // ──────────── strip_thinking_tags (complete text) ────────────

    #[test]
    fn strip_no_tags_returns_original() {
        assert_eq!(strip_thinking_tags("hello world"), "hello world");
    }

    #[test]
    fn strip_single_tag_pair() {
        assert_eq!(
            strip_thinking_tags("a <thinking>b</thinking> c"),
            "a  c"
        );
    }

    #[test]
    fn strip_multiple_tag_pairs() {
        assert_eq!(
            strip_thinking_tags("<thinking>a</thinking> x <thinking>b</thinking>"),
            " x "
        );
    }

    #[test]
    fn strip_unclosed_tag_discards_rest() {
        assert_eq!(strip_thinking_tags("visible <thinking> secret"), "visible ");
    }

    #[test]
    fn strip_thought_variant() {
        assert_eq!(
            strip_thinking_tags("<Thought>inner</Thought>"),
            ""
        );
    }

    #[test]
    fn strip_empty_input() {
        assert_eq!(strip_thinking_tags(""), "");
    }
}
