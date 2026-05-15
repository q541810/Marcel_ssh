export function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-8 scroll-mt-8">
      <h2 className="text-base font-semibold text-zinc-100 mb-1">{title}</h2>
      {description && (
        <p className="text-xs text-zinc-500 mb-3">{description}</p>
      )}
      <div className="space-y-3 mt-3">{children}</div>
    </section>
  );
}

export function Field({
  label,
  children,
  alignTop,
}: {
  label: string;
  children: React.ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div
      className={`flex gap-4 ${alignTop ? 'items-start' : 'items-center'}`}
    >
      <label
        className={`w-32 flex-shrink-0 text-sm text-zinc-300 ${
          alignTop ? 'pt-1.5' : ''
        }`}
      >
        {label}
      </label>
      <div className="flex-1 flex items-center gap-2 min-w-0">{children}</div>
    </div>
  );
}
