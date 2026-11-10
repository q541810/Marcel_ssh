//! Change only executable names, never quoted data, comments or heredoc bodies.
use std::ops::Range;
use tree_sitter::{Node, Parser};

pub(super) fn prepare(script: &str, directory: Option<&str>) -> (bool, String) {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .expect("bundled shell grammar");
    let Some(tree) = parser.parse(script, None) else {
        return (false, script.into());
    };
    let mut edits = Vec::new();
    let mut found = false;
    let mut nodes = vec![tree.root_node()];
    while let Some(node) = nodes.pop() {
        if node.kind() == "command" {
            inspect_command(node, script, directory, &mut found, &mut edits);
        }
        let mut cursor = node.walk();
        nodes.extend(node.named_children(&mut cursor));
    }
    edits.sort_by_key(|(range, _): &(Range<usize>, String)| range.start);
    let mut result = script.to_owned();
    for (range, replacement) in edits.into_iter().rev() {
        result.replace_range(range, &replacement);
    }
    (found, result)
}

fn literal(node: Node<'_>, script: &str) -> Option<String> {
    let mut nodes = vec![node];
    while let Some(part) = nodes.pop() {
        if matches!(
            part.kind(),
            "expansion" | "simple_expansion" | "command_substitution" | "arithmetic_expansion"
        ) {
            return None;
        }
        let mut cursor = part.walk();
        nodes.extend(part.named_children(&mut cursor));
    }
    let words = shell_words::split(&script[node.byte_range()]).ok()?;
    (words.len() == 1).then(|| words[0].clone())
}

fn inspect_command(
    node: Node<'_>,
    script: &str,
    directory: Option<&str>,
    found: &mut bool,
    edits: &mut Vec<(Range<usize>, String)>,
) {
    let Some(name) = node.child_by_field_name("name") else {
        return;
    };
    let mut cursor = node.walk();
    let words: Vec<_> = std::iter::once(name)
        .chain(node.children_by_field_name("argument", &mut cursor))
        .collect();
    let mut i = 0;
    while i < words.len() {
        let Some(word) = literal(words[i], script) else {
            return;
        };
        let base = word.rsplit('/').next().unwrap_or(&word);
        if base == "sudo" {
            *found = true;
            if let Some(dir) = directory {
                if word.contains('/') {
                    edits.push((
                        words[i].byte_range(),
                        format!(
                            "{} {}",
                            shell_words::quote(&format!("{dir}/invoke")),
                            shell_words::quote(&word)
                        ),
                    ));
                } else {
                    edits.push((
                        words[i].byte_range(),
                        shell_words::quote(&format!("{dir}/sudo")).into_owned(),
                    ));
                }
            }
            return;
        }
        if matches!(base, "sh" | "bash" | "dash" | "ash" | "zsh" | "ksh") {
            // Only literal -c scripts can be rewritten without changing expansion timing.
            for pair in words[i + 1..].windows(2) {
                if literal(pair[0], script).is_some_and(|arg| {
                    arg.starts_with('-') && !arg.starts_with("--") && arg.contains('c')
                }) {
                    if let Some(inner) = literal(pair[1], script) {
                        let (has_sudo, rewritten) = prepare(&inner, directory);
                        *found |= has_sudo;
                        if rewritten != inner {
                            edits.push((
                                pair[1].byte_range(),
                                shell_words::quote(&rewritten).into_owned(),
                            ));
                        }
                    }
                    break;
                }
            }
            return;
        }
        if !matches!(
            base,
            "env" | "command" | "exec" | "nohup" | "nice" | "ionice"
        ) {
            return;
        }
        i += 1;
        while i < words.len() {
            let Some(arg) = literal(words[i], script) else {
                return;
            };
            if arg == "--" {
                i += 1;
                break;
            }
            if base == "command" && matches!(arg.as_str(), "-v" | "-V") {
                return;
            }
            if base == "env" && arg.contains('=') {
                i += 1;
                continue;
            }
            if !arg.starts_with('-') {
                break;
            }
            // Options that consume the next word; commands themselves stay in place.
            let takes_value = matches!(
                (base, arg.as_str()),
                ("env", "-u" | "--unset" | "-C" | "--chdir")
                    | ("exec", "-a")
                    | ("nice", "-n" | "--adjustment")
                    | ("ionice", "-c" | "-n" | "-p" | "-P" | "-u")
            );
            // env -S interprets its own language. Leave it to the actual env utility.
            if base == "env" && matches!(arg.as_str(), "-S" | "--split-string") {
                return;
            }
            i += if takes_value { 2 } else { 1 };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_executables_without_touching_data_or_expansions() {
        let script = "echo '/usr/bin/sudo 中文'; # /usr/bin/sudo\ncat <<'END'\n/usr/bin/sudo ignored\nEND\nprintf x | A=1 /usr/bin/sudo cat; echo $(sudo id)";
        let (found, output) = prepare(script, Some("/tmp/test"));
        assert!(found);
        assert_eq!(
            output,
            script
                .replace("A=1 /usr/bin/sudo", "A=1 /tmp/test/invoke /usr/bin/sudo")
                .replace("$(sudo id)", "$(/tmp/test/sudo id)")
        );
    }

    #[test]
    fn detects_commands_inside_control_flow_and_wrappers() {
        for script in [
            "sudo id",
            "env A=1 /usr/bin/sudo id",
            "if true; then sudo id; fi",
            "for x in a b; do sudo id; done",
            "x=$(sudo id)",
            "sh -c 'sudo id'",
            "command -- sudo id",
        ] {
            assert!(prepare(script, None).0, "{script}");
        }
        for script in [
            "echo sudo",
            "printf '/usr/bin/sudo'",
            "cat <<'END'\nsudo id\nEND",
            "# sudo id",
            "x=sudo",
            "env X=sudo echo ok",
            "command -v sudo",
            "command -V sudo",
        ] {
            assert!(!prepare(script, None).0, "{script}");
        }
    }

    #[test]
    fn rewrites_literal_nested_scripts_and_preserves_wrapper_arguments() {
        assert_eq!(
            prepare("env A=1 /usr/bin/sudo id", Some("/tmp/test")).1,
            "env A=1 /tmp/test/invoke /usr/bin/sudo id"
        );
        let output = prepare("sh -c '/usr/bin/sudo id; echo 中文'", Some("/tmp/test")).1;
        assert_eq!(
            shell_words::split(&output).unwrap(),
            ["sh", "-c", "/tmp/test/invoke /usr/bin/sudo id; echo 中文"]
        );
    }
}
