export default function TransferQueue() {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-zinc-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-zinc-300 mb-2">
        传输队列
      </h3>
      <p className="text-sm text-zinc-500">
        即将推出 &mdash; 查看和管理文件传输进度。
      </p>
    </div>
  );
}
