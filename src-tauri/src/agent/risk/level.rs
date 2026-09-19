use serde::{Deserialize, Serialize};

/// Risk level for agent operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RiskLevel {
    ReadOnly,
    LowRisk,
    Moderate,
    HighRisk,
    Destructive,
}
