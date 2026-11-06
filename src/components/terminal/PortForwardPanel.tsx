import PortForwardView from './PortForwardView';

interface PortForwardPanelProps {
  sessionId: string;
}

/** 桌面底栏“端口转发”标签。视图本体与手机 Sheet 共用 `PortForwardView`。 */
export default function PortForwardPanel({ sessionId }: PortForwardPanelProps) {
  return <PortForwardView key={sessionId} sessionId={sessionId} />;
}
