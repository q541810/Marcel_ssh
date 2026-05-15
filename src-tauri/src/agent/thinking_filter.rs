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
