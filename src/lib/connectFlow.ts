import { asHostKeyMismatch, parseAppError } from '@/lib/errors';
import { formatConnLabel } from '@/lib/privacy';
import {
  isPassphraseProblem,
  isPasswordRejected,
  keyNeedsPassphrase,
} from '@/lib/privateKey';
import * as tauri from '@/lib/tauri';
import { isDebugConnection } from '@/lib/debugServer';
import { secretSaveFailedMessage } from '@/lib/connectionFormModel';
import type {
  ConnectionConfig,
  HostKeyMismatchData,
  SavedConnection,
} from '@/lib/types';

/**
 * 连接发起的判定树（桌面 ConnectionList / 移动 MobileConnectionList 共用）。
 *
 * 两端从「点一条连接」到「连上 / 追问 / 报错」的分支完全同构：
 *
 * - Password → 密钥链里有存过的密码就拿它连，被服务器拒了（`rejected`）复问一次
 *   覆盖，别的失败原因照实说；没有存过就直接问；
 * - PrivateKey → 有存过的密钥密码就拿它连，真需要密码（`bad_passphrase` 等）才复问；
 *   没存过就先问密钥库（带密码的私钥不拿一次失败去试），再裸连一次兜底；
 * - 主机密钥不匹配 → 弹确认，确认后带 `trustNewHostKey` 重试。
 *
 * 平台差异**不进判定树**，全部用注入回调表达：
 * - 移动端连接前要断开其他会话、行内转圈（connectingId）、失败上红条；
 * - 桌面端只往 console 里分级写日志，红条只留给「还没开始连就走不下去」的情况。
 *
 * 判定树的时序是逐点核对过的（两端的 try/finally 与 return 位置），改这里之前
 * 先读 `ConnectionList.test.tsx` / `MobileConnectionList.test.tsx`——两端各有
 * 一套把这条树的关键行为钉住的测试。
 */

/** 失败发生在判定树的哪个出口。桌面按它选 console 口径；移动端只区分上不上红条。 */
export type ConnectFailureSite =
  /** doConnect 兜底（含密码/私钥重试路径） */
  | 'doConnect'
  /** 存过的密码连接失败（非主机密钥、非被拒） */
  | 'savedPassword'
  /** 存过的密码在「信任主机密钥」重试里失败 */
  | 'savedPasswordRetry'
  /** 存过的密钥密码连接失败（非主机密钥、非缺密码） */
  | 'savedPassphrase'
  /** 存过的密钥密码在「信任主机密钥」重试里失败 */
  | 'savedPassphraseRetry'
  /** 裸私钥直连失败（非主机密钥、非缺密码） */
  | 'keyConnect'
  /** 查询「有没有存过的密码」失败（不拦连接，退到追问） */
  | 'checkPassword'
  /** 查询「有没有存过的密钥密码」失败（同上） */
  | 'checkPassphrase';

export interface ConnectFlowDeps {
  connect: (config: ConnectionConfig) => Promise<string>;
  connectWithSavedPassword: (
    connectionId: string,
    connLabel: string,
    trustNewHostKey?: boolean,
  ) => Promise<string>;
  connectWithSavedPassphrase: (
    connectionId: string,
    connLabel: string,
    trustNewHostKey?: boolean,
  ) => Promise<string>;
  /** useConnectWithPassword 的 prompt（SSH 密码 / 私钥密码共用一个浮层）。 */
  promptPassword: (config: {
    title: string;
    description: string;
    onSubmit: (password: string) => void | Promise<void>;
  }) => void;
  /** useHostKeyMismatch 的 prompt。 */
  promptMismatch: (config: {
    data: HostKeyMismatchData;
    onTrust: () => void | Promise<void>;
  }) => void;
  /**
   * 连上后的记账（useSessionLifecycle().onConnected）。桌面同步调用、移动端
   * `void + .catch(() => {})`——这一差异由实现自己表达；`connId` 为空时跳过
   * （桌面各路径原有的 `if (connection.id)` 守卫收拢到这里）。
   */
  onSessionEstablished: (connId: string | undefined, sessionId: string) => void;
  /** 列表红条的 setState（两端同名）。 */
  setLocalError: (
    value: string | null | ((prev: string | null) => string | null),
  ) => void;
  /** 密码浮层文案的主机口径（隐私模式下 `***:****`）。 */
  privacyMode: boolean;
  /**
   * 一次连接尝试开始（try 块之前）。移动端：`setConnectingId(connId)`，
   * `clearLocalError` 为 true 时（doConnect 的重试路径）顺手清掉旧红条；
   * 桌面端：什么都不做。
   */
  beforeAttempt: (connId: string, opts: { clearLocalError: boolean }) => void;
  /** try 块内、真正连之前。移动端：`await clearOtherSessions()`；桌面端：无。 */
  beforeSessionConnect: () => Promise<void>;
  /** 连接尝试收尾（finally）。移动端：`setConnectingId(null)`；桌面端：无。 */
  afterAttempt: () => void;
  /** 错误出口。桌面按 site 分级写 console；移动端 check* 静默、其余上红条。 */
  reportFailure: (err: unknown, site: ConnectFailureSite) => void;
  /** 调试服务器（msfakeserver）。桌面/移动的收尾差异（如移动端要 onBack）在这里。 */
  onDebugConnect: (conn: SavedConnection) => void;
}

