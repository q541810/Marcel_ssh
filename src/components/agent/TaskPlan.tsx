interface TaskStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  details?: string;
}

interface Props {
  steps: TaskStep[];
  currentStepIndex: number;
}

export default function TaskPlan({ steps, currentStepIndex }: Props) {
  if (steps.length === 0) return null;

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-800/50 p-3">
      <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
        任务计划
      </h4>
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-start gap-2">
            {/* Step indicator */}
            <div className="mt-0.5 flex-shrink-0">
              {step.status === 'completed' ? (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-emerald-600 text-white text-xs">
                  &#10003;
                </span>
              ) : step.status === 'failed' ? (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-red-600 text-white text-xs">
                  &#10005;
                </span>
              ) : step.status === 'running' ? (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs animate-pulse">
                  {index + 1}
                </span>
              ) : (
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-zinc-700 text-zinc-400 text-xs">
                  {index + 1}
                </span>
              )}
            </div>

            {/* Step content */}
            <div className="flex-1 min-w-0">
              <p
                className={`text-sm ${
                  index === currentStepIndex
                    ? 'text-zinc-100 font-medium'
                    : step.status === 'completed'
                      ? 'text-zinc-400 line-through'
                      : step.status === 'failed'
                        ? 'text-red-400'
                        : 'text-zinc-400'
                }`}
              >
                {step.label}
              </p>
              {step.details && step.status === 'running' && (
                <p className="text-xs text-zinc-500 mt-0.5">{step.details}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
