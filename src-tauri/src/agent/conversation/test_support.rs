// 测试共享夹具（仅测试编译）：内存库与两个常用的会话种子。
use super::ConversationDb;
use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;

pub(super) fn create_test_db() -> ConversationDb {
    ConversationDb::in_memory().expect("Failed to create in-memory database")
}

/// 造一个"被压缩过一次"的会话，返回 (db, conversation_id, 归档原文 id 列表, 卡片 id, 活跃 id 列表)。
///
/// 结构（行序）：u1 a1 t1 [卡片] u2 a2 —— 与 `load_active_messages` 的
/// "卡片之前 = 归档、卡片及之后 = 当前上下文"完全对齐。
pub(super) fn seed_compacted_conversation(
    db: &ConversationDb,
) -> (String, Vec<String>, String, Vec<String>) {
    let conv = db.create_conversation("conn_1", "history").expect("conv");
    let mut archived = Vec::new();
    for (i, (role, content)) in [
        ("user", "部署前的原始需求：把 nginx 换成 caddy"),
        ("assistant", "明白，先做只读检查"),
        ("tool", "systemctl status nginx 的输出：inactive (dead)"),
    ]
    .iter()
    .enumerate()
    {
        let m = db
            .save_message(
                &conv.id,
                role,
                content,
                &format!("2026-01-01T00:0{i}:00Z"),
                None,
                None,
            )
            .expect("archived msg");
        archived.push(m.id);
    }

    // 走真实的压缩落库入口建卡。`card_created_at` 必须取**被压末行的
    // created_at**（persister 就是这么写的）：卡片靠它排在被压区间紧后面，
    // 行序乱了归档边界就跟着错。
    let rows = db.load_messages(&conv.id).expect("load before card");
    let tail = rows.last().expect("tail row");
    db.commit_compaction(
        &conv.id,
        &[],
        &format!(
            "{COMPACTION_CARD_PREFIX}已整理 3 条历史消息（约 120 tokens）\n\n原始需求是把 nginx 换成 caddy。"
        ),
        &tail.created_at.to_rfc3339(),
        &tail.timestamp,
    )
    .expect("commit card");
    let card_id = db
        .load_messages(&conv.id)
        .expect("load after card")
        .into_iter()
        .find(|m| m.content.starts_with(COMPACTION_CARD_PREFIX))
        .expect("card row")
        .id;

    let mut active = Vec::new();
    for (i, (role, content)) in [
        ("user", "现在看一下 caddy 的配置"),
        ("assistant", "配置如下……"),
    ]
    .iter()
    .enumerate()
    {
        let m = db
            .save_message(
                &conv.id,
                role,
                content,
                &format!("2026-01-01T00:1{i}:00Z"),
                None,
                None,
            )
            .expect("active msg");
        active.push(m.id);
    }

    (conv.id, archived, card_id, active)
}

/// 造一个"窗口为空"的场景，返回 (会话 id, 派发锚 = 冻结上界, 之后压出来的卡 id)。
///
/// 路径：落若干行 → 冻结"派发那一刻"= 当时最后一条 → 父会话**在派发之后**压缩。
/// 手动压缩（`tail_db_id = None`）取**队尾行**当卡片时间 ⇒ 卡片排到队尾紧后面，
/// 也就排到冻结上界之后 ⇒ 窗口 `[最新卡, 派发锚]` 成为空区间。
pub(super) fn seed_empty_window_conversation(db: &ConversationDb) -> (String, String, String) {
    let conv = db
        .create_conversation("conn_1", "empty-window")
        .expect("conv");
    for (i, (role, content)) in [
        ("user", "把 nginx 换成 caddy"),
        ("assistant", "先做只读检查"),
        ("tool", "inactive (dead)"),
    ]
    .iter()
    .enumerate()
    {
        db.save_message(
            &conv.id,
            role,
            content,
            &format!("2026-01-01T00:0{i}:00Z"),
            None,
            None,
        )
        .expect("msg");
    }
    let dispatch_anchor = db
        .load_messages(&conv.id)
        .expect("load")
        .last()
        .expect("tail")
        .id
        .clone();

    let rows = db.load_messages(&conv.id).expect("load");
    let tail = rows.last().expect("tail row");
    db.commit_compaction(
        &conv.id,
        &[],
        "【上下文已压缩】派发之后又压了一次",
        &tail.created_at.to_rfc3339(),
        &tail.timestamp,
    )
    .expect("commit");
    let card_id = db
        .load_messages(&conv.id)
        .expect("load")
        .into_iter()
        .find(|m| m.content.starts_with(COMPACTION_CARD_PREFIX))
        .expect("card")
        .id;

    (conv.id, dispatch_anchor, card_id)
}
