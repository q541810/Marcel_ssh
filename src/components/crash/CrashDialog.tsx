import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import Button from '@/components/ui/Button';
import {
  crashGetReport,
  crashExportReport,
  crashRepairConfig,
  crashListBackups,
  crashRestoreBackup,
  crashDismiss,
  crashMarkResolved,
  type CrashReport,
  type ConfigBackup,
} from '@/lib/tauri';

interface Props {
  onDismiss: () => void;
}

export default function CrashDialog({ onDismiss }: Props) {
  const [report, setReport] = useState<CrashReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState<string | null>(null);
  const [backups, setBackups] = useState<Record<string, ConfigBackup[]>>({});
  const [showBackups, setShowBackups] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    loadReport();
  }, []);

  const loadReport = async () => {
    try {
      const crashReport = await crashGetReport();
      setReport(crashReport);
      
      if (crashReport) {
        const backupData: Record<string, ConfigBackup[]> = {};
        for (const config of crashReport.configStatus) {
          if (!config.isValid && config.exists) {
            try {
              const configBackups = await crashListBackups(config.path);
              backupData[config.path] = configBackups;
            } catch (e) {
              console.error('Failed to load backups for', config.path, e);
            }
          }
        }
        setBackups(backupData);
      }
    } catch (e) {
      console.error('Failed to load crash report:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleRepair = async (fileName: string) => {
    setRepairing(fileName);
    try {
      await crashRepairConfig(fileName);
      await loadReport();
    } catch (e) {
      console.error('Failed to repair config:', e);
      alert(`修复失败: ${e}`);
    } finally {
      setRepairing(null);
    }
  };

  const handleRestoreBackup = async (backupPath: string) => {
    try {
      await crashRestoreBackup(backupPath);
      await loadReport();
      setShowBackups(null);
    } catch (e) {
      console.error('Failed to restore backup:', e);
      alert(`恢复备份失败: ${e}`);
    }
  };

  const handleExportReport = async () => {
    setExporting(true);
    try {
      const savePath = await open({
        defaultPath: `crash-report-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      
      if (savePath) {
        await crashExportReport(savePath as string);
        alert(`崩溃报告已导出到: ${savePath}`);
      }
    } catch (e) {
      console.error('Failed to export report:', e);
      alert(`导出失败: ${e}`);
    } finally {
      setExporting(false);
    }
  };

  const handleDismiss = async () => {
    try {
      await crashDismiss();
    } catch (e) {
      console.error('Failed to dismiss crash:', e);
    }
    onDismiss();
  };

  const handleContinue = async () => {
    try {
      await crashMarkResolved();
    } catch (e) {
      console.error('Failed to mark resolved:', e);
    }
    onDismiss();
  };

  const getCrashTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      config_corrupted: '配置文件损坏',
      startup_failure: '启动失败',
      runtime_panic: '运行时错误',
      database_error: '数据库错误',
      unknown: '未知错误',
    };
    return labels[type] || type;
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-400">正在检测崩溃状态...</p>
        </div>
      </div>
    );
  }

  if (!report) {
    return null;
  }

  const corruptedConfigs = report.configStatus.filter(c => !c.isValid && c.exists);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/95 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-zinc-700 bg-red-900/20">
          <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
            <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">程序异常退出</h2>
            <p className="text-sm text-zinc-400">
              检测到上次程序未正常关闭 · {getCrashTypeLabel(report.crashType)}
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Error Message */}
          <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-300 mb-2">错误信息</h3>
            <p className="text-sm text-red-400 font-mono">{report.errorMessage}</p>
          </div>

          {/* Config Status */}
          {corruptedConfigs.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-zinc-300">损坏的配置文件</h3>
              {corruptedConfigs.map(config => (
                <div key={config.path} className="p-4 rounded-lg bg-zinc-900/50 border border-red-500/30">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-zinc-200">{config.path}</span>
                        <span className="px-1.5 py-0.5 text-xs rounded bg-red-500/20 text-red-400">损坏</span>
                      </div>
                      {config.errorMessage && (
                        <p className="text-xs text-red-400 font-mono">{config.errorMessage}</p>
                      )}
                      {config.fileSize && (
                        <p className="text-xs text-zinc-500 mt-1">
                          大小: {formatBytes(config.fileSize)} · 
                          修改: {config.lastModified ? new Date(config.lastModified).toLocaleString() : '未知'}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {backups[config.path] && backups[config.path].length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowBackups(showBackups === config.path ? null : config.path)}
                        >
                          恢复备份 ({backups[config.path].length})
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={repairing === config.path}
                        onClick={() => handleRepair(config.path)}
                      >
                        重置为默认
                      </Button>
                    </div>
                  </div>
                  
                  {/* Backup List */}
                  {showBackups === config.path && backups[config.path] && (
                    <div className="mt-3 pt-3 border-t border-zinc-700 space-y-2">
                      <p className="text-xs text-zinc-400 mb-2">选择一个备份恢复：</p>
                      {backups[config.path].map(backup => (
                        <div key={backup.backupPath} className="flex items-center justify-between p-2 rounded bg-zinc-800">
                          <div className="text-xs">
                            <p className="text-zinc-300">{new Date(backup.createdAt).toLocaleString()}</p>
                            <p className="text-zinc-500">{formatBytes(backup.size)}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRestoreBackup(backup.backupPath)}
                          >
                            恢复
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* System Info */}
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium text-zinc-300 hover:text-zinc-100">
              <span className="group-open:hidden">▶ 显示系统信息</span>
              <span className="hidden group-open:inline">▼ 隐藏系统信息</span>
            </summary>
            <div className="mt-3 p-4 rounded-lg bg-zinc-900/50 border border-zinc-700">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-zinc-500">操作系统:</span>
                  <span className="ml-2 text-zinc-300">{report.systemInfo.osName} {report.systemInfo.osVersion}</span>
                </div>
                <div>
                  <span className="text-zinc-500">架构:</span>
                  <span className="ml-2 text-zinc-300">{report.systemInfo.arch}</span>
                </div>
                <div>
                  <span className="text-zinc-500">应用版本:</span>
                  <span className="ml-2 text-zinc-300">{report.systemInfo.appVersion}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Rust版本:</span>
                  <span className="ml-2 text-zinc-300">{report.systemInfo.rustVersion}</span>
                </div>
              </div>
            </div>
          </details>

          {/* Recent Logs */}
          {report.recentLogs.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-zinc-300 hover:text-zinc-100">
                <span className="group-open:hidden">▶ 显示最近日志</span>
                <span className="hidden group-open:inline">▼ 隐藏最近日志</span>
              </summary>
              <div className="mt-3 p-4 rounded-lg bg-zinc-900/50 border border-zinc-700 max-h-48 overflow-y-auto">
                <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap">
                  {report.recentLogs.join('\n')}
                </pre>
              </div>
            </details>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-zinc-700 bg-zinc-900/50">
          <Button
            variant="ghost"
            size="sm"
            loading={exporting}
            onClick={handleExportReport}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            导出崩溃报告
          </Button>
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={handleDismiss}>
              忽略并关闭
            </Button>
            <Button variant="primary" onClick={handleContinue}>
              继续使用
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
