use std::io::Read;

use zip::ZipArchive;

/// Result of parsing a skill file package.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub prompt: String,
}

fn parse_yaml_frontmatter(content: &str) -> Result<ParsedSkill, String> {
    let content = content.trim();

    // Strip UTF-8 BOM if present
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);

    if !content.starts_with("---") {
        return Err("SKILL.md must start with --- YAML frontmatter delimiter".into());
    }

    let rest = &content[3..];
    let end = rest
        .find("---")
        .ok_or("Missing closing --- after YAML frontmatter")?;

    let yaml_block = &rest[..end].trim();
    let markdown_body = rest[end + 3..].trim();

    // Parse YAML
    let data: serde_yaml::Value =
        serde_yaml::from_str(yaml_block).map_err(|e| format!("YAML 解析失败: {}", e))?;

    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("YAML frontmatter 缺少 name 字段")?
        .trim()
        .to_string();

    if name.is_empty() {
        return Err("name 字段不能为空".into());
    }

    let description = data
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // The rest of the markdown body becomes the prompt
    let prompt = if markdown_body.is_empty() {
        return Err("SKILL.md frontmatter 后缺少 prompt 内容".into());
    } else {
        markdown_body.to_string()
    };

    Ok(ParsedSkill {
        name,
        description,
        prompt,
    })
}

/// Parse a single .md file directly.
pub(crate) fn process_md(content: &str, file_name: &str) -> Result<ParsedSkill, String> {
    let skill_name = file_name.trim_end_matches(".md").trim_end_matches(".MD");
    parse_yaml_frontmatter(content).map(|mut p| {
        if p.name.is_empty() {
            p.name = skill_name.to_string();
        }
        p
    })
}

/// Unzip and find the .md file inside.
pub(crate) fn process_zip(data: &[u8]) -> Result<ParsedSkill, String> {
    let reader = std::io::Cursor::new(data);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("zip 解析失败: {}", e))?;

    // Collect all .md files at any nesting level
    let md_files: Vec<(String, Vec<u8>)> = {
        let mut files = Vec::new();
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("读取 zip 内文件失败: {}", e))?;
            let name = file.name().to_string();
            // Skip directories and hidden files
            if name.ends_with('/') || name.starts_with('.') || name.contains("/.") {
                continue;
            }
            if name.to_lowercase().ends_with(".md") {
                let mut buf = Vec::new();
                file.read_to_end(&mut buf)
                    .map_err(|e| format!("读取 zip 内文件失败: {}", e))?;
                files.push((name, buf));
            }
        }
        files
    };

    if md_files.is_empty() {
        return Err("压缩包内未找到 .md 文件".into());
    }

    if md_files.len() > 1 {
        let names: Vec<_> = md_files.iter().map(|(n, _)| n.clone()).collect();
        return Err(format!(
            "压缩包内包含 {} 个 .md 文件，请只保留一个：{}",
            md_files.len(),
            names.join(", ")
        ));
    }

    let (name, bytes) = md_files.into_iter().next().unwrap();
    let content =
        String::from_utf8(bytes).map_err(|e| format!("{} 不是有效的 UTF-8 文本: {}", name, e))?;

    process_md(&content, &name)
}
