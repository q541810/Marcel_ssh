//! WebDAV 适配器的测试：multistatus 解析（手写的各家样本）+ 对一个有状态的假 WebDAV 服务器
//! 跑请求构造 / 状态码映射 / 契约。
//!
//! 假服务器用项目里已有的 `axum`（不新增 dev 依赖）：真的存目录和文件、认真处理
//! PROPFIND / GET / PUT / MKCOL / DELETE，并且能切换成坚果云 / Nextcloud / 完整 URL 三种
//! 「方言」，还能打开几个怪癖（根目录不许建文件夹、集合删除要重定向、限流……）。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{header, Request, Response};
use axum::Router;
use base64::Engine;
use parking_lot::Mutex;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};

use super::*;
use crate::sync::storage::contract_tests;

// ── multistatus 解析：各家样本 ───────────────────────────────────────────

fn segs(path: &str) -> Vec<String> {
    url_path_segments(path)
}

fn names(entries: &[RemoteEntry]) -> Vec<(String, bool, u64)> {
    entries
        .iter()
        .map(|e| (e.name.clone(), e.is_dir, e.size))
        .collect()
}

/// 坚果云风格：`D:` 前缀、href 是**没编码的中文**、目录也带 getcontentlength。
const JIANGUOYUN: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/我的坚果云/marcel-sync/devices/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:getcontentlength>0</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/我的坚果云/marcel-sync/devices/abc123/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:getcontentlength>0</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/我的坚果云/marcel-sync/devices/读我 (1).txt</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>42</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>"#;

/// Nextcloud / SabreDAV 风格：小写 `d:` 前缀、href 百分号编码（空格是 %20）、目录的
/// getcontentlength 躺在 404 的 propstat 里。
const NEXTCLOUD: &str = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
 <d:response>
  <d:href>/remote.php/dav/files/alice/marcel-sync/devices/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/marcel-sync/devices/dev%20one/</d:href>
  <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
 <d:response>
  <d:href>/remote.php/dav/files/alice/marcel-sync/devices/%E6%88%91%E7%9A%84%20%E6%96%87%E4%BB%B6.msync</d:href>
  <d:propstat><d:prop><d:getcontentlength>1234</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>"#;

/// 默认命名空间（没有前缀）+ 完整 URL 形式的 href（IIS / 部分 NAS）。
const DEFAULT_NS_ABSOLUTE: &str = r#"<?xml version="1.0" encoding="utf-8" ?>
<multistatus xmlns="DAV:">
  <response><href>http://nas.local:5005/webdav/sync/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>http://nas.local:5005/webdav/sync/seg-000000000007.msync</href>
    <propstat><prop><resourcetype/><getcontentlength>9</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response><href>http://nas.local:5005/webdav/sync/%E8%AE%BE%E5%A4%87/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>"#;

#[test]
fn parses_jianguoyun_style_with_raw_chinese_hrefs() {
    let req = segs("/dav/我的坚果云/marcel-sync/devices/");
    let got = parse_multistatus(JIANGUOYUN, &req).unwrap();
    assert_eq!(
        names(&got),
        vec![
            ("abc123".to_string(), true, 0),
            ("读我 (1).txt".to_string(), false, 42),
        ],
        "自己（devices/）不能出现在结果里"
    );
}

#[test]
fn parses_nextcloud_style_with_percent_encoding_and_404_propstat() {
    // 请求路径来自 URL，是编码形式；解码后与 href 比较
    let req = segs("/remote.php/dav/files/alice/marcel-sync/devices/");
    let got = parse_multistatus(NEXTCLOUD, &req).unwrap();
    assert_eq!(
        names(&got),
        vec![
            ("dev one".to_string(), true, 0),
            ("我的 文件.msync".to_string(), false, 1234),
        ]
    );
}

#[test]
fn parses_default_namespace_and_absolute_url_hrefs() {
    let req = segs("/webdav/sync/");
    let got = parse_multistatus(DEFAULT_NS_ABSOLUTE, &req).unwrap();
    assert_eq!(
        names(&got),
        vec![
            ("seg-000000000007.msync".to_string(), false, 9),
            ("设备".to_string(), true, 0),
        ]
    );
}