export function createConnectFlow(deps: ConnectFlowDeps) {
  const {
    connect,
    connectWithSavedPassword,
    connectWithSavedPassphrase,
    promptPassword,
    promptMismatch,
    onSessionEstablished,
    setLocalError,
    privacyMode,
    beforeAttempt,
    beforeSessionConnect,
    afterAttempt,
    reportFailure,
    onDebugConnect,
  } = deps;

  /**
   * 带明文凭据连一次（密码浮层提交后、主机密钥信任后的重试都走这里）。
   * 跳板机密钥由 Rust 侧在 connectionId 存在时自行从密钥链取。
   */
  const doConnect = async (
    conn: SavedConnection,
    password?: string,
    passphrase?: string,
    trust = false,
  ): Promise<void> => {
    let authMethod: ConnectionConfig['authMethod'];
    switch (conn.authMethod) {
      case 'Password':
        if (!password) {
          promptForPassword(conn);
          return;
        }
        authMethod = { type: 'Password', password };
        break;
      case 'PrivateKey':
        authMethod = {
          type: 'PrivateKey',
          keyId: conn.keyId,
          keyPath: conn.keyPath,
          passphrase,
        };
        break;
      default:
        // 历史数据里可能有已不再支持的取值（例如早期的 "Agent"）：
        // 说清楚是哪一条、该怎么修，而不是发一个后端必然拒绝的请求
        setLocalError(
          `「${conn.name}」保存的认证方式（${conn.authMethod}）已不再支持，请编辑这条连接、重新选择认证方式`,
        );
        return;
    }
    const config: ConnectionConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      authMethod,
      connectionId: conn.id,
      trustNewHostKey: trust,
    };
    beforeAttempt(conn.id, { clearLocalError: true });
    try {
      await beforeSessionConnect();
      const sessionId = await connect(config);
      onSessionEstablished(config.connectionId, sessionId);
    } catch (err) {
      if (!trust) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          promptMismatch({
            data: m,
            onTrust: () => {
              void doConnect(conn, password, passphrase, true);
            },
          });
          return;
        }
      }
      reportFailure(err, 'doConnect');
    } finally {
      afterAttempt();
    }
  };

  /**
   * 追问 SSH 密码。`rejectedSaved` = 密钥链里存着的那份已经**被服务器拒了**，
   * 这一问是"换一份"而不是"缺一份"——文案要说出来，否则浮层凭空弹出，用户会以为
   * 自己从没存过密码。
   */
  const promptForPassword = (conn: SavedConnection, rejectedSaved = false) => {
    promptPassword({
      title: 'SSH 密码',
      description:
        `连接到 ${formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}。密码会加密保存在本设备，下次自动使用。` +
        (rejectedSaved ? '上次保存的密码被服务器拒绝，请输入新的。' : ''),
      onSubmit: async (password) => {
        // 一律保存（没有"不记住"这个选项）：没存下来的密码会一路带来两个坏结果——
        // 每次连接都要重新输，以及标签上的「重连」只会报"重连需要密码"。
        // 保存失败不拦连接：密钥链不可用时照样把这次连接连上。
        // 覆盖旧的也是同一条路：复问一次就把打错的那份顶掉。
        let saveWarning: string | null = null;
        try {
          await tauri.savePassword(conn.id, password);
        } catch (err) {
          console.warn('保存密码到密钥链失败:', err);
          saveWarning = secretSaveFailedMessage('密码', err, 'connect');
        }
        await doConnect(conn, password);
        // 放在连接之后：连接自己也可能往这条错误带上写字（移动端列表就是），
        // 只有它没留下更该看的信息时才把"没记住"顶上来。
        if (saveWarning) setLocalError((prev) => prev ?? saveWarning);
      },
    });
  };

  const promptForPassphrase = (conn: SavedConnection) => {
    promptPassword({
      title: '私钥密码',
      description: `连接到 ${formatConnLabel(conn.username, conn.host, conn.port, privacyMode)}。密钥密码会加密保存在本设备，下次自动使用。`,
      onSubmit: async (passphrase) => {
        let saveWarning: string | null = null;
        try {
          await tauri.savePassphrase(conn.id, passphrase);
        } catch (err) {
          console.warn('保存 passphrase 到密钥链失败:', err);
          saveWarning = secretSaveFailedMessage('密钥密码', err, 'connect');
        }
        await doConnect(conn, undefined, passphrase);
        if (saveWarning) setLocalError((prev) => prev ?? saveWarning);
      },
    });
  };

  /**
   * Click handler for a saved connection. For password-auth connections,
   * checks if a password is saved in the OS keychain. If so, connects via
   * a Rust-side command that reads the password from the keychain without
   * exposing it to the WebView. Otherwise prompts the user.
   */
  const handleConnect = async (connection: SavedConnection) => {
    setLocalError(null);
    if (isDebugConnection(connection.id)) {
      onDebugConnect(connection);
      return;
    }
    if (connection.authMethod === 'Password') {
      try {
        const stored = await tauri.hasPassword(connection.id);
        if (stored) {
          const connLabel = formatConnLabel(
            connection.username,
            connection.host,
            connection.port,
            privacyMode,
          );
          beforeAttempt(connection.id, { clearLocalError: false });
          try {
            await beforeSessionConnect();
            const sessionId = await connectWithSavedPassword(
              connection.id,
              connLabel,
            );
            onSessionEstablished(connection.id, sessionId);
            return;
          } catch (err) {
            const m = asHostKeyMismatch(parseAppError(err));
            if (m) {
              promptMismatch({
                data: m,
                onTrust: async () => {
                  beforeAttempt(connection.id, { clearLocalError: false });
                  try {
                    await beforeSessionConnect();
                    const sid = await connectWithSavedPassword(
                      connection.id,
                      connLabel,
                      true,
                    );
                    onSessionEstablished(connection.id, sid);
                  } catch (e) {
                    reportFailure(e, 'savedPasswordRetry');
                  } finally {
                    afterAttempt();
                  }
                },
              });
              return;
            }
            // 存的那份密码被服务器拒了：追问并覆盖它。不复问的话，这份打错一个字符的
            // 密码会被每次连接和每次「重连」一直重放，用户再也等不到输入框（与私钥
            // 分支的复问对称）。其他原因（网络不通、主机密钥变更）照实报告。
            if (isPasswordRejected(err)) {
              promptForPassword(connection, true);
              return;
            }
            reportFailure(err, 'savedPassword');
            return;
          } finally {
            afterAttempt();
          }
        }
      } catch (err) {
        reportFailure(err, 'checkPassword');
      }
      promptForPassword(connection);
      return;
    }
    if (connection.authMethod === 'PrivateKey') {
      // 桌面分支入口原有的一次 setLocalError(null)：顶部清过之后到这里之间没有
      // 任何写入，属于冗余保守动作，保留它以维持两端逐行为等价（移动端此时本就是
      // null，再设一次是无观察差异的 no-op）。
      setLocalError(null);
      const hasSavedPassphrase = await tauri
        .hasPassphrase(connection.id)
        .catch((err) => {
          reportFailure(err, 'checkPassphrase');
          return false;
        });

      if (hasSavedPassphrase) {
        const connLabel = formatConnLabel(
          connection.username,
          connection.host,
          connection.port,
          privacyMode,
        );
        beforeAttempt(connection.id, { clearLocalError: false });
        try {
          await beforeSessionConnect();
          const sessionId = await connectWithSavedPassphrase(
            connection.id,
            connLabel,
          );
          onSessionEstablished(connection.id, sessionId);
          return;
        } catch (err) {
          const m = asHostKeyMismatch(parseAppError(err));
          if (m) {
            promptMismatch({
              data: m,
              onTrust: async () => {
                beforeAttempt(connection.id, { clearLocalError: false });
                try {
                  await beforeSessionConnect();
                  const sid = await connectWithSavedPassphrase(
                    connection.id,
                    connLabel,
                    true,
                  );
                  onSessionEstablished(connection.id, sid);
                } catch (e) {
                  reportFailure(e, 'savedPassphraseRetry');
                } finally {
                  afterAttempt();
                }
              },
            });
            return;
          }
          // 真需要密码（保存的那把已经不对了）才追问；别的原因就说别的
          if (isPassphraseProblem(err)) {
            promptForPassphrase(connection);
            return;
          }
          reportFailure(err, 'savedPassphrase');
          return;
        } finally {
          afterAttempt();
        }
      }

      // 密钥库里的私钥是带密码的、而本地没存：直接问，不拿一次失败去试
      if (await keyNeedsPassphrase(connection)) {
        promptForPassphrase(connection);
        return;
      }

      beforeAttempt(connection.id, { clearLocalError: false });
      try {
        await beforeSessionConnect();
        const config: ConnectionConfig = {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: {
            type: 'PrivateKey',
            keyId: connection.keyId,
            keyPath: connection.keyPath,
          },
          connectionId: connection.id,
        };
        const sessionId = await connect(config);
        onSessionEstablished(connection.id, sessionId);
        return;
      } catch (err) {
        const m = asHostKeyMismatch(parseAppError(err));
        if (m) {
          promptMismatch({
            data: m,
            onTrust: () => {
              void doConnect(connection, undefined, undefined, true);
            },
          });
          return;
        }
        // 这一次尝试不是白费的：后端明确告诉我们原因，只有"缺密码 / 密码错"
        // 才继续追问，其他原因（文件没了、格式不认、服务器拒绝）照实报告
        if (isPassphraseProblem(err)) {
          promptForPassphrase(connection);
          return;
        }
        reportFailure(err, 'keyConnect');
      } finally {
        afterAttempt();
      }
      return;
    }
    await doConnect(connection);
  };

  return { handleConnect, doConnect };
}