#[test]
fn request_path_comparison_ignores_percent_encoding_case_and_trailing_slash() {
    // 请求路径是 `%E8%AE%BE` 大写十六进制，服务器回的 href 写成小写、没有尾斜杠
    let xml = r#"<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/%e8%ae%be%e5%a4%87</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/%e8%ae%be%e5%a4%87/a.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>3</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>"#;
    let got = parse_multistatus(xml, &segs("/dav/%E8%AE%BE%E5%A4%87/")).unwrap();
    assert_eq!(names(&got), vec![("a.txt".to_string(), false, 3)]);
}

#[test]
fn empty_directory_yields_no_entries() {
    let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/x/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#;
    assert!(parse_multistatus(xml, &segs("/dav/x/")).unwrap().is_empty());
}

#[test]
fn servers_that_ignore_depth_only_contribute_direct_children() {
    let xml = r#"<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/r/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/r/a/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/r/a/deep.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dav/r/b.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>2</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>"#;
    let got = parse_multistatus(xml, &segs("/dav/r/")).unwrap();
    assert_eq!(
        names(&got),
        vec![("a".to_string(), true, 0), ("b.txt".to_string(), false, 2)]
    );
}

#[test]
fn servers_that_drop_the_mount_prefix_still_list_children() {
    // 请求 /webdav/dir/，服务器的 href 却是挂载点内的 /dir/ 与 /dir/f.txt
    let xml = r#"<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dir/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/dir/f.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>"#;
    let got = parse_multistatus(xml, &segs("/webdav/dir/")).unwrap();
    assert_eq!(names(&got), vec![("f.txt".to_string(), false, 5)]);
}

#[test]
fn hidden_names_and_404_responses_are_dropped() {
    let xml = r#"<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/d/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/d/.seg-1.msync.marcel-sync-abc</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/d/gone.txt</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
      <d:response><d:href>/d/ok.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>8</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>"#;
    let got = parse_multistatus(xml, &segs("/d/")).unwrap();
    assert_eq!(names(&got), vec![("ok.txt".to_string(), false, 8)]);
}

#[test]
fn entities_in_names_are_unescaped() {
    let xml = r#"<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/d/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      <d:response><d:href>/d/a&amp;b.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>"#;
    let got = parse_multistatus(xml, &segs("/d/")).unwrap();
    assert_eq!(got[0].name, "a&b.txt");
}

#[test]
fn a_plain_web_page_is_reported_as_not_webdav() {
    let err =
        parse_multistatus("<html><body>Welcome to my cloud</body></html>", &segs("/")).unwrap_err();
    match err {
        StorageError::Other(m) => assert!(m.contains("不是 WebDAV"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn malformed_xml_gets_a_readable_error() {
    let err = parse_multistatus(
        "<d:multistatus xmlns:d=\"DAV:\"><d:response></d:multistatus>",
        &segs("/"),
    )
    .unwrap_err();
    assert!(matches!(err, StorageError::Other(_)));
}

// ── 构造参数 ─────────────────────────────────────────────────────────────

fn test_client() -> reqwest::Client {
    // 绕开系统代理：测试连的是回环地址，开发机上的代理软件不该影响结果。
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

fn storage(url: &str, root: &str) -> Result<WebDavStorage, StorageError> {
    WebDavStorage::with_client(url, "alice", "s3cret-pw", root, test_client())
}

#[test]
fn constructor_rejects_credentials_in_the_url_without_echoing_them() {
    let err = storage("https://alice:s3cret-pw@dav.example.com/dav/", "x").unwrap_err();
    assert!(!err.to_string().contains("s3cret-pw"));
    assert!(err.to_string().contains("用户名和密码"));
    assert!(storage("dav.example.com/dav", "x").is_err(), "缺 scheme");
    assert!(storage("ftp://dav.example.com/", "x").is_err());
    assert!(storage("https://dav.example.com/", "../x").is_err());
}

#[test]
fn urls_are_built_per_segment_with_trailing_slash_for_collections() {
    let s = storage(
        "https://dav.example.com/dav?x=1#f",
        "我的坚果云/marcel sync",
    )
    .unwrap();
    assert_eq!(
        s.url_for(&["devices", "a b", "seg+1%.msync"], false).as_str(),
        "https://dav.example.com/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/marcel%20sync/devices/a%20b/seg+1%25.msync"
    );
    assert_eq!(
        s.url_for(&["devices"], true).as_str(),
        "https://dav.example.com/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/marcel%20sync/devices/"
    );
    // 端点是站点根、root 为空：集合 URL 就是 "/"
    let root = storage("http://nas.local:5005", "").unwrap();
    assert_eq!(root.url_for(&[], true).as_str(), "http://nas.local:5005/");
    assert_eq!(root.host, "nas.local:5005");
}

#[test]
fn debug_output_never_contains_the_password() {
    let s = storage("https://dav.example.com/dav/", "x").unwrap();
    assert!(!format!("{s:?}").contains("s3cret-pw"));
}

#[test]
fn status_codes_map_to_the_right_error_kinds() {
    let dav = storage("https://dav.example.com/dav/", "x").unwrap();
    let jgy = storage("https://dav.jianguoyun.com/dav/", "x").unwrap();
    let resp = |code: u16, location: Option<&str>| {
        let mut b = Response::builder().status(code);
        if let Some(l) = location {
            b = b.header(header::LOCATION, l);
        }
        reqwest::Response::from(b.body("").unwrap())
    };
    assert!(matches!(
        dav.status_error(&resp(401, None), "x"),
        StorageError::Auth(_)
    ));
    assert!(matches!(
        dav.status_error(&resp(403, None), "x"),
        StorageError::Permission(_)
    ));
    assert!(matches!(
        dav.status_error(&resp(429, None), "x"),
        StorageError::Network(_)
    ));
    assert!(matches!(
        dav.status_error(&resp(503, None), "x"),
        StorageError::Network(_)
    ));
    assert!(matches!(
        dav.status_error(&resp(500, None), "x"),
        StorageError::Network(_)
    ));
    for code in [404, 405, 409, 413, 423, 507, 418] {
        assert!(
            matches!(
                dav.status_error(&resp(code, None), "x"),
                StorageError::Other(_)
            ),
            "{code}"
        );
    }
    // 坚果云的 401 / 403 带专门提示
    let m = jgy.status_error(&resp(401, None), "x").to_string();
    assert!(m.contains("应用密码"), "{m}");
    let m = jgy.status_error(&resp(403, None), "写入文件").to_string();
    assert!(m.contains("我的坚果云"), "{m}");
    // 重定向：说清楚去了哪，剥掉账号与查询串
    let m = dav
        .status_error(
            &resp(
                301,
                Some("https://bob:pw@dav.example.com/dav/new/?token=abc"),
            ),
            "x",
        )
        .to_string();
    assert!(m.contains("https://dav.example.com/dav/new/"), "{m}");
    assert!(!m.contains("pw") && !m.contains("token"), "{m}");
}

// ── 有状态的假 WebDAV 服务器 ─────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Flavor {
    /// `D:` 前缀、href 里中文不编码、目录也带 getcontentlength。
    Jianguoyun,
    /// `d:` 前缀、href 编码、目录的 getcontentlength 在 404 propstat。
    Nextcloud,
    /// 默认命名空间、href 是完整 URL。
    AbsoluteUrls,
}

struct Dav {
    mount: String,
    user: String,
    pass: String,
    flavor: Flavor,
    /// 相对挂载点的目录（无首尾斜杠），"" 恒存在。
    dirs: BTreeSet<String>,
    files: BTreeMap<String, Vec<u8>>,
    /// `METHOD /解码后的相对路径` 流水。
    log: Vec<String>,
    base_url: String,
    // 怪癖
    forbid_top_level_mkcol: bool,
    redirect_collection_delete: bool,
    /// 一律拒绝删除（模拟「能写能读、就是删不掉」的位置，比如 OpenList 在 MySQL 上的已知问题）。
    forbid_delete: bool,
    html_for_propfind: bool,
    reject_after: Option<usize>,
}

impl Dav {
    fn new(flavor: Flavor) -> Self {
        Dav {
            mount: "/dav".into(),
            user: "alice".into(),
            pass: "s3cret-pw".into(),
            flavor,
            dirs: BTreeSet::from([String::new()]),
            files: BTreeMap::new(),
            log: Vec::new(),
            base_url: String::new(),
            forbid_top_level_mkcol: false,
            redirect_collection_delete: false,
            forbid_delete: false,
            html_for_propfind: false,
            reject_after: None,
        }
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    fn href(&self, rel: &str, is_dir: bool) -> String {
        let slash = if is_dir && !rel.is_empty() { "/" } else { "" };
        let full = if rel.is_empty() {
            format!("{}/", self.mount)
        } else {
            format!("{}/{}{}", self.mount, rel, slash)
        };
        match self.flavor {
            // 非 ASCII 字符（中文）原样输出、ASCII 里的特殊字符照常编码：这是「href 里直接放中文」
            // 的服务器的合理形态（连 `%` 都不编码的服务器没法区分字面百分号，不在考虑之列）。
            Flavor::Jianguoyun => Self::xml_escape(
                &full
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || !c.is_ascii() || "-._~/".contains(c) {
                            c.to_string()
                        } else {
                            utf8_percent_encode(&c.to_string(), NON_ALPHANUMERIC).to_string()
                        }
                    })
                    .collect::<String>(),
            ),
            Flavor::Nextcloud | Flavor::AbsoluteUrls => {
                let enc = full
                    .split('/')
                    .map(|s| utf8_percent_encode(s, NON_ALPHANUMERIC).to_string())
                    .collect::<Vec<_>>()
                    .join("/");
                if self.flavor == Flavor::AbsoluteUrls {
                    format!("{}{}", self.base_url, enc)
                } else {
                    enc
                }
            }
        }
    }

    fn entry_xml(&self, rel: &str, is_dir: bool, len: usize) -> String {
        let (p, _) = self.prefix();
        let href = self.href(rel, is_dir);
        let rtype = if is_dir {
            format!("<{p}resourcetype><{p}collection/></{p}resourcetype>")
        } else {
            format!("<{p}resourcetype/>")
        };
        let body = match (self.flavor, is_dir) {
            (Flavor::Nextcloud, true) => format!(
                "<{p}propstat><{p}prop>{rtype}</{p}prop><{p}status>HTTP/1.1 200 OK</{p}status></{p}propstat>\
                 <{p}propstat><{p}prop><{p}getcontentlength/></{p}prop><{p}status>HTTP/1.1 404 Not Found</{p}status></{p}propstat>"
            ),
            (_, true) => format!(
                "<{p}propstat><{p}prop>{rtype}<{p}getcontentlength>0</{p}getcontentlength></{p}prop><{p}status>HTTP/1.1 200 OK</{p}status></{p}propstat>"
            ),
            (_, false) => format!(
                "<{p}propstat><{p}prop>{rtype}<{p}getcontentlength>{len}</{p}getcontentlength></{p}prop><{p}status>HTTP/1.1 200 OK</{p}status></{p}propstat>"
            ),
        };
        format!("<{p}response><{p}href>{href}</{p}href>{body}</{p}response>")
    }

    fn prefix(&self) -> (&'static str, &'static str) {
        match self.flavor {
            Flavor::Jianguoyun => ("D:", r#" xmlns:D="DAV:""#),
            Flavor::Nextcloud => ("d:", r#" xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns""#),
            Flavor::AbsoluteUrls => ("", r#" xmlns="DAV:""#),
        }
    }

    fn propfind(&self, rel: &str) -> String {
        let (p, ns) = self.prefix();
        let mut out = format!(r#"<?xml version="1.0" encoding="utf-8"?><{p}multistatus{ns}>"#);
        out.push_str(&self.entry_xml(rel, true, 0));
        let prefix = if rel.is_empty() {
            String::new()
        } else {
            format!("{rel}/")
        };
        for d in &self.dirs {
            if let Some(rest) = d.strip_prefix(&prefix) {
                if !rest.is_empty() && !rest.contains('/') {
                    out.push_str(&self.entry_xml(d, true, 0));
                }
            }
        }
        for (f, bytes) in &self.files {
            if let Some(rest) = f.strip_prefix(&prefix) {
                if !rest.contains('/') {
                    out.push_str(&self.entry_xml(f, false, bytes.len()));
                }
            }
        }
        out.push_str(&format!("</{p}multistatus>"));
        out
    }
}

fn reply(status: u16) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .unwrap()
}

async fn handle(State(dav): State<Arc<Mutex<Dav>>>, req: Request<Body>) -> Response<Body> {
    let (parts, body) = req.into_parts();
    let body = to_bytes(body, usize::MAX).await.unwrap_or_default();
    let raw_path = parts.uri.path().to_string();
    let decoded = percent_decode_str(&raw_path)
        .decode_utf8_lossy()
        .into_owned();
    let method = parts.method.as_str().to_string();

    let mut d = dav.lock();
    let mount = d.mount.clone();
    let rel = match decoded.strip_prefix(&mount) {
        Some(rest) => rest.trim_matches('/').to_string(),
        None => {
            d.log.push(format!("{method} {decoded}"));
            return reply(404);
        }
    };
    d.log.push(format!("{method} {rel}"));
    if let Some(n) = d.reject_after {
        if d.log.len() > n {
            return reply(429);
        }
    }
    let expected = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", d.user, d.pass))
    );
    let got = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if got != Some(expected.as_str()) {
        return reply(401);
    }
    let parent = |r: &str| {
        r.rsplit_once('/')
            .map(|(p, _)| p.to_string())
            .unwrap_or_default()
    };

    match method.as_str() {
        "PROPFIND" => {
            if parts.headers.get("depth").and_then(|v| v.to_str().ok()) != Some("1") {
                return reply(400);
            }
            if d.html_for_propfind {
                return Response::builder()
                    .status(200)
                    .header(header::CONTENT_TYPE, "text/html")
                    .body(Body::from("<html><body>My Cloud</body></html>"))
                    .unwrap();
            }
            if !d.dirs.contains(&rel) {
                return reply(404);
            }
            Response::builder()
                .status(207)
                .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                .body(Body::from(d.propfind(&rel)))
                .unwrap()
        }
        "GET" => match d.files.get(&rel) {
            Some(bytes) => Response::builder()
                .status(200)
                .body(Body::from(bytes.clone()))
                .unwrap(),
            None => reply(404),
        },
        "PUT" => {
            if rel.is_empty() || !d.dirs.contains(&parent(&rel)) {
                return reply(409);
            }
            let existed = d.files.insert(rel, body.to_vec()).is_some();
            reply(if existed { 204 } else { 201 })
        }
        "MKCOL" => {
            if rel.is_empty() || d.dirs.contains(&rel) || d.files.contains_key(&rel) {
                return reply(405);
            }
            if d.forbid_top_level_mkcol && !rel.contains('/') {
                return reply(403);
            }
            if !d.dirs.contains(&parent(&rel)) {
                return reply(409);
            }
            d.dirs.insert(rel);
            reply(201)
        }
        "DELETE" => {
            if d.forbid_delete {
                return reply(500);
            }
            if d.files.remove(&rel).is_some() {
                return reply(204);
            }
            if d.dirs.contains(&rel) && !rel.is_empty() {
                if d.redirect_collection_delete && !raw_path.ends_with('/') {
                    return Response::builder()
                        .status(301)
                        .header(header::LOCATION, format!("{raw_path}/"))
                        .body(Body::empty())
                        .unwrap();
                }
                let prefix = format!("{rel}/");
                d.dirs.retain(|x| *x != rel && !x.starts_with(&prefix));
                d.files.retain(|f, _| !f.starts_with(&prefix));
                return reply(204);
            }
            reply(404)
        }
        _ => reply(405),
    }
}

/// 起假服务器，返回（共享状态，端点 URL）。
async fn spawn(mut dav: Dav) -> (Arc<Mutex<Dav>>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    dav.base_url = format!("http://{addr}");
    let url = format!("http://{addr}/dav/");
    let state = Arc::new(Mutex::new(dav));
    let app = Router::new().fallback(handle).with_state(state.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (state, url)
}

fn client_for(url: &str, root: &str) -> WebDavStorage {
    storage(url, root).unwrap()
}

#[tokio::test]
async fn contract_holds_against_a_jianguoyun_style_server() {
    // 坚果云：根目录下不许直接建文件夹，同步目录必须放进已有的同步文件夹。
    let mut dav = Dav::new(Flavor::Jianguoyun);
    dav.forbid_top_level_mkcol = true;
    dav.dirs.insert("我的坚果云".into());
    let (_state, url) = spawn(dav).await;
    contract_tests::run(&client_for(&url, "我的坚果云/marcel-sync")).await;
}

#[tokio::test]
async fn contract_holds_against_a_nextcloud_style_server() {
    let (_state, url) = spawn(Dav::new(Flavor::Nextcloud)).await;
    contract_tests::run(&client_for(&url, "marcel-sync")).await;
}

#[tokio::test]
async fn contract_holds_against_absolute_url_hrefs() {
    let (_state, url) = spawn(Dav::new(Flavor::AbsoluteUrls)).await;
    contract_tests::run(&client_for(&url, "a/b/marcel-sync")).await;
}

#[tokio::test]
async fn contract_holds_with_an_empty_root_directly_on_the_endpoint() {
    let (_state, url) = spawn(Dav::new(Flavor::Nextcloud)).await;
    contract_tests::run(&client_for(&url, "")).await;
}

#[tokio::test]
async fn steady_state_put_is_a_single_request() {
    let (state, url) = spawn(Dav::new(Flavor::Nextcloud)).await;
    let s = client_for(&url, "marcel-sync");
    s.put("devices/dev1/seg-1.msync", b"1").await.unwrap();
    // 第一次：目录都不在 → PUT 被拒（409）→ 逐级 MKCOL → 再 PUT
    assert_eq!(
        state.lock().log,
        vec![
            "PUT marcel-sync/devices/dev1/seg-1.msync",
            "MKCOL marcel-sync",
            "MKCOL marcel-sync/devices",
            "MKCOL marcel-sync/devices/dev1",
            "PUT marcel-sync/devices/dev1/seg-1.msync",
        ]
    );
    state.lock().log.clear();
    // 之后同目录写入：恰好一个请求（坚果云有频率限制，不能多发探测）
    s.put("devices/dev1/seg-2.msync", b"2").await.unwrap();
    assert_eq!(
        state.lock().log,
        vec!["PUT marcel-sync/devices/dev1/seg-2.msync"]
    );
}

#[tokio::test]
async fn a_stale_directory_cache_heals_itself() {
    let (state, url) = spawn(Dav::new(Flavor::Nextcloud)).await;
    let s = client_for(&url, "marcel-sync");
    s.put("devices/dev1/seg-1.msync", b"1").await.unwrap();
    // 有人（另一台设备 / 用户）在服务器上把整个同步目录删了
    {
        let mut d = state.lock();
        d.dirs.retain(|x| x.is_empty());
        d.files.clear();
    }
    s.put("devices/dev1/seg-2.msync", b"2").await.unwrap();
    assert_eq!(
        s.get("devices/dev1/seg-2.msync").await.unwrap(),
        Some(b"2".to_vec())
    );
}

#[tokio::test]
async fn collection_delete_that_redirects_is_retried_with_a_trailing_slash() {
    let mut dav = Dav::new(Flavor::Nextcloud);
    dav.redirect_collection_delete = true;
    let (state, url) = spawn(dav).await;
    let s = client_for(&url, "marcel-sync");
    s.put("devices/dev1/seg-1.msync", b"1").await.unwrap();
    state.lock().log.clear();
    s.delete("devices").await.unwrap();
    assert_eq!(
        state.lock().log,
        vec!["DELETE marcel-sync/devices", "DELETE marcel-sync/devices"],
        "第二次是带尾斜杠的重试"
    );
    assert!(s.list("devices").await.unwrap().is_empty());
}

#[tokio::test]
async fn wrong_password_is_an_auth_error_and_never_leaks_the_password() {
    let (_state, url) = spawn(Dav::new(Flavor::Nextcloud)).await;
    let s = WebDavStorage::with_client(&url, "alice", "WRONG-pw-123", "marcel-sync", test_client())
        .unwrap();
    for err in [
        s.probe().await.unwrap_err(),
        s.list("").await.unwrap_err(),
        s.get("x").await.unwrap_err(),
        s.put("x", b"1").await.unwrap_err(),
        s.delete("x").await.unwrap_err(),
    ] {
        assert!(matches!(err, StorageError::Auth(_)), "{err:?}");
        assert!(!err.to_string().contains("WRONG-pw-123"));
    }
}

#[tokio::test]
async fn missing_write_permission_surfaces_as_permission_error() {
    // 根目录不许建文件夹，而 root 又直接放在根下 → 403 → Permission
    let mut dav = Dav::new(Flavor::Jianguoyun);
    dav.forbid_top_level_mkcol = true;
    let (_state, url) = spawn(dav).await;
    let err = client_for(&url, "marcel-sync").probe().await.unwrap_err();
    assert!(matches!(err, StorageError::Permission(_)), "{err:?}");
}

#[tokio::test]
async fn probe_tolerates_a_server_that_refuses_delete() {
    // 「能写能读、偏偏删不掉」的位置（实测有：OpenList 在 MySQL 上删除接口回 500）不该挡住开启同步。
    let mut dav = Dav::new(Flavor::Nextcloud);
    dav.forbid_delete = true;
    let (_state, url) = spawn(dav).await;
    let s = client_for(&url, "marcel-sync");
    s.probe().await.expect("删不掉不该让自检失败");
    // 服务器不让删，探针文件就留在那儿；读写照常。
    s.put("devices/dev1/seg-1.msync", b"1").await.unwrap();
    assert_eq!(
        s.get("devices/dev1/seg-1.msync").await.unwrap(),
        Some(b"1".to_vec())
    );
    assert_eq!(s.list("devices").await.unwrap().len(), 1);
}

#[tokio::test]
async fn wrong_endpoint_gets_a_clear_message() {
    // 端点指到一个不存在的目录：MKCOL 报 409（上级不存在）
    let (_state, base) = spawn(Dav::new(Flavor::Nextcloud)).await;
    let url = format!("{base}nope/deeper/");
    let err = client_for(&url, "marcel-sync").probe().await.unwrap_err();
    assert!(
        err.to_string().contains("上级目录") || err.to_string().contains("找不到"),
        "{err}"
    );
}

#[tokio::test]
async fn a_non_webdav_address_is_diagnosed() {
    let mut dav = Dav::new(Flavor::Nextcloud);
    dav.html_for_propfind = true;
    let (_state, url) = spawn(dav).await;
    let s = client_for(&url, "");
    let err = s.list("").await.unwrap_err();
    assert!(err.to_string().contains("不是 WebDAV"), "{err}");
}

#[tokio::test]
async fn throttling_is_a_retryable_network_error() {
    let mut dav = Dav::new(Flavor::Nextcloud);
    dav.reject_after = Some(0);
    let (_state, url) = spawn(dav).await;
    let err = client_for(&url, "marcel-sync").get("a").await.unwrap_err();
    assert!(matches!(err, StorageError::Network(_)), "{err:?}");
}

#[tokio::test]
async fn unreachable_server_is_a_network_error_without_url_or_password() {
    // 绑一个端口再关掉，拿到一个肯定没人监听的地址
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let s = storage(&format!("http://127.0.0.1:{port}/dav/"), "x").unwrap();
    let err = s.list("").await.unwrap_err();
    assert!(matches!(err, StorageError::Network(_)), "{err:?}");
    let text = err.to_string();
    assert!(
        !text.contains("s3cret-pw") && !text.contains("/dav/"),
        "{text}"
    );
    assert!(text.contains(&format!("127.0.0.1:{port}")), "{text}");
}

#[tokio::test]
async fn paths_are_checked_before_any_request_is_sent() {
    let (state, url) = spawn(Dav::new(Flavor::Nextcloud)).await;
    let s = client_for(&url, "marcel-sync");
    assert!(s.get("../etc/passwd").await.is_err());
    assert!(s.put("a/../../b", b"x").await.is_err());
    assert!(s.delete("").await.is_err());
    assert!(state.lock().log.is_empty(), "{:?}", state.lock().log);
}
